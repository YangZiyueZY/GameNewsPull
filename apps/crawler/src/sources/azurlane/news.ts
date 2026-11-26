// 碧蓝航线官方公告适配器（契约 q8：只用日服 / 国际服官方 JSON）。
// 两个独立适配器：
//   · azurlane-jp（L0）：https://azurlane.jp/api/news/list?index=1&size=60
//       在 type=3（维护公告）正文里找「期間限定建造」段落，取
//       「開催期間：11月24日(火)メンテナンス後～12月10日(木)メンテナンスまで」，
//       并用同篇公告的「■実施時間 11月24日(火)14:00 ～ 11月24日(火)20:00」（JST）换算成绝对时间；
//       舰名取「モロトフ」这类 SSR「名」条目（原文是 SSR 单独一行 + 「名」2% 的版式，两种都认）。
//   · azurlane-en（L0）：https://azurlane.yo-star.com/news/wp-json/wp/v2/posts
//       解析 "Molotov (Rate up in event construction pool)" 与 "between 11/24 – 12/9, 11:59 P.M. (UTC-7)"。
// 约束：时间一律输出东八区 ISO（+08:00）；判定不出就 null；网络失败返回 [] 并打日志，绝不编造。
import { fetchJson, stripHtml, withSourceCache } from '../http.ts';
import type { PoolCandidate, SourceAdapter, SourceContext } from '../../pools/types.ts';

const CST_OFFSET_MS = 8 * 3_600_000;

/** epoch ms → 东八区 ISO（+08:00） */
function cstIso(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/** 按给定时区（默认 +8）钟面时间构造东八区 ISO；日服 +9、UTC-7 传对应偏移 */
function cstFromParts(y: number, mo: number, d: number, h = 0, mi = 0, offsetHours = 8): string {
  return cstIso(Date.UTC(y, mo - 1, d, h, mi) - offsetHours * 3_600_000);
}

/** 取某个时刻在东八区的年、月（用于给无年份日期补年） */
function cstYearMonth(epochMs: number): { y: number; mo: number } {
  const s = cstIso(epochMs);
  return { y: Number(s.slice(0, 4)), mo: Number(s.slice(5, 7)) };
}

/** 无年份日期补年：月份小于参照月视为跨年 */
function pickYear(month: number, ref: { y: number; mo: number }): number {
  return month < ref.mo ? ref.y + 1 : ref.y;
}

function toLines(html: string): string[] {
  return stripHtml(html)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ————————————————————————— 日服 —————————————————————————

export interface JpNewsRow {
  id?: number | string;
  title?: string;
  content?: string;
  type?: number | string;
  publishTime?: number;
}

export interface JpNewsResponse {
  meta?: unknown;
  data?: { rows?: JpNewsRow[]; count?: number };
}

const JP_CACHE_ID = 'azurlane-jp';
const JP_URL = 'https://azurlane.jp/api/news/list?index=1&size=60';
/** 日服维护公告的 type */
const JP_MAINTENANCE_TYPE = 3;
/** 一条维护公告最多解析的舰名数 */
const JP_MAX_SHIPS = 8;

/** 維護時間（実施時間）窗口：11月24日(火)14:00 ～ 11月24日(火)20:00（JST） */
export function parseJpMaintenanceWindow(text: string): { day: number; month: number; startH: number; startM: number; endH: number; endM: number } | null {
  const m = text.match(
    /実施時間[^\n]*\n?\s*(\d{1,2})月(\d{1,2})日[^0-9]{0,10}(\d{1,2}):(\d{2})\s*[～~]\s*(?:(\d{1,2})月(\d{1,2})日)?[^0-9]{0,10}(\d{1,2}):(\d{2})/,
  );
  if (!m) return null;
  const day = +(m[6] ?? m[2]);
  return { day: day, month: +(m[5] ?? m[1]), startH: +m[3], startM: +m[4], endH: +m[7], endM: +m[8] };
}

/** 開催期間 右端：显式时刻（12月9日(水)23:59まで）或「メンテナンスまで」 */
export function parseJpRangeEnd(
  raw: string,
  maint: ReturnType<typeof parseJpMaintenanceWindow>,
  ref: { y: number; mo: number },
): string | null {
  const explicit = raw.match(/(\d{1,2})月(\d{1,2})日[^0-9]{0,12}(\d{1,2}):(\d{2})/);
  if (explicit) {
    const mo = +explicit[1];
    return cstFromParts(pickYear(mo, ref), mo, +explicit[2], +explicit[3], +explicit[4], 9);
  }
  const untilMaint = raw.match(/(\d{1,2})月(\d{1,2})日[^0-9]{0,12}メンテナンスまで/);
  if (untilMaint && maint) {
    // 结束 = 该日维护开始时刻（沿用同篇公告给出的维护开始时刻）
    const mo = +untilMaint[1];
    return cstFromParts(pickYear(mo, ref), mo, +untilMaint[2], maint.startH, maint.startM, 9);
  }
  return null;
}

/** 解析一条日服维护公告里的「期間限定建造」段落 */
export function parseJpMaintenanceRow(row: JpNewsRow): PoolCandidate | null {
  const content = String(row.content ?? '');
  if (!content) return null;
  if (content.indexOf('期間限定建造') < 0) return null;
  const lines = toLines(content);
  const plain = lines.join('\n');
  const publishMs = Number(row.publishTime ?? 0);
  const ref = cstYearMonth(Number.isFinite(publishMs) && publishMs > 0 ? publishMs : Date.now());
  const maint = parseJpMaintenanceWindow(plain);

  // 定位「期間限定建造」段落：从「・「期間限定建造」を追加」开始，到下一个段落头结束
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('期間限定建造') >= 0 && lines[i].indexOf('追加') >= 0) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('期間限定建造') >= 0) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) return null;

  const section: string[] = [];
  for (let i = startIdx; i < lines.length && section.length < 40; i++) {
    const line = lines[i];
    if (i > startIdx && /^(・|【|■)/.test(line)) break;
    if (i > startIdx && line.indexOf('※その他、期間限定建造') === 0) break;
    section.push(line);
  }

  const rangeLine = section.find((l) => /開催期間/.test(l)) ?? '';
  const rangeText = rangeLine.replace(/^.*開催期間[：:]\s*/, '');

  // 舰名：SSR 单独一行 + 「名」… 的版式，以及 SSR「名」 的行内版式
  const characters: string[] = [];
  let currentRarity = '';
  for (const line of section) {
    const standalone = line.match(/^(SSR|SR|R)$/);
    if (standalone) {
      currentRarity = standalone[1];
      continue;
    }
    const inline = line.match(/(SSR|SR|R)\s*「([^」]{1,20})」/);
    if (inline) {
      if (characters.indexOf(inline[2]) < 0) characters.push(inline[2]);
      continue;
    }
    if (currentRarity && /^「([^」]{1,20})」/.test(line)) {
      const name = line.match(/^「([^」]{1,20})」/)?.[1] ?? '';
      if (name && characters.indexOf(name) < 0) characters.push(name);
    }
  }

  const startPair = rangeText.split(/[～~]/);
  const startSide = startPair[0] ?? '';
  const endSide = startPair.slice(1).join('～') || rangeText;
  // 起点「メンテナンス後」= 同篇公告给出的维护结束时刻（JST → +08:00）
  const startAbs = maint && /メンテナンス後/.test(startSide)
    ? cstFromParts(pickYear(maint.month, ref), maint.month, maint.day, maint.endH, maint.endM, 9)
    : null;
  const end = parseJpRangeEnd(endSide, maint, ref);

  const noteParts = ['server=JP', 'id=' + String(row.id ?? '?')];
  if (rangeText) noteParts.push('開催期間 ' + rangeText);
  if (maint) noteParts.push('维护 ' + maint.month + '月' + maint.day + '日 ' + maint.startH + ':' + String(maint.startM).padStart(2, '0') + '～' + maint.endH + ':' + String(maint.endM).padStart(2, '0') + ' JST');
  if (/メンテナンスまで/.test(endSide) && end) noteParts.push('结束取该日维护开始时刻');
  if (!startAbs) noteParts.push('start_at 无法定位');

  return {
    game_key: 'azurlane',
    pool_name: '期間限定建造',
    pool_type: /復刻/.test(section.join('\n')) ? 'rerun_character' : 'limited_character',
    characters: characters.slice(0, JP_MAX_SHIPS),
    start_at: startAbs,
    end_at: end,
    version: null,
    period: null,
    evidence: (rangeText || String(row.title ?? '')).slice(0, 200),
    note: noteParts.join('；'),
    source: {
      id: JP_CACHE_ID,
      tier: 'L0',
      url: JP_URL,
      fetched_at: null,
    },
  };
}

export async function collectAzurLaneJp(ctx: SourceContext): Promise<PoolCandidate[]> {
  const resp = await withSourceCache<JpNewsResponse>(ctx, JP_CACHE_ID, () => fetchJson<JpNewsResponse>(JP_URL));
  const rows = resp?.data?.rows;
  if (!Array.isArray(rows)) {
    ctx.log('[source:azurlane-jp] 公告列表不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const picked = rows
    .filter((r) => Number(r.type) === JP_MAINTENANCE_TYPE && String(r.content ?? '').indexOf('期間限定建造') >= 0)
    .sort((a, b) => Number(b.publishTime ?? 0) - Number(a.publishTime ?? 0))
    .slice(0, 3);
  const out: PoolCandidate[] = [];
  for (const row of picked) {
    const cand = parseJpMaintenanceRow(row);
    if (!cand) continue;
    // 只解析出段落但取不到舰名 → 视为失败（不产出空池）
    if (cand.characters.length === 0) {
      ctx.log('[source:azurlane-jp] 公告 ' + String(row.id ?? '?') + ' 的期間限定建造段落未取到舰名，跳过');
      continue;
    }
    // 已在 end_at 之前结束的旧池不再产出（避免把历史池当当期）
    if (cand.end_at && Date.parse(cand.end_at) < ctx.now - 86_400_000) continue;
    out.push(cand);
  }
  if (out.length === 0) ctx.log('[source:azurlane-jp] 未解析出期間限定建造卡池');
  return out;
}

// ————————————————————————— 国际服 —————————————————————————

export interface EnPost {
  id?: number | string;
  date?: string;
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
}

const EN_CACHE_ID = 'azurlane-en';
// 注意：excerpt 只是开头几十个词的摘要，「Rate up in event construction pool」在正文里，
// 因此 _fields 在契约给的基础上补了 content（同一端点，多取一个字段）。
const EN_URL =
  'https://azurlane.yo-star.com/news/wp-json/wp/v2/posts?per_page=50' +
  '&_fields=id,date,link,title,excerpt,content';

/** 12/9, 11:59 P.M. 这类美式日期 → {month, day, hour24, minute} */
function parseUsDate(text: string): { mo: number; d: number; h: number; mi: number } | null {
  const m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:,\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?)?/i);
  if (!m) return null;
  let h = m[4] ? +m[4] : 0;
  const ap = (m[6] ?? '').toUpperCase();
  if (ap === 'P' && h < 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  return { mo: +m[1], d: +m[2], h: h, mi: m[5] ? +m[5] : 0 };
}

/** 公告正文里的维护开始：maintenance on 11/24, 12:00 A.M. (UTC-7) for approximately 8 hours */
function parseEnMaintenance(text: string): { mo: number; d: number; h: number; mi: number; hours: number } | null {
  const m = text.match(/maintenance on\s*(\d{1,2})\/(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?.*?(\d+)\s*hours/i);
  if (!m) return null;
  let h = +m[3];
  const ap = m[5].toUpperCase();
  if (ap === 'P' && h < 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  return { mo: +m[1], d: +m[2], h: h, mi: +m[4], hours: +m[6] };
}

/** 解析一篇国际服公告：按「between A – B」区间 + 其后的 Rate up 舰名分组 */
export function parseEnPost(post: EnPost): PoolCandidate[] {
  // WordPress 正文里的区间用的是 &#8211; / &ndash;，stripHtml 不会解码，先统一成半角连字符
  const html = String(post.content?.rendered ?? post.excerpt?.rendered ?? '')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&nbsp;/g, ' ');
  if (!html) return [];
  const lines = toLines(html);
  const plain = lines.join('\n');
  if (plain.toLowerCase().indexOf('rate up in event construction pool') < 0) return [];

  const postDate = String(post.date ?? '');
  const ref = { y: Number(postDate.slice(0, 4)) || 1970, mo: Number(postDate.slice(5, 7)) || 1 };
  const maint = parseEnMaintenance(plain);

  interface Group {
    rangeRaw: string;
    startMo: number;
    startD: number;
    endMo: number;
    endD: number;
    endH: number;
    endMi: number;
    ships: string[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let currentAvailability = '';

  for (const line of lines) {
    const avail = line.match(/between\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*[–-]\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:,\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?)?/i);
    if (avail) {
      currentAvailability = line.trim();
      current = null; // 新区间，等下一次 Rate up 出现时再建组
      continue;
    }
    const rateUp = line.match(/^(.+?)\s*\((?:Rate up in event construction pool)\)/i);
    if (rateUp) {
      const ship = rateUp[1].trim();
      if (!current) {
        const first = currentAvailability.match(/between\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*[–-]\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:,\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?)?/i);
        if (!first) continue;
        let endH = first[7] ? +first[7] : 23;
        const ap = (first[9] ?? 'P').toUpperCase();
        if (ap === 'P' && endH < 12) endH += 12;
        if (ap === 'A' && endH === 12) endH = 0;
        current = {
          rangeRaw: currentAvailability,
          startMo: +first[1],
          startD: +first[2],
          endMo: +first[4],
          endD: +first[5],
          endH: endH,
          endMi: first[8] ? +first[8] : 0,
          ships: [],
        };
        groups.push(current);
      }
      if (ship && current.ships.indexOf(ship) < 0) current.ships.push(ship);
    }
  }

  const out: PoolCandidate[] = [];
  for (const g of groups) {
    // 区间都按 UTC-7 计时（原文标注 (UTC-7)）
    const start = maint && maint.mo === g.startMo && maint.d === g.startD
      ? cstFromParts(pickYear(g.startMo, ref), g.startMo, g.startD, maint.h + maint.hours, maint.mi, -7)
      : null;
    const end = cstFromParts(pickYear(g.endMo, ref), g.endMo, g.endD, g.endH, g.endMi, -7);
    const noteParts = ['server=EN', 'post=' + String(post.id ?? '?'), '原文区间 ' + g.rangeRaw];
    if (start === null) noteParts.push('start_at=null（区间起点无绝对时刻）');
    else noteParts.push('start 取维护结束（原文 approximately N hours）');
    out.push({
      game_key: 'azurlane',
      pool_name: 'Event Construction Pool',
      pool_type: 'limited_character',
      characters: g.ships.slice(0, JP_MAX_SHIPS),
      start_at: start,
      end_at: end,
      version: null,
      period: null,
      evidence: (g.rangeRaw + ' | ' + g.ships.join(', ')).slice(0, 200),
      note: noteParts.join('；'),
      source: {
        id: EN_CACHE_ID,
        tier: 'L0',
        url: String(post.link ?? EN_URL),
        fetched_at: null,
      },
    });
  }
  return out;
}

export async function collectAzurLaneEn(ctx: SourceContext): Promise<PoolCandidate[]> {
  // 国际服 WP 站点偶发超时（>20s）：放宽到 45s 并重试一次，避免「碧蓝航线无卡池」这类空窗
  const fetchEn = () => fetchJson<EnPost[]>(EN_URL, { timeoutMs: 45_000 });
  const posts = await withSourceCache<EnPost[]>(ctx, EN_CACHE_ID, async () => {
    try {
      return await fetchEn();
    } catch (e: any) {
      ctx.log('[source:azurlane-en] 首次请求失败，重试一次:', e?.message ?? e);
      return await fetchEn();
    }
  });
  if (!Array.isArray(posts)) {
    ctx.log('[source:azurlane-en] 公告列表不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const out: PoolCandidate[] = [];
  for (const post of posts.slice(0, 25)) {
    for (const cand of parseEnPost(post)) {
      if (cand.end_at && Date.parse(cand.end_at) < ctx.now - 86_400_000) continue;
      out.push(cand);
    }
  }
  if (out.length === 0) ctx.log('[source:azurlane-en] 未解析出 event construction pool');
  return out;
}

export const azurlaneJpAdapter: SourceAdapter = {
  id: 'azurlane-jp',
  tier: 'L0',
  label: '碧蓝航线日服公告',
  games: ['azurlane'],
  collect: collectAzurLaneJp,
};

export const azurlaneEnAdapter: SourceAdapter = {
  id: 'azurlane-en',
  tier: 'L0',
  label: '碧蓝航线国际服公告',
  games: ['azurlane'],
  collect: collectAzurLaneEn,
};

// 兼容契约里单文件映射两个 id 的用法：默认导出日服（主源）
export default azurlaneJpAdapter;
