// 异环 nteguide 历史卡池适配器（id: nte-history，tier L3，games: ['yh']）。
// 数据源：https://nteguide.com/zh/banners/ （服务端渲染 HTML；站点明确声明「不显示当期卡池」，只做历史回顾，
// 因此这里产出的都是「已结束 / 已排期」的协定卡池，note 里必须标注非当期，published_at 留空）。
//
// 页面去标签后的文本形状（实测）：
//   历史记录 1.3 上半
//   赞空 (Zankou)
//   1.3上半限定S级角色，咒术/气体属性。
//   2026.08.19 - 2026.09.09
//   查看角色攻略 … 属性 … 定位 … 陪跑：
// 即每条 = 版本号 + 阶段 + 中文名 + 英文名（括号内）+ 起止日期。
//
// 解析口径：
//   · 每条产出 pool_type='pact'：pool_name=中文名，period=`版本 阶段`，characters=[中文名]；
//   · 起止日期按东八区解析：起点 00:00:00+08:00、终点 23:59:00+08:00；解析不出/非法日期一律 null（不猜）；
//   · 只取按开始时间倒序的最近 MAX_ENTRIES 条（历史池会一路回溯到 1.0，全量会把卡池区刷屏；
//     resolver 另有「已结束最多 2 条」的展示上限，这里再兜一层）；
//   · roster() 把解析到的中文名/英文名交给 resolver 做 yh 角色名校验。
// 失败语义：网络失败/离线无缓存 → collect 返回 [] 并 ctx.log，绝不编造。
import { fetchText, stripHtml, withSourceCache } from '../http.ts';
import { parseCnDateCst } from '../../utils/datetime.ts';
import type { CharacterBookEntry, PoolCandidate, SourceAdapter, SourceContext } from '../../pools/types.ts';

const SOURCE_ID = 'nte-history';
/** 缓存 id：<源 id>-*，落盘为 data/source-cache/nte-history-banners.json（离线快照放 data/fixtures/sources） */
export const NTE_HISTORY_CACHE_ID = 'nte-history-banners';
const BANNERS_URL = 'https://nteguide.com/zh/banners/';
/** 只取最近 6 条（页面从 1.3 一路回溯到 1.0，全量会把卡池区刷屏） */
const MAX_ENTRIES = 6;
/** note 固定口径：该站不提供当期卡池 */
const NOTE = 'nteguide 历史卡池（非当期）';
const EVIDENCE_MAX = 160;

/** 条目以「历史记录」起头；切换来源页时这段文案若变化，解析会自然退化为空（不误报） */
const ENTRY_MARKER = '历史记录';
/** 版本 + 阶段（阶段可缺） */
const HEAD_RE = /^(\d+(?:\.\d+)?)\s*(上半期|下半期|上半|下半)?/;
/** 名字行：「中文名 (English)」（也兼容全角括号） */
const NAME_RE = /^([^()（）]{1,40}?)\s*[（(]\s*([^()（）]{1,40}?)\s*[）)]/;
/** 起止日期：「2026.08.19 - 2026.09.09」，分隔符兼容 . / - 与 ~ — 至 到 */
const DATE_RANGE_RE = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s*[-~～—–－至到]\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/;
const CJK_RE = /[\u3400-\u9fff]/;
/** 名字片段合理性：不含句子标点且不超长，避免把描述句误当角色名 */
const NAME_SIDE_BAD_RE = /[。；;，,、:：!！?？]/;
function nameSideOk(side: string): boolean {
  return side.length > 0 && side.length <= 20 && !NAME_SIDE_BAD_RE.test(side);
}

/** 页面里解析出的一条历史卡池 */
export interface NteHistoryEntry {
  /** 版本号，如 1.3 */
  version: string;
  /** 阶段：上半 / 下半（页面未给则为 null） */
  stage: string | null;
  /** 中文名（如「赞空」）；页面只给英文时退化为英文名，并在 note 标注 */
  cn: string;
  /** 英文名（如「Zankou」）；缺失为 null */
  en: string | null;
  /** 起点 00:00:00+08:00；解析不出为 null */
  start_at: string | null;
  /** 终点 23:59:00+08:00；解析不出为 null */
  end_at: string | null;
  /** 解析原文片段（截断），便于回溯 */
  evidence: string;
  /** 名字是不是只有拉丁字母（页面漏了中文名） */
  latinOnly: boolean;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * 按东八区显式偏移拼 ISO：非法日期（如 2026.02.30）返回 null，不让 Date 静默进位。
 * 走 parseCnDateCst（唯一时间源），所以不依赖进程时区。
 */
function cstDateIso(y: number, mo: number, d: number, h: number, mi: number): string | null {
  return parseCnDateCst(`${y}年${mo}月${d}日 ${pad2(h)}:${pad2(mi)}`);
}

/** 阶段归一化：上半期 → 上半 */
function normalizeStage(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('上半')) return '上半';
  if (raw.startsWith('下半')) return '下半';
  return raw;
}

/**
 * 拆名字：「中文名 (English)」。个别条目把英文写在括号外（实测「Iroi (Illica)」），
 * 所以用 CJK 判断哪一侧才是中文名；两侧都没有中文时保留原文并在 note 标注，绝不翻译/编造。
 */
function splitName(left: string, right: string): { cn: string; en: string | null; latinOnly: boolean } {
  const hasLeftCjk = CJK_RE.test(left);
  const hasRightCjk = CJK_RE.test(right);
  if (hasLeftCjk && !hasRightCjk) return { cn: left, en: right || null, latinOnly: false };
  if (!hasLeftCjk && hasRightCjk) return { cn: right, en: left || null, latinOnly: false };
  // 两边都有中文（异常）时以括号外为主名；两边都没中文 → 只有英文名
  return { cn: left, en: right || null, latinOnly: !hasLeftCjk && !hasRightCjk };
}

/**
 * 解析已去标签的页面文本 → 条目数组（按页面前后顺序，未排序、未截断）。
 * 只认「版本 + 名字 + 起止日期」三者齐全的块：缺版本或缺名字直接跳过（宁可少报，不可编造）。
 */
export function parseNteHistoryEntries(text: string): NteHistoryEntry[] {
  if (!text || text.indexOf(ENTRY_MARKER) < 0) return [];
  // 压平空白：stripHtml 会留下大量换行/缩进，压成单空格后正则更好写
  const flat = text.replace(/\s+/g, ' ').trim();
  const chunks = flat.split(ENTRY_MARKER).slice(1); // 第一段是「历史记录」之前的前言
  const out: NteHistoryEntry[] = [];
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    const head = chunk.match(HEAD_RE);
    // 没有版本号的块是噪声（例如页脚 FAQ 正文里提到「历史记录」）
    if (!head || !head[1]) continue;
    const version = head[1];
    const stage = normalizeStage(head[2]);
    const rest = chunk.slice(head[0].length).trim();
    const nameMatch = rest.match(NAME_RE);
    if (!nameMatch) continue;
    // 名字两侧都要像名字：否则说明这一块是描述文本（下面还会要求出现起止日期，双保险）
    if (!nameSideOk(nameMatch[1].trim()) || !nameSideOk(nameMatch[2].trim())) continue;
    const { cn, en, latinOnly } = splitName(nameMatch[1].trim(), nameMatch[2].trim());
    if (!cn) continue;
    const afterName = rest.slice(nameMatch[0].length);
    const dateMatch = afterName.match(DATE_RANGE_RE) ?? chunk.match(DATE_RANGE_RE);
    // 完全没有「起止日期」的块不是卡池条目（页脚、导航等）
    if (!dateMatch) continue;
    const [y1, mo1, d1, y2, mo2, d2] = dateMatch.slice(1, 7).map(Number);
    const start_at = cstDateIso(y1, mo1, d1, 0, 0);
    const end_at = cstDateIso(y2, mo2, d2, 23, 59);
    const evidence = chunk.slice(0, chunk.indexOf(dateMatch[0]) + dateMatch[0].length).trim();
    out.push({
      version,
      stage,
      cn,
      en,
      start_at,
      end_at,
      evidence: evidence.length > EVIDENCE_MAX ? evidence.slice(0, EVIDENCE_MAX) : evidence,
      latinOnly,
    });
  }
  return out;
}

/** 从整页 HTML 解析条目（stripHtml 后交给 parseNteHistoryEntries） */
export function parseNteHistoryHtml(html: string): NteHistoryEntry[] {
  if (!html) return [];
  return parseNteHistoryEntries(stripHtml(html));
}

const NEG_INF = Number.NEGATIVE_INFINITY;

/** 时间串 → epoch ms；缺失/非法用 fallback（避免 NaN 参与比较，排序结果才稳定） */
function timeOr(iso: string | null, fallback: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

/** 按开始时间倒序取最近 MAX_ENTRIES 条（时间缺失的排最后，不会被当成「最近」） */
export function pickRecentEntries(entries: NteHistoryEntry[], limit = MAX_ENTRIES): NteHistoryEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    // 同起点时用终点兜底，再不行用页面前后顺序，保证输出稳定
    .sort((a, b) => {
      const sa = timeOr(a.e.start_at, NEG_INF);
      const sb = timeOr(b.e.start_at, NEG_INF);
      if (sa !== sb) return sb - sa;
      const ea = timeOr(a.e.end_at, NEG_INF);
      const eb = timeOr(b.e.end_at, NEG_INF);
      if (ea !== eb) return eb - ea;
      return a.i - b.i;
    })
    .slice(0, limit)
    .map((x) => x.e);
}

/** 读页面（离线只读缓存）→ 条目；失败返回 [] 并打日志 */
async function loadEntries(ctx: SourceContext): Promise<NteHistoryEntry[]> {
  const html = await withSourceCache<string>(ctx, NTE_HISTORY_CACHE_ID, () => fetchText(BANNERS_URL));
  if (typeof html !== 'string' || html.trim() === '') {
    ctx.log('[source:nte-history] 页面不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const entries = parseNteHistoryHtml(html);
  if (entries.length === 0) {
    ctx.log('[source:nte-history] 未解析出历史卡池条目（页面结构可能已变化）');
    return [];
  }
  ctx.log(`[source:nte-history] 解析出 ${entries.length} 条历史卡池，取最近 ${Math.min(entries.length, MAX_ENTRIES)} 条`);
  return entries;
}

/** 条目 → PoolCandidate（pool_type='pact'；published_at 留空 = 不设置） */
export function entryToCandidate(entry: NteHistoryEntry, ctx: SourceContext): PoolCandidate {
  const notes: string[] = [NOTE];
  if (entry.latinOnly) notes.push('页面未给中文名，暂用英文名');
  if (!entry.start_at || !entry.end_at) notes.push('起止日期不可解析');
  return {
    game_key: 'yh',
    pool_name: entry.cn,
    pool_type: 'pact',
    characters: [entry.cn],
    start_at: entry.start_at,
    end_at: entry.end_at,
    version: entry.version,
    period: entry.stage ? `${entry.version} ${entry.stage}` : entry.version,
    evidence: entry.evidence,
    note: notes.join('；'),
    source: {
      id: SOURCE_ID,
      tier: 'L3',
      url: BANNERS_URL,
      fetched_at: ctx.nowCst,
    },
  };
}

/** 抓取并解析出候选池；失败返回 []（不得编造数据） */
export async function collectNteHistory(ctx: SourceContext): Promise<PoolCandidate[]> {
  const entries = await loadEntries(ctx);
  if (entries.length === 0) return [];
  return pickRecentEntries(entries).map((e) => entryToCandidate(e, ctx));
}

/** 角色名单：页面上出现过的中文名/英文名（含早期版本），供 resolver 做 yh 角色名校验 */
export async function collectNteHistoryRoster(ctx: SourceContext): Promise<CharacterBookEntry[]> {
  const entries = await loadEntries(ctx);
  const book = new Map<string, CharacterBookEntry>();
  for (const entry of entries) {
    if (!entry.cn) continue;
    const existed = book.get(entry.cn);
    if (!existed) {
      book.set(entry.cn, {
        game_key: 'yh',
        cn: entry.cn,
        en: entry.en,
        aliases: [],
      });
    } else if (!existed.en && entry.en) {
      existed.en = entry.en; // 同一角色在别的条目里补齐了英文名
    }
  }
  return [...book.values()];
}

export const nteHistoryAdapter: SourceAdapter = {
  id: SOURCE_ID,
  tier: 'L3',
  label: '异环 nteguide 历史卡池',
  games: ['yh'],
  collect: collectNteHistory,
  roster: collectNteHistoryRoster,
};

export default nteHistoryAdapter;
