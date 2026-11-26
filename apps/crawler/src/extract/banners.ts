// 祈愿公告 → 卡池期次结构化抽取
//
// 目标：卡池角色不再只依赖人工维护的 config/banners.ts。
// B 站官方公告里已经写明本期卡池角色与开池时间，本模块负责解析出来，
// 再与人工 config 合并（并集，不删除人工项），避免「新角色上线但站点没抓到」。
//
// 实测样例（2026-11-23 原神祈愿公告 1273842634488545282）：
//   #原神# #原神7.2版本#
//   本期活动祈愿时间为2026/11/24 18:00 ~ 2026/12/15 14:59。
//   限定5星角色「驹隙隐泉·兹白(岩)」「博闻异旅·莉奈娅(岩)」，限定5星武器「朏魄含光」…
//   → characters ['兹白','莉奈娅']，start 2026-11-24T18:00:00+08:00，end 2026-12-15T14:59:00+08:00
//
// 识别很严格：只认「祈愿/寻访… + 紧邻的开池时间」或「…概率将大幅提升」的句子，
// 否则会把抽奖转发里的时装上架日期、联动日期误判成开池时间。

import type { NewsItem } from './normalize.ts';
import { BANNERS } from '../../config/banners.ts';
import type { BannerPeriod } from '../../config/banners.ts';

export interface AutoBannerPeriod {
  label: string;                 // 例如：7.2版本 第1期 / 官方公告
  characters: string[];          // 归一化后的角色名，按公告中出现顺序去重
  start: string | null;          // ISO 8601，带时区（+08:00）
  end: string | null;            // ISO 8601，公告未给出则为 null
  version: string | null;        // 例如 7.2
  source: 'bilibili';
}

export interface BannerOutput {
  label: string;
  phase: null;
  characters: string[];
  start_at: string | null;
  end_at: string | null;
  status: '进行中' | '未开始' | '已结束';
  days_remaining: number | null;
  note: string | null;
  source: 'config' | 'bilibili' | 'config+bilibili';
}

const DAY_MS = 86_400_000;
const MATCH_TOLERANCE_MS = 36 * 3600_000;   // 官方开池时间与人工时段允许的偏差

// ——————————————————————————— 角色名归一化 ———————————————————————————

const TRAILING_PAREN_RE = /\s*[(（][^()（）]{1,6}[)）]\s*$/;

/** 驹隙隐泉·兹白(岩) → 兹白；博闻异旅·莉奈娅(岩) → 莉奈娅 */
export function normalizeCharacterName(raw: string): string {
  if (typeof raw !== 'string') return '';
  let name = raw.trim();
  name = name.replace(/^[「『《"']+/, '').replace(/[」』》"']+$/, '').trim();
  name = name.replace(TRAILING_PAREN_RE, '').trim();
  if (name.includes('·') || name.includes('・')) {
    const parts = name.split(/[·・]/).map(p => p.trim()).filter(Boolean);
    if (parts.length) name = parts[parts.length - 1];
  }
  name = name.replace(/\s+/g, '').replace(/^[·・\-]+|[·・\-]+$/g, '');
  if (name.length < 2 || name.length > 12) return '';
  return name;
}

// ——————————————————————————— 时间解析 ———————————————————————————

interface DateToken {
  year: number | null;
  month: number;
  day: number;
  hour: number;
  minute: number;
  index: number;
  end: number;
}

// 三种写法：2026/11/24 18:00、2026年11月24日18:00、11月24日18:00
const DATE_TOKEN_RE = /(\d{4})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：]\s*(\d{2}))?|(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/g;

function parseDateTokens(text: string): DateToken[] {
  const tokens: DateToken[] = [];
  DATE_TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(DATE_TOKEN_RE)) {
    const index = m.index ?? 0;
    if (m[1]) {
      tokens.push({
        year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
        hour: m[4] ? Number(m[4]) : 0, minute: m[5] ? Number(m[5]) : 0,
        index, end: index + m[0].length,
      });
    } else {
      tokens.push({
        year: null, month: Number(m[6]), day: Number(m[7]),
        hour: m[8] ? Number(m[8]) : 0, minute: m[9] ? Number(m[9]) : 0,
        index, end: index + m[0].length,
      });
    }
  }
  return tokens;
}

/** 缺年份时按参考时间就近取年（东八区） */
function inferYear(month: number, day: number, hour: number, minute: number, refMs: number): number {
  const refYear = new Date(refMs + 8 * 3600_000).getUTCFullYear();
  let best = refYear;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const candidate = Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600_000;
    const diff = Math.abs(candidate - refMs);
    if (diff < bestDiff) { bestDiff = diff; best = year; }
  }
  return best;
}

function toCstMs(token: DateToken, refMs: number, afterMs?: number): number {
  const year = token.year ?? inferYear(token.month, token.day, token.hour, token.minute, refMs);
  let ms = Date.UTC(year, token.month - 1, token.day, token.hour, token.minute) - 8 * 3600_000;
  // 跨年时段：结束时间早于开始时间时顺延一年
  if (afterMs !== undefined && ms < afterMs - 30 * DAY_MS && token.year === null) {
    ms = Date.UTC(year + 1, token.month - 1, token.day, token.hour, token.minute) - 8 * 3600_000;
  }
  return ms;
}

function formatCst(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00+08:00`;
}

interface BannerWindow { start: string; startMs: number; end: string | null; endMs: number | null }

/**
 * 时间区间分隔：'~' '～' '-' '–' '—' '－' '至' '到'
 * 兼容「2026/11/24 18:00 ~ 2026/12/15 14:59」与「2026/11/11 4.7版本更新后 - 2026/12/22 15:00」两种写法。
 */
function isRangeSeparator(between: string): boolean {
  if (between.length > 30) return false;
  if (/[~～\-–—－]/.test(between)) return true;
  return /至|到/.test(between) && between.length <= 6;
}

/** 一句话里的开池时间窗：命中 'A ~ B' 取区间，否则取第一个时间点 */
function windowFromSentence(sentence: string, refMs: number): BannerWindow | null {
  const tokens = parseDateTokens(sentence);
  if (!tokens.length) return null;

  for (let i = 0; i + 1 < tokens.length; i++) {
    const first = tokens[i];
    const second = tokens[i + 1];
    if (!isRangeSeparator(sentence.slice(first.end, second.index))) continue;
    const startMs = toCstMs(first, refMs);
    const endMs = toCstMs(second, refMs, startMs);
    return { start: formatCst(startMs), startMs, end: formatCst(endMs), endMs };
  }

  const startMs = toCstMs(tokens[0], refMs);
  return { start: formatCst(startMs), startMs, end: null, endMs: null };
}

// ——————————————————————————— 版本号 ———————————————————————————

function extractVersionFromText(text: string): string | null {
  // 话题标签优先：#原神7.2版本#
  for (const m of text.matchAll(/#([^#\n]{1,24})#/g)) {
    const hit = m[1].match(/(\d+\.\d+)\s*版本/);
    if (hit) return hit[1];
  }
  const plain = text.match(/(\d+\.\d+)\s*版本/);
  return plain ? plain[1] : null;
}

// ——————————————————————————— 祈愿语境识别 ———————————————————————————

const GACHA_KEYWORD_RE = /祈愿|寻访|调频|跃迁|招募|卡池/;
// 「…的祈愿获取概率将大幅提升」「…跃迁成功概率限时提升」这类句子本身就是卡池公告
const BOOST_RE = /概率[^。\n]{0,8}(?:提升|UP)/;
const SENTENCE_SPLIT_RE = /[。！!；;\n]+/;

/** 句内所有祈愿关键词的位置（一句里可能多次出现，例如「…跃迁成功概率限时提升，…跃迁时间为 A - B」） */
function keywordIndexes(sentence: string): number[] {
  const indexes: number[] = [];
  const re = new RegExp(GACHA_KEYWORD_RE.source, 'g');
  for (const m of sentence.matchAll(re)) indexes.push(m.index ?? 0);
  return indexes;
}

/** 句子里紧邻任一祈愿关键词（后面 60 字内、且不在关键词之前太远）的时间点 */
function nearKeywordTokens(sentence: string): DateToken[] {
  const indexes = keywordIndexes(sentence);
  if (!indexes.length) return [];
  return parseDateTokens(sentence).filter(t => indexes.some(k => t.index >= k - 10 && t.index - k <= 60));
}

interface GachaContext { characters: string[]; window: BannerWindow | null }

/**
 * 从公告正文里提取「祈愿语境」：
 *  ① 关键词句：含祈愿/寻访，且句内紧邻开池时间，或含「概率将大幅提升」
 *  ② 角色只从这些句子里取，避免把时装/联动/抽奖文案里的名字当卡池角色
 */
function readGachaContext(text: string, refMs: number): GachaContext | null {
  const sentences = text.split(SENTENCE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  const gachaSentences: string[] = [];
  for (const sentence of sentences) {
    if (!GACHA_KEYWORD_RE.test(sentence)) continue;
    const hasNearDate = nearKeywordTokens(sentence).length > 0;
    if (!hasNearDate && !BOOST_RE.test(sentence)) continue;
    gachaSentences.push(sentence);
  }
  if (!gachaSentences.length) return null;

  let window: BannerWindow | null = null;
  for (const sentence of gachaSentences) {
    if (!nearKeywordTokens(sentence).length) continue;
    const candidate = windowFromSentence(sentence, refMs);
    if (candidate && (!window || (!window.end && candidate.end))) window = candidate;
  }

  const characters = extractCharacters(gachaSentences.join('。'));
  if (!characters.length && !window) return null;
  return { characters, window };
}

// 「华黍由仪」祈愿 / 「炎天铸名」集录祈愿 —— 这些是卡池或活动名，不是角色
const EVENT_NAME_RE = /[「『]([^」』]{1,24})[」』]\s*(?:活动)?\s*(?:祈愿|卡池|寻访|跃迁|调频|集录|招募|版本)/g;
// 限定5星角色「A(岩)」「B(岩)」/ S级角色「Exe」/ 4星角色「…」
const ROLE_LIST_RE = /(?:限定\s*)?(?:(?:5|4)星|五星|四星|S级|A级)?\s*(?:角色|代理人|干员|共鸣者)((?:[「『][^」』]{1,24}[」』][\s、,，·]*)+)/g;
// 只认高稀有度角色：限定5星角色 / 五星角色 / S级角色
const ROLE_LIST_RARE_RE = /(?:限定\s*)?(?:5星|五星|S级|A级)\s*(?:角色|代理人|干员|共鸣者)((?:[「『][^」』]{1,24}[」』][\s、,，·]*)+)/g;
const QUOTED_RE = /[「『]([^」』]{1,24})[」』]/g;
// 带元素 / 星级后缀的角色写法：驹隙隐泉·兹白(岩)
const CHAR_SUFFIX_RE = /[(（]\s*(?:火|水|雷|冰|岩|风|草|物理|量子|虚数|S级|A级|B级|5星|4星|五星|四星)\s*[)）]\s*$/;

/**
 * 角色抽取分档：
 *  ① 优先「限定5星角色「A」「B」」这类高稀有度列举（HSR 跃迁公告里还有 4 星角色与光锥，不能混进来）；
 *  ② 没有高稀有度列举时，退到任意「角色/代理人」列举；
 *  ③ 再退到带元素/星级后缀的写法（角色预告：届时「驹隙隐泉·兹白(岩)」…）。
 */
function extractCharacters(text: string): string[] {
  const eventNames = new Set<string>();
  for (const m of text.matchAll(EVENT_NAME_RE)) eventNames.add(m[1].trim());

  const collectFromList = (re: RegExp): string[] => {
    const names: string[] = [];
    const push = (raw: string) => {
      if (eventNames.has(raw.trim())) return;
      const name = normalizeCharacterName(raw);
      if (name && !names.includes(name)) names.push(name);
    };
    for (const m of text.matchAll(re)) {
      for (const q of m[1].matchAll(QUOTED_RE)) push(q[1]);
    }
    return names;
  };

  const rare = collectFromList(ROLE_LIST_RARE_RE);
  if (rare.length) return rare;

  const listed = collectFromList(ROLE_LIST_RE);
  if (listed.length) return listed;

  const suffixed: string[] = [];
  for (const m of text.matchAll(QUOTED_RE)) {
    if (!CHAR_SUFFIX_RE.test(m[1])) continue;
    if (eventNames.has(m[1].trim())) continue;
    const name = normalizeCharacterName(m[1]);
    if (name && !suffixed.includes(name)) suffixed.push(name);
  }
  return suffixed;
}

// ——————————————————————————— 公告 → 期次 ———————————————————————————

interface PeriodAcc {
  startMs: number | null;
  start: string | null;
  endMs: number | null;
  end: string | null;
  characters: string[];
  version: string | null;
  latestPublishedAt: number;
}

/**
 * 解析公告类动态，产出官方卡池期次。
 * 同一公告内多角色合并为一期；跨公告按开池时间合并（角色取并集，保序去重）。
 */
export function parseBannerAnnouncements(items: NewsItem[]): AutoBannerPeriod[] {
  const accs = new Map<string, PeriodAcc>();

  for (const item of items) {
    const text = `${item.title}\n${item.summary}`;
    if (!GACHA_KEYWORD_RE.test(text)) continue;

    const publishedAt = new Date(item.published_at).getTime();
    const refMs = Number.isFinite(publishedAt) ? publishedAt : Date.now();
    const context = readGachaContext(text, refMs);
    if (!context) continue;

    const { characters, window } = context;
    if (!characters.length) continue;

    const version = extractVersionFromText(text);
    const startKey = window ? window.start : `chars:${[...characters].sort().join(',')}`;
    const exists = accs.get(startKey);
    if (!exists) {
      accs.set(startKey, {
        startMs: window ? window.startMs : null,
        start: window ? window.start : null,
        endMs: window ? window.endMs : null,
        end: window ? window.end : null,
        characters: [...characters],
        version,
        latestPublishedAt: refMs,
      });
      continue;
    }
    for (const name of characters) if (!exists.characters.includes(name)) exists.characters.push(name);
    exists.version = exists.version ?? version;
    if (!exists.end && window?.end) { exists.end = window.end; exists.endMs = window.endMs; }
    exists.latestPublishedAt = Math.max(exists.latestPublishedAt, refMs);
  }

  // 「4.7版本已开启」这类公告没有开池时间，若同版本已有带时间的期次则并入，避免出现重复的「时间待公布」期次
  for (const [key, acc] of [...accs.entries()]) {
    if (acc.start || !acc.version) continue;
    const host = [...accs.entries()]
      .filter(([otherKey, other]) => otherKey !== key && !!other.start && other.version === acc.version)
      .map(([, other]) => other)
      .sort((a, b) => (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY))[0];
    if (!host) continue;
    for (const name of acc.characters) if (!host.characters.includes(name)) host.characters.push(name);
    accs.delete(key);
  }

  const periods = [...accs.values()].sort((a, b) => {
    const am = a.startMs ?? Number.POSITIVE_INFINITY;
    const bm = b.startMs ?? Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    return a.latestPublishedAt - b.latestPublishedAt;
  });

  return periods.map((p, i) => ({
    label: p.version ? `${p.version}版本 第${i + 1}期` : `官方公告${periods.length > 1 ? ` 第${i + 1}期` : ''}`,
    characters: p.characters,
    start: p.start,
    end: p.end,
    version: p.version,
    source: 'bilibili' as const,
  }));
}

// ——————————————————————————— config ∪ 官方 合并 ———————————————————————————

interface DecorateInput {
  label: string;
  characters: string[];
  start: string | null;
  end: string | null;
  note: string | null;
  source: BannerOutput['source'];
}

function decorate(input: DecorateInput, now: number): BannerOutput {
  const startAt = input.start ? new Date(input.start).getTime() : null;
  const endAt = input.end ? new Date(input.end).getTime() : null;
  let status: BannerOutput['status'] = '进行中';
  if (startAt !== null && now < startAt) status = '未开始';
  else if (endAt !== null && now > endAt) status = '已结束';
  const daysRemaining = status === '进行中' && endAt !== null
    ? Math.max(0, Math.ceil((endAt - now) / DAY_MS))
    : null;
  return {
    label: input.label,
    phase: null,
    characters: input.characters,
    start_at: input.start,
    end_at: input.end,
    status,
    days_remaining: daysRemaining,
    note: input.note,
    source: input.source,
  };
}

/** 人工时段与官方公告是否同一期：开池时间接近，或官方开池时间落在人工时段内，或角色名有交集 */
function isSamePeriod(period: BannerPeriod, official: AutoBannerPeriod): boolean {
  const periodStart = period.start ? new Date(period.start).getTime() : null;
  const periodEnd = period.end ? new Date(period.end).getTime() : null;
  const officialStart = official.start ? new Date(official.start).getTime() : null;

  if (periodStart !== null && officialStart !== null) {
    if (Math.abs(officialStart - periodStart) <= MATCH_TOLERANCE_MS) return true;
    if (periodEnd !== null && officialStart >= periodStart && officialStart <= periodEnd) return true;
    return false;
  }
  return official.characters.some(name => (period.characters ?? []).includes(name));
}

function startMsOf(banner: BannerOutput): number {
  const ms = banner.start_at ? new Date(banner.start_at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * 卡池期次：config 为骨架（决定期次与时段），官方公告补充角色（并集，不删除人工项）。
 * 无 config 时直接用官方公告结果；官方公告里 config 未覆盖的新期次会追加。
 */
export function buildBanners(gameKey: string, items: NewsItem[], nowMs?: number): BannerOutput[] {
  // nowMs 可注入：便于离线重建与测试固定时钟
  const now = nowMs ?? Date.now();
  const configured: BannerPeriod[] = BANNERS[gameKey] ?? [];
  const official = parseBannerAnnouncements(items);

  if (!configured.length) {
    // 无人工 config 的游戏（HSR）：45 天回填会带回大量历史期次，只保留「未结束或 7 天内刚结束」的
    const visible = official.filter(p => {
      const endMs = p.end ? new Date(p.end).getTime() : null;
      if (endMs === null || !Number.isFinite(endMs)) return true;
      return endMs >= now - 7 * DAY_MS;
    });
    return visible.map((p, i) => decorate({
      // 过滤掉历史期次后重新编号，避免出现「只有第 2 期」的错位
      label: p.label.replace(/第\d+期$/, `第${i + 1}期`),
      characters: p.characters, start: p.start, end: p.end,
      note: p.end ? null : '结束时间官方未公布', source: 'bilibili',
    }, now));
  }

  const used = new Set<number>();
  const output: BannerOutput[] = configured.map(period => {
    const matchedIndex = official.findIndex((o, i) => !used.has(i) && isSamePeriod(period, o));
    // config 已不再手写角色名（q5=A），这里只从官方公告补齐
    let characters = [...(period.characters ?? [])];
    let start = period.start;
    let end = period.end;
    let source: BannerOutput['source'] = 'config';

    if (matchedIndex >= 0) {
      used.add(matchedIndex);
      const matched = official[matchedIndex];
      for (const name of matched.characters) if (!characters.includes(name)) characters.push(name);
      if (!start && matched.start) start = matched.start;
      if (!end && matched.end) end = matched.end;
      source = 'config+bilibili';
    }

    return decorate({
      label: period.label,
      characters,
      start,
      end,
      note: period.note ?? (end ? null : '结束时间官方未公布'),
      source,
    }, now);
  });

  // 官方公告里出现、但 config 尚未维护的新期次（仅取近 30 天内开始的，避免回填历史期次）
  const configWindows = configured.map(p => ({
    start: p.start ? new Date(p.start).getTime() : null,
    end: p.end ? new Date(p.end).getTime() : null,
  }));
  for (let i = 0; i < official.length; i++) {
    if (used.has(i)) continue;
    const period = official[i];
    if (!period.start) continue;
    const startMs = new Date(period.start).getTime();
    if (!Number.isFinite(startMs) || startMs < now - 30 * DAY_MS) continue;
    const overlapsConfig = configWindows.some(w => {
      if (w.start === null) return false;
      const end = w.end ?? w.start + MATCH_TOLERANCE_MS;
      return startMs >= w.start - MATCH_TOLERANCE_MS && startMs <= end + MATCH_TOLERANCE_MS;
    });
    if (overlapsConfig) continue;
    output.push(decorate({
      label: period.label,
      characters: period.characters,
      start: period.start,
      end: period.end,
      note: period.end ? null : '结束时间官方未公布',
      source: 'bilibili',
    }, now));
  }

  return output.sort((a, b) => startMsOf(a) - startMsOf(b));
}
