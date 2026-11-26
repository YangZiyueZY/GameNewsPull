// PRTS Wiki（明日方舟）结构化信源适配器（tier L2）：常驻标准寻访轮换。
//
// 两条路径取并集（契约 q9：PRTS SMW ask 为主 + 卡池一览 wikitext 作校验）：
//   A) SMW ask：[[分类:常驻标准寻访]] 的语义查询，printouts 里带「出率提升干员」与
//      「寻访开启/关闭时间cn」（时间字段是 {timestamp, raw} 结构，timestamp 为秒级 UTC）；
//   B) action=parse&prop=wikitext：卡池一览表的行（序号 / 开启时间 / 特定干员（6星）/（5星）），
//      另外兼容 **{{寻访信息|…}} 模板**写法（模板改名也能吃）。
// 为什么两路都要：ask 给的时间戳精度高且可排序，wikitext 给的是 6★/5★ 区分——单靠 ask
// 会把 5★ 也算成 UP（超过 resolver 的 2 人上限整条被丢弃），所以同键合并时以 wikitext 为主。
//
// 注意：PRTS 的 ask 只认 query 内的内联参数（limit/sort/order 放外面会返回 warnings 且不排序）。

import type { PoolCandidate, SourceAdapter, SourceContext } from '../../pools/types.ts';
import { fetchJson, withSourceCache } from '../http.ts';

const CST_OFFSET_MS = 8 * 3_600_000;

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

/** 东八区墙上时间 → ISO（月份从 1 开始） */
function cstIso(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return cstIsoFromMs(Date.UTC(y, mo - 1, d, h, mi, 0) - CST_OFFSET_MS);
}

const PRTS_API = 'https://prts.wiki/api.php';
const ASK_QUERY = '[[分类:常驻标准寻访]]|?寻访名cn|?寻访开启时间cn|?寻访关闭时间cn|?出率提升干员|?商店兑换干员|limit=20|sort=寻访开启时间cn|order=desc';
const WIKITEXT_PAGE = '卡池一览/常驻标准寻访/2026';
const DEFAULT_POOL_NAME = '常驻标准寻访';
const EVIDENCE_MAX = 240;

export const PRTS_ASK_CACHE = 'prts-smw-ask';
export const PRTS_WIKITEXT_CACHE = 'prts-smw-wikitext';

const ASK_URL = PRTS_API + '?action=ask&format=json&query=' + encodeURIComponent(ASK_QUERY);
const PARSED_PAGE_URL = PRTS_API + '?action=parse&format=json&page=' + encodeURIComponent(WIKITEXT_PAGE) + '&prop=wikitext';
const PAGE_HUMAN_URL = 'https://prts.wiki/w/' + encodeURIComponent(WIKITEXT_PAGE);

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

/** printouts 里的时间字段可能是 {timestamp, raw} 也可能是裸字符串 */
function printoutTimestamp(value: unknown): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first == null) return null;
  if (typeof first === 'object') {
    const ts = Number((first as any).timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts * 1000 : null;
  }
  const num = Number(first);
  if (Number.isFinite(num) && num > 0) return num * 1000;
  const parsed = Date.parse(String(first));
  return Number.isFinite(parsed) ? parsed : null;
}

function printoutStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return dedupeNames(value.map((v) => String(v ?? '')).filter(Boolean));
}

function prtsSourceRef(ctx: SourceContext, url: string) {
  return { id: 'prts-smw', tier: 'L2' as const, url, fetched_at: ctx.nowCst };
}

function poolKey(c: PoolCandidate): string {
  return [c.game_key, c.pool_name, c.start_at ?? '', c.end_at ?? ''].join('|');
}

// —————————————— 路径 A：SMW ask ——————————————

interface AskResult {
  printouts?: Record<string, unknown>;
  fullurl?: string;
  fulltext?: string;
}

/** ask 结果 → 候选池。只要时间与「出率提升干员」都在，才认（缺就跳过，不猜） */
export function parsePrtsAsk(data: unknown, ctx: SourceContext): PoolCandidate[] {
  const results = (data as any)?.query?.results;
  if (!results || typeof results !== 'object') return [];
  const out: PoolCandidate[] = [];
  for (const [page, raw] of Object.entries(results as Record<string, AskResult>)) {
    const printouts = raw?.printouts ?? {};
    const startMs = printoutTimestamp(printouts['寻访开启时间cn']);
    const endMs = printoutTimestamp(printouts['寻访关闭时间cn']);
    if (startMs === null) continue;
    const characters = printoutStrings(printouts['出率提升干员']);
    if (!characters.length) continue;
    const shop = printoutStrings(printouts['商店兑换干员']);
    const nameList = printoutStrings(printouts['寻访名cn']);
    const images = (raw?.fullurl ?? '') as string;
    const url = images.startsWith('//') ? 'https:' + images : images || PAGE_HUMAN_URL;
    out.push({
      game_key: 'arknights',
      pool_name: nameList[0] || DEFAULT_POOL_NAME,
      pool_type: 'standard_character',
      characters,
      start_at: cstIsoFromMs(startMs),
      end_at: endMs === null ? null : cstIsoFromMs(endMs),
      version: null,
      period: null,
      evidence: clip('SMW ask：' + page + '｜出率提升：' + characters.join('、')),
      note: shop.length ? '商店兑换：' + shop.join('、') + '（出率提升含 5★，以 wikitext 的 6★ 名单为准）' : '出率提升含 5★，以 wikitext 的 6★ 名单为准',
      source: prtsSourceRef(ctx, url),
    });
  }
  return out;
}

// —————————————— 路径 B：wikitext（表格 / {{寻访信息}} 模板）——————————————

/** 模板参数里的角色名：「{{干员头像|薇薇安娜|shop=1}}」→ 薇薇安娜（shop 标记不参与角色名） */
function templateCharacterNames(cell: string): string[] {
  const names: string[] = [];
  const re = /\{\{\s*干员头像\s*\|([^|}]+)(?:\|[^}]*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) names.push(m[1].trim());
  return dedupeNames(names);
}

/** 「2026-11-19 04:00~<br/>2026-12-03 03:59」→ 起止 */
function parseWikiRange(cell: string): { start_at: string | null; end_at: string | null } {
  const flat = cell.replace(/<br\s*\/?>/gi, ' ').trim();
  const frags = flat.match(/\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/g) ?? [];
  const toIso = (s: string): string | null => {
    const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    return m ? cstIso(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
  };
  return { start_at: frags[0] ? toIso(frags[0]) : null, end_at: frags[1] ? toIso(frags[1]) : null };
}

function rowCandidate(
  row: { period: string | null; start_at: string | null; end_at: string | null; six: string[]; five: string[] },
  ctx: SourceContext,
  url: string,
  poolName: string = DEFAULT_POOL_NAME,
): PoolCandidate | null {
  if (!row.start_at || !row.six.length) return null;
  return {
    game_key: 'arknights',
    pool_name: poolName,
    pool_type: 'standard_character',
    characters: row.six,
    start_at: row.start_at,
    end_at: row.end_at,
    version: null,
    period: row.period ? DEFAULT_POOL_NAME + ' ' + row.period + ' 期' : null,
    evidence: clip('wikitext：' + DEFAULT_POOL_NAME + ' ' + (row.period ?? '') + '｜6★：' + row.six.join('、') + '｜5★：' + row.five.join('、')),
    note: row.five.length ? '5★ 出率提升：' + row.five.join('、') : null,
    source: prtsSourceRef(ctx, url),
  };
}

/** 解析「卡池一览/常驻标准寻访/<年>」的 wikitext：表格行 + {{寻访信息}} 模板都认 */
export function parsePrtsWikitext(wikitext: string, ctx: SourceContext): PoolCandidate[] {
  const text = String(wikitext ?? '');
  const out: PoolCandidate[] = [];

  // ① 表格行：|序号 / |页面 / |时间 / |特定干员（6星）/ |特定干员（5星）
  const rowBlocks = text.split(/^\|-\s*$/m).slice(1);
  for (const block of rowBlocks) {
    const cells = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && !l.startsWith('|}') && !l.startsWith('|-'))
      .map((l) => l.slice(1).trim());
    if (cells.length < 4) continue;
    const period = /^\d+$/.test(cells[0]) ? cells[0] : null;
    const timeCell = cells.find((c) => /\d{4}-\d{1,2}-\d{1,2}/.test(c)) ?? '';
    const range = parseWikiRange(timeCell);
    const cellIndex = cells.indexOf(timeCell);
    const sixCell = cellIndex >= 0 ? cells[cellIndex + 1] ?? '' : '';
    const fiveCell = cellIndex >= 0 ? cells[cellIndex + 2] ?? '' : '';
    const cand = rowCandidate(
      { period, start_at: range.start_at, end_at: range.end_at, six: templateCharacterNames(sixCell), five: templateCharacterNames(fiveCell) },
      ctx,
      PAGE_HUMAN_URL,
    );
    if (cand) out.push(cand);
  }

  // ② {{寻访信息|寻访名=…|开启时间=…|关闭时间=…|出率提升干员=…}} 模板（容错写法）
  const tplRe = /\{\{\s*寻访信息\s*\|([\s\S]*?)\}\}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tplRe.exec(text)) !== null) {
    const params = new Map<string, string>();
    for (const seg of tm[1].split('|')) {
      const eq = seg.indexOf('=');
      if (eq < 0) continue;
      params.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim());
    }
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = params.get(k);
        if (v) return v;
      }
      return '';
    };
    const range = parseWikiRange(pick('开启时间', '开始时间', '寻访开启时间')) ;
    const endRange = parseWikiRange(pick('关闭时间', '结束时间', '寻访关闭时间'));
    const names = pick('特定干员', '6星干员', '出率提升干员');
    const cand = rowCandidate(
      {
        period: pick('期次', '序号') || null,
        start_at: range.start_at,
        end_at: endRange.start_at ?? range.end_at,
        six: dedupeNames(names.split(/[、,，\/]/).map((s) => s.trim()).filter(Boolean)),
        five: dedupeNames(pick('5星干员').split(/[、,，\/]/).map((s) => s.trim()).filter(Boolean)),
      },
      ctx,
      PAGE_HUMAN_URL,
      pick('寻访名', '寻访名cn', '名称') || DEFAULT_POOL_NAME,
    );
    if (cand) out.push(cand);
  }
  return out;
}

// —————————————— 合并 + 采集 ——————————————

/** 同键（游戏 + 池名 + 起止）合并：preferred（wikitext，带 6★/5★ 区分）覆盖 fallback（ask） */
export function mergePrtsCandidates(preferred: PoolCandidate[], fallback: PoolCandidate[]): PoolCandidate[] {
  const map = new Map<string, PoolCandidate>();
  for (const c of fallback) map.set(poolKey(c), c);
  for (const c of preferred) map.set(poolKey(c), c);
  return [...map.values()];
}

async function fetchAsk(ctx: SourceContext): Promise<unknown> {
  return await fetchJson<any>(ASK_URL);
}

async function fetchWikitext(ctx: SourceContext): Promise<unknown> {
  return await fetchJson<any>(PARSED_PAGE_URL);
}

function wikitextOf(resp: unknown): string {
  const p = (resp as any)?.parse ?? (resp as any);
  const wt = p?.wikitext;
  if (typeof wt === 'string') return wt;
  if (typeof wt?.['*'] === 'string') return wt['*'];
  if (typeof p?.text?.['*'] === 'string') return p.text['*'];
  return '';
}

export const prtsSmwAdapter: SourceAdapter = {
  id: 'prts-smw',
  tier: 'L2',
  label: 'PRTS Wiki 常驻轮换',
  games: ['arknights'],

  async collect(ctx: SourceContext): Promise<PoolCandidate[]> {
    let fromWiki: PoolCandidate[] = [];
    let fromAsk: PoolCandidate[] = [];

    try {
      const resp = await withSourceCache<unknown>(ctx, PRTS_WIKITEXT_CACHE, () => fetchWikitext(ctx));
      const wt = wikitextOf(resp);
      if (wt) fromWiki = parsePrtsWikitext(wt, ctx);
      else ctx.log('[prts-smw] wikitext 无可用数据（离线无缓存 / 页面改名 / 网络失败）');
    } catch (e: any) {
      ctx.log('[prts-smw] wikitext 解析失败:', e?.message ?? e);
    }

    try {
      const resp = await withSourceCache<unknown>(ctx, PRTS_ASK_CACHE, () => fetchAsk(ctx));
      if (resp) fromAsk = parsePrtsAsk(resp, ctx);
      else ctx.log('[prts-smw] SMW ask 无可用数据（离线无缓存 / 网络失败）');
    } catch (e: any) {
      ctx.log('[prts-smw] SMW ask 解析失败:', e?.message ?? e);
    }

    if (!fromWiki.length && !fromAsk.length) {
      ctx.log('[prts-smw] 两条路径都没有产出，返回空（不编造）');
      return [];
    }
    return mergePrtsCandidates(fromWiki, fromAsk);
  },
};

export default prtsSmwAdapter;
