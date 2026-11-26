// 异环官网公告适配器（id: nte-site，tier L0，games: ['yh']）。
// 数据源（服务端渲染 HTML，无 JSON 接口）：
//   列表 https://nte.perfectworld.com/cn/article/news/gamenews/index.html（公告，每页 3 条，可再翻 1 页）
//        https://nte.perfectworld.com/cn/article/news/index.html（最新，注意路径不带分类段）
//        https://nte.perfectworld.com/cn/article/news/gameevent/index.html（活动）
//   正文 https://nte.perfectworld.com/cn/article/news/<分类>/<YYYYMMDD>/<id>.html
// 已知情况：官网列表页会滞后（实测「公告」最新只到 2026-11-09），因此采集端**不做「已结束就丢弃」的过滤**，
// 解析到什么就给什么（由 resolver 判 status）；正文页取不到就跳过，不影响其它篇。
// 站点口径：异环把角色卡池叫「限定棋盘」，官方文案里没有「协定」二字；按契约 q3 统一归到 pool_type='pact'。
// 解析口径（都只认原文，不猜）：
//   · 池名：一枚「● …限定S级角色「Y」…」条目块内的「可通过「X」限定棋盘」或「「X」限定棋盘」；
//   · 角色：同一块内所有「(全新)限定S级角色「Y」」，返场/复刻只写进 note（不擅自改成 rerun_character，保持 pact 一致性）；
//   · 时间：「开放时间：M月D日版本更新后-…HH:mm(UTC+8)」的起点用**同篇**「(更新)维护时间：YYYY年MM月DD日 HH:mm - HH:mm」
//     的结束时刻锚定（异环的「版本更新后」等价于维护结束）；同篇没有同日维护窗口时 start_at = null（不近似）；
//     终点必须能解析出绝对时间，否则 null；
//   · 「※当期…「X」限定棋盘将于…结束」用于给更早公告里那期棋盘补 end_at（若该池不在本次正文窗口内则忽略）。
// 时间一律东八区 ISO（+08:00）；网络失败返回 [] 并打日志，绝不编造。
import { fetchText, stripHtml, withSourceCache } from '../http.ts';
import type { CharacterBookEntry, PoolCandidate, SourceAdapter, SourceContext } from '../../pools/types.ts';

/** 站点根 */
const SITE = 'https://nte.perfectworld.com';
/** 缓存 id 前缀：本适配器所有缓存文件都是 nte-site*.json */
const CACHE_ID = 'nte-site';
/** 三个列表页（契约任务口径：公告 / 新闻 / 活动） */
const LIST_CATEGORIES = ['gamenews', 'news', 'gameevent'] as const;
/** 每个列表最多翻几页（首页 + 再翻 1 页） */
const MAX_PAGES = 2;
/** 每次采集最多解析的正文篇数 */
const MAX_ARTICLES = 12;
/** 单个正文块最多向后看多少行 */
const MAX_BLOCK_LINES = 24;
/** 东八区固定偏移（禁止依赖进程时区） */
const CST_OFFSET_MS = 8 * 3_600_000;

/** epoch ms → 东八区 ISO（+08:00） */
function cstIso(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/** 按东八区钟面时间构造 ISO（+08:00） */
function cstFromParts(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return cstIso(Date.UTC(y, mo - 1, d, h, mi) - CST_OFFSET_MS);
}

/** 东八区 ISO → 年月日（用于给无年份日期补年） */
function cstYmd(iso: string | null): { y: number; mo: number; d: number } | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

/** 无年份日期补年：月份早于参照月视为跨年（如 12 月起、次年 1 月止） */
function pickYear(month: number, ref: { y: number; mo: number }): number {
  return month < ref.mo ? ref.y + 1 : ref.y;
}

/** 公告正文压成按行文本（stripHtml 保留段落换行） */
function toLines(html: string): string[] {
  return stripHtml(html)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ————————————————————————— 列表页 —————————————————————————

/** 列表页条目（一条公告/新闻/活动） */
export interface NteListItem {
  /** /cn/article/news/gamenews/20261109/264946.html */
  path: string;
  url: string;
  /** 正文 id（264946） */
  articleId: string;
  category: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
}

/** 条目链接 + 紧随其后的标题/日期区块（站点版式：<a href=…><div class="listItem">…</div></a>） */
const LIST_ITEM_RE = /href="(\/cn\/article\/news\/([a-z]+)\/(\d{8})\/(\d+)\.html)"([\s\S]*?)(?=href="\/cn\/article\/news\/[a-z]+\/\d{8}\/\d+\.html"|$)/g;

/** 20261109 → 2026-11-09 */
function dateFromPath(yyyymmdd: string): string {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}

/** 解析列表页 HTML（服务端渲染，含标题 / 日期 / 链接） */
export function parseNteListHtml(html: string): NteListItem[] {
  const out: NteListItem[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(LIST_ITEM_RE)) {
    const path = m[1];
    if (seen.has(path)) continue;
    const category = m[2];
    const yyyymmdd = m[3];
    const articleId = m[4];
    const tail = m[5] ?? '';
    const titleM = tail.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const dateM = tail.match(/<p[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const title = stripHtml(titleM?.[1] ?? '').replace(/\n/g, ' ').trim();
    const listed = (dateM?.[1] ?? '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(listed) ? listed : dateFromPath(yyyymmdd);
    seen.add(path);
    out.push({
      path: path,
      url: SITE + path,
      articleId: articleId,
      category: category,
      date: date,
      title: title,
    });
  }
  return out;
}

/** 列表排序：日期倒序，同日按正文 id 倒序（站点 id 单调递增，等同于发布先后） */
function compareItems(a: NteListItem, b: NteListItem): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ai = Number(a.articleId);
  const bi = Number(b.articleId);
  if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return bi - ai;
  return a.path < b.path ? 1 : -1;
}

// ————————————————————————— 正文页 —————————————————————————

/** 同篇公告的维护窗口（异环「版本更新后」的绝对锚点） */
export interface NteMaintenanceWindow {
  year: number;
  month: number;
  day: number;
  /** 维护结束时刻（东八区 ISO） */
  endIso: string;
  /** 原文片段，写进 note 留痕 */
  raw: string;
}

/** 「※当期X「池名」限定棋盘将于YYYY年M月D日 HH:mm(UTC+8)结束」 */
export interface NteStaleEnd {
  pool_name: string;
  /** 结束时刻（东八区 ISO） */
  end_at: string;
  raw: string;
  article_id: string;
  published_at: string | null;
}

/** 契约外附加字段：列表页日期 → 当天 12:00(+08:00) */
export interface NteSitePool extends PoolCandidate {
  published_at: string | null;
}

/** 一篇正文页的解析结果 */
export interface NteArticleParse {
  title: string;
  published_at: string | null;
  pools: NteSitePool[];
  staleEnds: NteStaleEnd[];
  /** 正文/标题里出现的「限定S级角色「Y」」名单（给 roster 用） */
  rosterNames: string[];
}

/** ● 更新维护时间：2026年11月11日06:00 - 11:00(UTC+8) / ● 维护时间：2026年10月21日 06:00 - 11:00(UTC+8) */
const MAINT_RE =
  /(?:更新)?维护时间\s*[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～]\s*(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(?:(\d{1,2})\s*日\s*)?(\d{1,2})\s*[:：]\s*(\d{2})/;

/** 找同篇公告的维护窗口；取不到返回 null（此时「版本更新后」没有锚点） */
export function findNteMaintenance(lines: string[]): NteMaintenanceWindow | null {
  for (const line of lines) {
    const m = line.match(MAINT_RE);
    if (!m) continue;
    const year = +m[1];
    const month = +m[2];
    const day = +m[3];
    const endYear = m[6] ? +m[6] : year;
    const endMonth = m[7] ? +m[7] : month;
    const endDay = m[8] ? +m[8] : day;
    const endIso = cstFromParts(endYear, endMonth, endDay, +m[9], +m[10]);
    return { year: year, month: month, day: day, endIso: endIso, raw: m[0].trim() };
  }
  return null;
}

/** 池名：优先「可通过「X」限定棋盘」，其次「「X」限定棋盘」/「限定棋盘「X」」 */
export function findNtePoolName(block: string[]): string | null {
  // ※ 行是「上一期」的结束说明，不是本块的池名
  const usable = block.filter((l) => l.indexOf('※') !== 0);
  const text = usable.join('\n');
  const via = text.match(/可通过\s*「([^」]{1,25})」\s*限定棋盘/);
  if (via) return via[1].trim();
  const plain = text.match(/「([^」]{1,25})」\s*限定棋盘/);
  if (plain) return plain[1].trim();
  const reversed = text.match(/限定棋盘\s*「([^」]{1,25})」/);
  if (reversed) return reversed[1].trim();
  return null;
}

/** 「更新维护后 / 版本更新后 / 维护后 / 开服后」这类相对起点 */
const RELATIVE_START_RE = /(版本更新后|维护更新后|更新维护后|维护完成后|维护后|更新后|开服后)/;

/** 拆「A-B」区间（兼容 - – — ~ ～ 与两侧空格） */
function splitNteRange(text: string): { left: string; right: string } | null {
  const m = text.match(/^(.*?)\s*(?:[-–—~～])\s*(.*)$/);
  if (!m) return null;
  const left = m[1].trim();
  const right = m[2].trim();
  if (!left || !right) return null;
  return { left: left, right: right };
}

/** 去掉日期串尾部的时区标注，便于解析 */
function stripTz(text: string): string {
  return text.replace(/[（(]\s*(UTC\s*\+?8|服务器时间|北京时间)\s*[）)]/g, '').trim();
}

/** 绝对时间：2026年12月2日05:59 / 12月2日05:59 */
const ABS_TIME_RE = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/;

/** 解析无年份日期里的月日（用于维护锚点匹配） */
function monthDayOf(text: string): { mo: number; d: number } | null {
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  return { mo: +m[1], d: +m[2] };
}

/** 「※当期…「X」限定棋盘将于…结束」→ 上一期的 end_at 线索 */
export function findNteStaleEnds(lines: string[], meta: { articleId: string; publishedAt: string | null }): NteStaleEnd[] {
  const out: NteStaleEnd[] = [];
  const re =
    /※[^\n]{0,24}?「([^」]{1,25})」\s*限定棋盘\s*(?:将)?于\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})[^\n]{0,8}结束/g;
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const name = m[1].trim();
      if (!name) continue;
      if (out.some((s) => s.pool_name === name)) continue;
      out.push({
        pool_name: name,
        end_at: cstFromParts(+m[2], +m[3], +m[4], +m[5], +m[6]),
        raw: line.slice(0, 160),
        article_id: meta.articleId,
        published_at: meta.publishedAt,
      });
    }
  }
  return out;
}

/** 从正文块里取「限定S级角色「Y」」名单 */
function charactersInBlock(block: string[]): string[] {
  const out: string[] = [];
  for (const line of block) {
    for (const m of line.matchAll(/(?:全新)?限定S级角色「([^」]{1,20})」/g)) {
      const name = m[1].trim();
      if (name && out.indexOf(name) < 0) out.push(name);
    }
  }
  return out;
}

/** 正文块 → 候选池；块里没有池名/角色/时间线索时返回 null（不产出空池） */
function buildPoolFromBlock(
  block: string[],
  meta: {
    item: NteListItem;
    title: string;
    publishedAt: string | null;
    version: string | null;
    maintenance: NteMaintenanceWindow | null;
    fetchedAt: string;
  },
): NteSitePool | null {
  const header = block[0] ?? '';
  if (header.indexOf('限定S级角色') < 0) return null;
  const poolName = findNtePoolName(block);
  if (!poolName) return null;
  const characters = charactersInBlock(block);
  if (characters.length === 0) return null;

  const openLine = block.find((l) => /(开放时间|开启时间)[：:]/.test(l)) ?? '';
  const openRaw = openLine.replace(/^.*?(开放时间|开启时间)[：:]\s*/, '').trim();
  const range = openRaw ? splitNteRange(openRaw) : null;
  const leftRaw = range ? stripTz(range.left) : '';
  const rightRaw = range ? stripTz(range.right) : '';
  const leftMd = monthDayOf(leftRaw);
  const pubYmd = meta.item.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const pubYear = pubYmd ? +pubYmd[1] : 1970;
  const pubMonth = pubYmd ? +pubYmd[2] : 1;
  const maint = meta.maintenance;

  const noteParts: string[] = ['官网公告 ' + meta.item.articleId];
  if (/返场|复刻/.test(header)) noteParts.push('返场/复刻（官方原文含「返场」）');
  else if (/全新/.test(header)) noteParts.push('全新限定棋盘');

  // —— 起点 ——
  let startAt: string | null = null;
  const absLeft = leftRaw.match(ABS_TIME_RE);
  if (absLeft && !RELATIVE_START_RE.test(leftRaw)) {
    const mo = +absLeft[2];
    const ref = { y: leftMd && maint && leftMd.mo === maint.month ? maint.year : pubYear, mo: pubMonth };
    startAt = cstFromParts(absLeft[1] ? +absLeft[1] : pickYear(mo, ref), mo, +absLeft[3], +absLeft[4], +absLeft[5]);
    noteParts.push('start 取原文绝对时间「' + leftRaw + '」');
  } else if (RELATIVE_START_RE.test(leftRaw)) {
    const relative = leftRaw.match(RELATIVE_START_RE)?.[1] ?? '版本更新后';
    if (maint && leftMd && leftMd.mo === maint.month && leftMd.d === maint.day) {
      // 「M月D日版本更新后」+ 同篇同日维护窗口 → 起点 = 维护结束时刻（异环的实际开池时刻）
      startAt = maint.endIso;
      noteParts.push('start 由同篇维护结束时刻锚定（' + maint.raw + '）');
    } else if (maint && !leftMd) {
      startAt = maint.endIso;
      noteParts.push('start 由同篇维护结束时刻锚定（' + maint.raw + '）');
    } else {
      noteParts.push('原文「' + leftRaw + '」为相对起点「' + relative + '」且同篇无同日维护窗口，start_at=null');
    }
  } else if (openRaw) {
    noteParts.push('开放时间「' + openRaw + '」无起点，start_at=null');
  } else {
    noteParts.push('公告未给出该池开放时间，start_at=null');
  }

  // —— 终点 ——
  let endAt: string | null = null;
  const absRight = rightRaw.match(ABS_TIME_RE);
  if (absRight) {
    const mo = +absRight[2];
    const refMonth = leftMd ? leftMd.mo : maint ? maint.month : pubMonth;
    const year = absRight[1] ? +absRight[1] : pickYear(mo, { y: maint ? maint.year : pubYear, mo: refMonth });
    endAt = cstFromParts(year, mo, +absRight[3], +absRight[4], +absRight[5]);
    noteParts.push('end 取原文绝对时间「' + rightRaw + '」');
  } else if (openRaw) {
    noteParts.push('终点「' + rightRaw + '」无法解析为绝对时间，end_at=null');
  }

  if (openRaw) noteParts.push('原文开放时间「' + openRaw + '」');

  const evidenceParts = [meta.title, header, openLine, block.find((l) => l.indexOf('棋盘说明') === 0) ?? '']
    .filter((s) => !!s)
    .map((s) => s.trim());
  const evidence = evidenceParts.join(' | ').slice(0, 200);

  return {
    game_key: 'yh',
    pool_name: poolName,
    pool_type: 'pact',
    characters: characters,
    start_at: startAt,
    end_at: endAt,
    version: meta.version,
    period: null,
    evidence: evidence || null,
    note: noteParts.join('；'),
    source: {
      id: CACHE_ID,
      tier: 'L0',
      url: meta.item.url,
      fetched_at: meta.fetchedAt,
    },
    published_at: meta.publishedAt,
  };
}

/** 解析一篇正文页 HTML */
export function parseNteArticleHtml(html: string, item: NteListItem, fetchedAt?: string): NteArticleParse {
  const lines = toLines(html);
  const titleM = html.match(/<h1[^>]*class="[^"]*articleTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = (titleM ? stripHtml(titleM[1]).replace(/\n/g, ' ').trim() : '') || item.title;
  const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date + 'T12:00:00+08:00' : null;
  const maintenance = findNteMaintenance(lines);
  const version = (title.match(/(\d+\.\d+)\s*版本/) ?? lines.join('\n').match(/(\d+\.\d+)\s*版本更新后/))?.[1] ?? null;
  const meta = {
    item: item,
    title: title,
    publishedAt: publishedAt,
    version: version,
    maintenance: maintenance,
    fetchedAt: fetchedAt ?? '',
  };

  const pools: NteSitePool[] = [];
  for (let i = 0; i < lines.length; i++) {
    // 条目块以「●」起头且含「限定S级角色」；下一块起头（●/◆/【）即结束
    if (!/^[●·•]/.test(lines[i]) || lines[i].indexOf('限定S级角色') < 0) continue;
    const block: string[] = [lines[i]];
    for (let j = i + 1; j < lines.length && block.length < MAX_BLOCK_LINES; j++) {
      if (/^[●◆【]/.test(lines[j])) break;
      block.push(lines[j]);
    }
    const cand = buildPoolFromBlock(block, meta);
    if (cand) pools.push(cand);
  }

  const rosterNames: string[] = [];
  const rosterSource = [title, ...lines].join('\n');
  for (const m of rosterSource.matchAll(/(?:全新)?限定S级角色「([^」]{1,20})」/g)) {
    const name = m[1].trim();
    if (name && rosterNames.indexOf(name) < 0) rosterNames.push(name);
  }

  return {
    title: title,
    published_at: publishedAt,
    pools: pools,
    staleEnds: findNteStaleEnds(lines, { articleId: item.articleId, publishedAt: publishedAt }),
    rosterNames: rosterNames,
  };
}

// ————————————————————————— 合并 / 补 end —————————————————————————

/** 同名棋盘合并（多个公告重复提到同一期时补齐字段，不重复出池） */
export function mergeNtePools(pools: NteSitePool[]): NteSitePool[] {
  const out: NteSitePool[] = [];
  const byName = new Map<string, NteSitePool>();
  for (const p of pools) {
    const hit = byName.get(p.pool_name);
    if (!hit) {
      byName.set(p.pool_name, p);
      out.push(p);
      continue;
    }
    if (!hit.start_at && p.start_at) hit.start_at = p.start_at;
    if (!hit.end_at && p.end_at) hit.end_at = p.end_at;
    if (!hit.version && p.version) hit.version = p.version;
    for (const c of p.characters) if (hit.characters.indexOf(c) < 0) hit.characters.push(c);
    hit.note = [hit.note, p.note].filter((s) => !!s).join('；');
  }
  return out;
}

/**
 * 用更晚公告的「※当期…限定棋盘将于…结束」补齐上一期的 end_at：
 * 池不在本次正文窗口内 → 忽略；已有 end_at 且一致 → 只在 note 留痕；不一致 → 保留原文值并打日志。
 */
export function applyNteStaleEnds(
  pools: NteSitePool[],
  staleEnds: NteStaleEnd[],
  log?: (...args: any[]) => void,
): void {
  const sorted = staleEnds
    .slice()
    .sort((a, b) => String(a.published_at ?? '').localeCompare(String(b.published_at ?? '')));
  for (const stale of sorted) {
    const target = pools.find((p) => p.pool_name === stale.pool_name);
    if (!target) {
      if (log) log('[source:nte-site] ※ 行提到的「' + stale.pool_name + '」限定棋盘不在本次正文窗口内，忽略（' + stale.end_at + '）');
      continue;
    }
    const tail = '；※ 行（公告 ' + stale.article_id + '）给出上期结束 ' + stale.end_at;
    if (!target.end_at) {
      target.end_at = stale.end_at;
      target.note = [target.note, 'end_at 补自更晚公告的 ※ 行（' + stale.end_at + '）'].filter((s) => !!s).join('；');
      continue;
    }
    if (target.end_at === stale.end_at) {
      target.note = [target.note, 'end_at 与更晚公告 ※ 行一致'].filter((s) => !!s).join('；');
      continue;
    }
    if (log) {
      log('[source:nte-site] 「' + stale.pool_name + '」end_at 冲突：正文 ' + target.end_at + ' vs ※ 行 ' + stale.end_at + '，保留正文值');
    }
    target.note = [target.note, tail + '（与正文不一致，保留正文值）'].filter((s) => !!s).join('；');
  }
}

// ————————————————————————— 抓取 —————————————————————————

/** 进程内 HTML 记忆（避免 collect 与 roster 重复请求同一页；按缓存目录隔离，测试可用不同目录） */
const htmlMemo = new Map<string, { url: string; html: string }>();

/** 取一页 HTML：在线抓取并写缓存，离线只读缓存；拿不到返回 null（绝不编造） */
async function loadHtml(ctx: SourceContext, cacheId: string, url: string): Promise<string | null> {
  const memoKey = ctx.cacheDir + '|' + cacheId;
  const hit = htmlMemo.get(memoKey);
  if (hit && typeof hit.html === 'string' && hit.html.length > 0) return hit.html;
  const payload = await withSourceCache<{ url: string; html: string }>(ctx, cacheId, async () => ({
    url: url,
    html: await fetchText(url),
  }));
  if (!payload || typeof payload.html !== 'string' || payload.html.length === 0) {
    ctx.log('[source:nte-site] ' + cacheId + ' 不可用（离线且无缓存或请求失败）');
    return null;
  }
  htmlMemo.set(memoKey, payload);
  return payload.html;
}

/**
 * 列表页 URL：第 1 页 index.html，第 2 页 index1.html（站点分页规则）。
 * 注意「最新」页的路径不带分类段（/cn/article/news/index.html），
 * 而 /cn/article/news/news/index.html 是 404 —— 两个路径只差一段，很容易写错。
 */
function listUrl(category: string, pageIndex: number): string {
  const file = pageIndex === 0 ? 'index.html' : 'index' + pageIndex + '.html';
  const base = category === 'news' ? SITE + '/cn/article/news/' : SITE + '/cn/article/news/' + category + '/';
  return base + file;
}

/** 抓三个列表页（各翻 1 页）并去重 */
async function loadListItems(ctx: SourceContext): Promise<NteListItem[]> {
  const items: NteListItem[] = [];
  const seen = new Set<string>();
  for (const category of LIST_CATEGORIES) {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const cacheId = pageIndex === 0 ? CACHE_ID + '-list-' + category : CACHE_ID + '-list-' + category + '-' + (pageIndex + 1);
      const html = await loadHtml(ctx, cacheId, listUrl(category, pageIndex));
      if (!html) continue;
      for (const item of parseNteListHtml(html)) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        items.push(item);
      }
    }
  }
  return items;
}

interface LoadedArticle {
  item: NteListItem;
  parsed: NteArticleParse;
}

/** 列表 → 最新 12 篇正文 → 解析结果（正文取不到的跳过并打日志） */
async function loadArticles(ctx: SourceContext): Promise<LoadedArticle[]> {
  const items = await loadListItems(ctx);
  if (items.length === 0) {
    ctx.log('[source:nte-site] 列表页不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const picked = items.slice().sort(compareItems).slice(0, MAX_ARTICLES);
  const out: LoadedArticle[] = [];
  for (const item of picked) {
    const html = await loadHtml(ctx, CACHE_ID + '-article-' + item.articleId, item.url);
    if (!html) {
      ctx.log('[source:nte-site] 正文 ' + item.path + ' 不可用（离线无缓存或请求失败），跳过');
      continue;
    }
    out.push({ item: item, parsed: parseNteArticleHtml(html, item, ctx.nowCst) });
  }
  return out;
}

/** 采集入口：三列表 → 最新 12 篇正文 → pact 候选池 */
export async function collectNteSite(ctx: SourceContext): Promise<PoolCandidate[]> {
  const articles = await loadArticles(ctx);
  if (articles.length === 0) {
    ctx.log('[source:nte-site] 未取到任何公告正文，返回空');
    return [];
  }
  const pools: NteSitePool[] = [];
  const staleEnds: NteStaleEnd[] = [];
  for (const art of articles) {
    pools.push(...art.parsed.pools);
    staleEnds.push(...art.parsed.staleEnds);
  }
  if (pools.length === 0) {
    ctx.log('[source:nte-site] 正文里未解析出限定棋盘（pact）卡池');
    return [];
  }
  const merged = mergeNtePools(pools);
  applyNteStaleEnds(merged, staleEnds, ctx.log);
  // 新公告在前；同公告内按起点倒序，保证输出稳定
  merged.sort((a, b) => {
    const byPub = String(b.published_at ?? '').localeCompare(String(a.published_at ?? ''));
    if (byPub !== 0) return byPub;
    return String(b.start_at ?? '').localeCompare(String(a.start_at ?? ''));
  });
  ctx.log('[source:nte-site] 解析出 ' + merged.length + ' 个限定棋盘候选：' + merged.map((p) => p.pool_name).join('、'));
  return merged;
}

/** 角色名单：正文/标题里的「限定S级角色「Y」」→ yh 角色字典条目（补全 roster 覆盖） */
export async function collectNteSiteRoster(ctx: SourceContext): Promise<CharacterBookEntry[]> {
  const articles = await loadArticles(ctx);
  const names: string[] = [];
  for (const art of articles) {
    for (const name of art.parsed.rosterNames) {
      if (names.indexOf(name) < 0) names.push(name);
    }
  }
  if (names.length === 0) {
    ctx.log('[source:nte-site] 正文里未取到「限定S级角色」，roster 返回空');
    return [];
  }
  return names.map((cn) => ({ game_key: 'yh', cn: cn }));
}

export const nteSiteAdapter: SourceAdapter = {
  id: 'nte-site',
  tier: 'L0',
  label: '异环官网公告',
  games: ['yh'],
  collect: collectNteSite,
  roster: collectNteSiteRoster,
};

export default nteSiteAdapter;
