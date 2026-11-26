// Akasha（akasha.trrw.cn）日历信源适配器（tier L2）：原神 / 崩坏：星穹铁道 / 绝区零。
//
// 接口：/api/v1/games/<ys|sr|zzz>/calendar?limit=100&offset=N，items[].kind==='卡池' 才是卡池。
// 字段：title / start / end / version / cover；start/end 是 **UTC（Z）**，输出一律转成东八区 ISO（+08:00）。
//
// 类型映射（按标题句式，不做语义猜测）：
//   「活动跃迁：A、B、池名1、池名2」→ hsr 角色池：前面若干段是角色名，后面是池名；
//   「代理人调频：A、B」→ zzz 角色池（调频系列名做 pool_name，角色取「：」后按、拆开）；
//   「音擎调频：…」→ zzz 武器池；
//   原神只有池名 → characters=[] 且 note='池名待映射角色'（契约 q10：角色映射由 char-names 字典负责）。
// 角色 vs 池名的判定：只认「前缀」——一段不是角色名时，它及其后全部算池名；因此
// 「欢迎来到银河城」「当第一声『阿哈』响起」这类描述性池名不会混进角色，而「银狼LV.999」「千冶•刃」能留下。

import type { PoolCandidate, PoolType, SourceAdapter, SourceContext } from '../../pools/types.ts';
import { fetchJson, withSourceCache } from '../http.ts';

const CST_OFFSET_MS = 8 * 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const EVIDENCE_MAX = 240;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch ms → 东八区 ISO（不依赖进程时区） */
function cstIsoFromMs(ms: number): string {
  const d = new Date(ms + CST_OFFSET_MS);
  return (
    d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '+08:00'
  );
}

/** UTC 时间串（…Z）→ 东八区 ISO；解析不出返回 null（不猜） */
export function utcToCstIso(value: unknown): string | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? cstIsoFromMs(ms) : null;
}

interface AkashaItem {
  id?: string;
  kind?: string;
  title?: string;
  start?: string;
  end?: string;
  version?: string;
  cover?: string;
  labels?: string[];
  url?: string;
}

interface AkashaBundle {
  total: number;
  items: AkashaItem[];
}

/** 游戏 key ↔ 接口 slug（ys=原神 / sr=星穹铁道 / zzz=绝区零） */
const GAME_SLUGS: Array<{ gameKey: string; slug: string }> = [
  { gameKey: 'genshin', slug: 'ys' },
  { gameKey: 'hsr', slug: 'sr' },
  { gameKey: 'zzz', slug: 'zzz' },
];

export function akashaCacheId(slug: string): string {
  return 'akasha-' + slug;
}

function clip(text: string, max = EVIDENCE_MAX): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function dedupeNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = String(n ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 一段能不能当角色名（启发式，只在「：」后按、拆出来的段落上用）：
 * - 描述性池名以这些词开头/或含「的」「『』」等：欢迎来到银河城 / 当第一声『阿哈』响起 / 献给明日的色彩；
 * - 角色名多为短名、可带 ★ / • / LV.999 这类后缀（银狼LV.999、千冶•刃、星神★阿哈）。
 * 只做「前缀截断」判定：一旦某段不是角色，它后面的都算池名，所以误判只影响切点、不会造出角色。
 */
const NON_CHARACTER_PREFIXES = ['当', '欢迎', '敬请', '请', '限时', '复刻', '全新', '致', '给', '在', '从', '于', '这', '那', '每', '若', '是', '让', '特别', '本次'];

function isCharacterSegment(segment: string): boolean {
  const s = segment.trim();
  if (!s || s.length > 12) return false;
  if (NON_CHARACTER_PREFIXES.some((p) => s.startsWith(p))) return false;
  if (/[的『』「」？！，。]/.test(s)) return false;
  return true;
}

/** 「：」之后按「、」分段，返回 { 角色（前缀）, 池名（余下） } */
export function splitBannerTitle(title: string): { characters: string[]; poolNames: string[] } {
  const idx = title.indexOf('：');
  const body = idx >= 0 ? title.slice(idx + 1) : title;
  const segments = body.split('、').map((s) => s.trim()).filter(Boolean);
  let cut = 0;
  while (cut < segments.length && isCharacterSegment(segments[cut])) cut += 1;
  return { characters: dedupeNames(segments.slice(0, cut)), poolNames: dedupeNames(segments.slice(cut)) };
}

/** 原神：只有池名；神铸赋形是武器池系列，其余按限定角色池处理 */
function genshinPoolType(title: string): PoolType {
  if (/神铸赋形/.test(title)) return 'weapon';
  if (/常驻祈愿|新手祈愿/.test(title)) return 'standard_character';
  return 'limited_character';
}

interface ParsedPool {
  pool_name: string;
  pool_type: PoolType;
  characters: string[];
  note: string | null;
}

/** 标题 → 池名 / 类型 / 角色（三个游戏的映射口径都在这一个函数里，便于对照契约 §3） */
export function classifyAkashaPool(gameKey: string, title: string): ParsedPool | null {
  const raw = String(title ?? '').trim();
  if (!raw) return null;

  if (gameKey === 'hsr') {
    // 星铁：「活动跃迁：角色…、池名…」。不以「活动跃迁：」开头的卡池按池名直出，角色留空（不猜）
    if (raw.startsWith('活动跃迁：')) {
      const { characters, poolNames } = splitBannerTitle(raw);
      return {
        pool_name: poolNames.length ? poolNames.join('、') : raw.replace(/^活动跃迁：/, '').trim() || raw,
        pool_type: 'limited_character',
        characters,
        note: poolNames.length ? null : '池名未与角色分列，按标题整体作池名',
      };
    }
    return { pool_name: raw, pool_type: 'limited_character', characters: [], note: '池名待映射角色' };
  }

  if (gameKey === 'zzz') {
    if (raw.startsWith('代理人调频')) {
      const { characters } = splitBannerTitle(raw);
      return { pool_name: '代理人调频', pool_type: 'limited_character', characters, note: null };
    }
    if (raw.startsWith('音擎调频')) {
      const { characters } = splitBannerTitle(raw);
      // 音擎调频列出的是音擎（武器）名，武器池不列角色（契约 §3）
      return {
        pool_name: '音擎调频',
        pool_type: 'weapon',
        characters: [],
        note: characters.length ? '音擎：' + characters.join('、') : null,
      };
    }
    return { pool_name: raw, pool_type: 'limited_character', characters: [], note: '池名待映射角色' };
  }

  // 原神：接口只给池名
  return { pool_name: raw, pool_type: genshinPoolType(raw), characters: [], note: '池名待映射角色' };
}

function akashaSourceRef(ctx: SourceContext, item: AkashaItem) {
  const url = item.url && /^https?:/.test(item.url) ? item.url : null;
  return { id: 'akasha', tier: 'L2' as const, url, fetched_at: ctx.nowCst };
}

/** 单条日历项 → 候选池（kind 不是「卡池」或标题为空时返回 null） */
export function parseAkashaItem(gameKey: string, item: AkashaItem, ctx: SourceContext): PoolCandidate | null {
  if (!item || String(item.kind ?? '') !== '卡池') return null;
  const classified = classifyAkashaPool(gameKey, String(item.title ?? ''));
  if (!classified) return null;
  return {
    game_key: gameKey,
    pool_name: classified.pool_name,
    pool_type: classified.pool_type,
    characters: classified.characters,
    start_at: utcToCstIso(item.start),
    end_at: utcToCstIso(item.end),
    version: item.version ? String(item.version) : null,
    period: item.version ? String(item.version) + ' 版本' : null,
    evidence: clip((item.title ?? '') + '｜' + (item.start ?? '') + ' → ' + (item.end ?? '')),
    note: classified.note,
    source: akashaSourceRef(ctx, item),
  };
}

async function fetchAllPages(slug: string, ctx: SourceContext): Promise<AkashaBundle> {
  const items: AkashaItem[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = 'https://akasha.trrw.cn/api/v1/games/' + slug + '/calendar?limit=' + PAGE_SIZE + '&offset=' + page * PAGE_SIZE;
    const resp = await fetchJson<any>(url);
    const got: AkashaItem[] = Array.isArray(resp?.items) ? resp.items : [];
    total = Number(resp?.total ?? total);
    items.push(...got);
    if (!got.length || items.length >= total) break;
  }
  return { total, items };
}

export const akashaAdapter: SourceAdapter = {
  id: 'akasha',
  tier: 'L2',
  label: 'Akasha 活动日历',
  games: ['genshin', 'hsr', 'zzz'],

  async collect(ctx: SourceContext): Promise<PoolCandidate[]> {
    const out: PoolCandidate[] = [];
    for (const { gameKey, slug } of GAME_SLUGS) {
      try {
        const bundle = await withSourceCache<AkashaBundle>(ctx, akashaCacheId(slug), () => fetchAllPages(slug, ctx));
        if (!bundle || !Array.isArray(bundle.items)) {
          ctx.log('[akasha] ' + gameKey + ' 无可用数据（离线无缓存 / 网络失败）');
          continue;
        }
        for (const item of bundle.items) {
          const cand = parseAkashaItem(gameKey, item, ctx);
          if (cand) out.push(cand);
        }
      } catch (e: any) {
        ctx.log('[akasha] ' + gameKey + ' 解析失败:', e?.message ?? e);
      }
    }
    return out;
  },
};

export default akashaAdapter;
