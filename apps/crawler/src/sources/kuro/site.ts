// 鸣潮官网公告适配器（id: kuro-site，tier L0，games: ['wutheringwaves']）。
// 数据源：
//   列表 https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/ArticleMenu.json
//   正文 https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/article/<articleId>.json
// 列表接口里的 articleContent 只有十几字符的截断摘要，正文必须按 articleId 二次拉取；
// 正文缓存 id 形如 kuro-site-article-1659。离线（ctx.offline）只读已缓存正文，缺失则跳过并打日志。
// 解析口径：
//   · 池名/类型：「[池名]角色活动唤取」「「武器」武器活动唤取」「[池名]忆旅唤取」以及「[A]、[B]角色活动唤取」列表式；
//   · 角色名：只在正文出现「5星角色「X」」/「5星共鸣者「X」」时提取，武器池一律不带角色；
//   · 时间：一律东八区 ISO（+08:00）；「N.N版本更新后」这类相对起点没有绝对锚点 → start_at = null，
//     同篇公告的维护窗口只写进 note 留痕（不猜、不回填）。
import { fetchJson, stripHtml, withSourceCache } from '../http.ts';
import type { PoolCandidate, PoolType, SourceAdapter, SourceContext } from '../../pools/types.ts';

const MENU_URL = 'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/ArticleMenu.json';
const ARTICLE_URL = 'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/article';
/** 单次采集最多展开的公告数（列表里同类公告很多，只取最新几篇） */
const MAX_ARTICLES = 5;
const MAX_POOLS_PER_ARTICLE = 12;
/** 东八区固定偏移（禁止依赖进程时区） */
const CST_OFFSET_MS = 8 * 3_600_000;

/** epoch ms → 东八区 ISO（+08:00） */
function cstIso(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/** 按给定时区（默认 +8）的钟面时间构造东八区 ISO；日服 +9、UTC-7 传对应偏移 */
function cstFromParts(y: number, mo: number, d: number, h = 0, mi = 0, offsetHours = 8): string {
  return cstIso(Date.UTC(y, mo - 1, d, h, mi) - offsetHours * 3_600_000);
}

/** 列表/正文里的单篇公告（只声明用到的字段） */
export interface KuroArticleLike {
  articleId: number | string;
  articleTitle?: string;
  articleType?: number;
  startTime?: string;
  endTime?: string;
  articleContent?: string;
}

export interface KuroParseMeta {
  articleId: number | string;
  title?: string;
  url?: string | null;
  fetchedAt?: string;
}

/** 公告正文压成按行文本（stripHtml 保留段落换行） */
function toLines(html: string): string[] {
  return stripHtml(html)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 池名后缀 → pool_type */
function poolTypeOfSuffix(suffix: string): PoolType | null {
  if (suffix.indexOf('武器') >= 0) return 'weapon';
  if (suffix.indexOf('忆旅') >= 0) return 'rerun_character';
  if (suffix.indexOf('角色') >= 0) return 'limited_character';
  return null;
}

/** 把「A ~ B」区间拆两半（兼容 ~ ～ 与两侧带空格的短横线） */
function splitRange(text: string): { left: string; right: string } | null {
  const m = text.match(/^(.*?)(?:[~～]|\s[-—]\s)(.*)$/);
  if (!m) return null;
  const left = m[1].trim();
  const right = m[2].trim();
  if (!left || !right) return null;
  return { left, right };
}

/** 抽绝对时间：2026年12月3日09:59 */
function parseAbsoluteCst(text: string): string | null {
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return null;
  return cstFromParts(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

/** 同篇公告里的维护窗口结束时刻（「版本更新后」的绝对锚点，ISO 或 null） */
function findMaintenanceEnd(text: string): string | null {
  const m = text.match(
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})[^0-9]{0,8}[~～]\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
  );
  if (!m) return null;
  const y2 = m[6] ? +m[6] : +m[1];
  return cstFromParts(y2, +m[7], +m[8], +m[9], +m[10]);
}

/** 同篇公告里的维护窗口（只用于 note 留痕） */
function findMaintenanceWindow(text: string): string | null {
  const m = text.match(
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})[^0-9]{0,8}[~～]\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
  );
  if (!m) return null;
  const y1 = +m[1];
  const start = cstFromParts(y1, +m[2], +m[3], +m[4], +m[5]);
  const y2 = m[6] ? +m[6] : y1;
  const end = cstFromParts(y2, +m[7], +m[8], +m[9], +m[10]);
  return start + ' ~ ' + end;
}

interface TimeRange {
  start: string | null;
  end: string | null;
  startRaw: string;
  endRaw: string;
}

/** 在正文里找「活动时间 / 开放时间 / 唤取时间」后面的区间 */
function findTimeRange(lines: string[]): TimeRange | null {
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(/(活动时间|开放时间|唤取时间|建造时间)/);
    if (!label) continue;
    // 区间可能在同一行（✦活动时间：A ~ B），也可能在下一行（✦活动时间✦ / A ~ B）
    const from = (label.index ?? 0) + label[0].length;
    const candidates = [lines[i].slice(from), lines[i + 1] ?? ''];
    for (let ci = 0; ci < candidates.length; ci++) {
      const cleaned = candidates[ci]
        .replace(/^[✦\s:：]+/, '')
        .replace(/[（(]\s*(服务器时间|UTC\+?8|東八区)\s*[）)]/g, '')
        .trim();
      const pair = splitRange(cleaned);
      if (!pair) continue;
      if (!/\d{1,2}\s*[:：]\s*\d{2}/.test(pair.right)) continue;
      return {
        start: parseAbsoluteCst(pair.left),
        end: parseAbsoluteCst(pair.right),
        startRaw: pair.left,
        endRaw: pair.right,
      };
    }
  }
  return null;
}

interface PoolToken {
  name: string;
  suffix: string;
}

/** 从一行里扫出「池名 + 唤取类型」；列表式（[A]、[B]角色活动唤取）优先于单个式 */
function scanPoolTokens(line: string): PoolToken[] {
  const tokens: PoolToken[] = [];
  const taken: Array<[number, number]> = [];
  const listRe = /((?:[\[<][^\[\]<>]{1,40}[\]>]\s*(?:、|,|，|和|与)?\s*)+)(角色活动唤取|武器活动唤取|忆旅唤取)/g;
  for (const m of line.matchAll(listRe)) {
    const idx = m.index ?? 0;
    for (const n of m[1].matchAll(/[\[<]([^\[\]<>]{1,40})[\]>]/g)) {
      const name = n[1].trim();
      if (name) tokens.push({ name: name, suffix: m[2] });
    }
    taken.push([idx, idx + m[0].length]);
  }
  const singleRe = /(?:[\[<]([^\[\]<>]{1,40})[\]>]|「([^「」]{1,40})」)\s*(角色活动唤取|武器活动唤取|忆旅唤取)/g;
  for (const m of line.matchAll(singleRe)) {
    const idx = m.index ?? 0;
    if (taken.some((r) => idx >= r[0] && idx < r[1])) continue;
    const name = (m[1] ?? m[2] ?? '').trim();
    if (!name) continue;
    // 「[角色/武器活动唤取・第一期]」这类分组标题不是池名
    if (name.indexOf('/') >= 0 || name.indexOf('唤取') >= 0) continue;
    tokens.push({ name: name, suffix: m[3] });
  }
  return tokens;
}

/** 5星角色名（只在「概率限时提升 / 概率UP」句子里取，避免把常驻名单当 UP） */
function upFiveStarNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!/(概率限时提升|概率UP|概率提升)/.test(line)) continue;
    for (const m of line.matchAll(/5星(?:角色|共鸣者)「([^」]{1,20})」/g)) out.push(m[1].trim());
  }
  return out;
}

/**
 * 版本说明式：池名那一行前后窗口里的 5星角色/共鸣者。
 * 鸣潮角色活动唤取的 UP 只有 1 个，因此只取「离池名最近」的那一个，避免把常驻名单串进来。
 */
function nearbyFiveStarNames(lines: string[], idx: number): string[] {
  const grab = (line: string): string | null => {
    const m = line.match(/5星(?:角色|共鸣者)「([^」]{1,20})」/);
    return m ? m[1].trim() : null;
  };
  for (let i = idx; i >= Math.max(0, idx - 6); i--) {
    const name = grab(lines[i]);
    if (name) return [name];
  }
  for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 2); i++) {
    const name = grab(lines[i]);
    if (name) return [name];
  }
  return [];
}

/** 标题里的单池公告：[浮声沉兵]武器活动唤取——「诸方玄枢」概率UP */
function parseTitlePool(title: string): PoolToken | null {
  const bracket = title.match(/[\[<「]([^\[\]<>「」]{1,40})[\]>」]\s*(角色活动唤取|武器活动唤取|忆旅唤取)/);
  if (bracket) {
    const name = bracket[1].trim();
    if (name.indexOf('/') < 0 && name.indexOf('唤取') < 0) return { name: name, suffix: bracket[2] };
  }
  const loose = title.match(/(角色|武器|忆旅)活动唤取[—\-–~～:：\s]*「([^「」]{1,40})」/);
  if (loose) return { name: loose[2].trim(), suffix: loose[1] + '活动唤取' };
  return null;
}

const POOLY_TITLE_RE = /(角色|武器)活动唤取|忆旅唤取/;
const VERSION_NOTES_TITLE_RE = /版本内容说明/;

/**
 * 解析一篇鸣潮公告正文，产出池候选。
 * 两种版式都支持：单池公告（标题即池名，正文给活动时间）与版本说明（正文「※可通过[池名]角色活动唤取获得」）。
 */
export function parseKuroArticleText(text: string, meta: KuroParseMeta): PoolCandidate[] {
  const lines = toLines(text);
  const plain = lines.join('\n');
  const title = meta.title ?? '';
  const version = (title.match(/(\d+\.\d+)\s*版本/) ?? plain.match(/(\d+\.\d+)\s*版本更新后/))?.[1] ?? null;
  const periodMatch = (title + '\n' + plain).match(/活动唤取[・·]\s*第([一二三四五六七八九十百\d]+)\s*期/);
  const period = periodMatch ? '第' + periodMatch[1] + '期' : null;
  const range = findTimeRange(lines);
  const maintenance = findMaintenanceWindow(plain);
  // 「3.8版本更新后 ~ 2026年12月3日09:59」：起点用同篇维护窗口的结束时刻锚定（契约 q3 的有锚点情形）
  const maintenanceEnd = findMaintenanceEnd(plain);

  const baseNote: string[] = [];
  if (range) {
    if (range.start === null && !maintenanceEnd) {
      baseNote.push('起点原文「' + range.startRaw.replace(/[（(].*$/, '').trim() + '」无法定位绝对时刻，start_at=null');
    }
    if (range.end === null) baseNote.push('终点原文「' + range.endRaw + '」无法定位绝对时刻，end_at=null');
    if (maintenance) baseNote.push('同篇维护窗口 ' + maintenance);
  } else {
    baseNote.push('公告未给出该池的活动时间');
  }

  /** 组装候选；rng=null 表示「该池没有可用时间」（版本说明里的池常常如此），绝不套用别的活动时间 */
  const makeCandidate = (name: string, suffix: string, characters: string[], rng: TimeRange | null, extraNote?: string): PoolCandidate => {
    let poolType: PoolType = poolTypeOfSuffix(suffix) ?? 'other';
    const isWeapon = poolType === 'weapon';
    const notes: string[] = [];
    if (extraNote) notes.push(extraNote);
    if (rng) notes.push(...baseNote);
    else notes.push('公告未给出该池的直接时间（版本说明常见）' + (maintenance ? '；同篇维护窗口 ' + maintenance : ''));
    const startFromMaintenance = (rng ? rng.start === null : true) && !!maintenanceEnd;
    if (startFromMaintenance) notes.push('起点按同篇维护结束时刻 ' + maintenanceEnd + ' 近似');
    const noteParts = notes;
    return {
      game_key: 'wutheringwaves',
      pool_name: name,
      pool_type: poolType,
      characters: isWeapon ? [] : characters,
      start_at: rng ? (rng.start ?? (startFromMaintenance ? maintenanceEnd : null)) : (startFromMaintenance ? maintenanceEnd : null),
      end_at: rng ? rng.end : null,
      version: version,
      period: period,
      evidence: ((title ? title + ' | ' : '') + (rng ? rng.startRaw + ' ~ ' + rng.endRaw : '')).slice(0, 200) || null,
      note: noteParts.length ? noteParts.join('；') : null,
      source: {
        id: 'kuro-site',
        tier: 'L0',
        url: meta.url ?? ARTICLE_URL + '/' + String(meta.articleId) + '.json',
        fetched_at: meta.fetchedAt ?? null,
      },
    };
  };

  const titlePool = parseTitlePool(title);
  if (titlePool) {
    const chars = titlePool.suffix.indexOf('武器') >= 0 ? [] : upFiveStarNames(plain);
    const cand = makeCandidate(titlePool.name, titlePool.suffix, chars, range);
    if (cand.pool_type !== 'weapon' && /复刻|返场/.test(title + '\n' + plain)) {
      cand.pool_type = /复刻|返场/.test(title) ? 'rerun_character' : cand.pool_type;
    }
    return [cand];
  }

  // 版本说明 / 分组公告：逐行扫池名；只有紧邻的「活动时间」行才当作该池的时间
  const out: PoolCandidate[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_POOLS_PER_ARTICLE; i++) {
    const tokens = scanPoolTokens(lines[i]);
    if (tokens.length === 0) continue;
    let ownRange: TimeRange | null = null;
    for (let j = i; j <= Math.min(lines.length - 1, i + 4); j++) {
      if (!/(活动时间|开放时间|唤取时间)/.test(lines[j])) continue;
      ownRange = findTimeRange([lines[j], lines[j + 1] ?? '']);
      break;
    }
    for (const token of tokens) {
      const chars = token.suffix.indexOf('武器') >= 0 ? [] : nearbyFiveStarNames(lines, i);
      const cand = makeCandidate(token.name, token.suffix, chars, ownRange, ownRange ? '时间取自紧随其后的活动时间行' : undefined);
      if (cand.pool_type !== 'weapon' && /复刻|返场/.test(lines[i])) cand.pool_type = 'rerun_character';
      out.push(cand);
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = c.pool_type + '|' + c.pool_name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 判断列表项是否是公告对象（ArticleMenu 是 { "0": {...}, ... } 形式） */
function isArticle(v: unknown): v is KuroArticleLike {
  if (!v || typeof v !== 'object') return false;
  const id = (v as KuroArticleLike).articleId;
  return id !== undefined && id !== null && String(id).length > 0;
}

/** 拉一篇公告正文：列表里的 articleContent 是截断的，需要按 id 二次取 */
async function loadArticleText(ctx: SourceContext, article: KuroArticleLike): Promise<string | null> {
  const inline = article.articleContent ?? '';
  if (inline.length > 400) return inline;
  const id = String(article.articleId);
  const detail = await withSourceCache<KuroArticleLike>(ctx, 'kuro-site-article-' + id, () =>
    fetchJson<KuroArticleLike>(ARTICLE_URL + '/' + id + '.json'),
  );
  if (!detail) {
    ctx.log('[source:kuro-site] 公告正文 ' + id + ' 不可用（离线且无缓存或请求失败），跳过');
    return null;
  }
  return detail.articleContent ?? null;
}

/** 采集入口：列表 → 逐篇正文 → 候选池 */
export async function collectKuroSite(ctx: SourceContext): Promise<PoolCandidate[]> {
  const menu = await withSourceCache<Record<string, unknown>>(ctx, 'kuro-site', () => fetchJson(MENU_URL));
  if (!menu) {
    ctx.log('[source:kuro-site] 公告列表不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const articles = Object.values(menu).filter(isArticle);
  const picked = articles
    .filter((a) => POOLY_TITLE_RE.test(a.articleTitle ?? '') || VERSION_NOTES_TITLE_RE.test(a.articleTitle ?? ''))
    .sort((a, b) => String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')))
    .slice(0, MAX_ARTICLES);

  const out: PoolCandidate[] = [];
  const seen = new Set<string>();
  for (const article of picked) {
    const html = await loadArticleText(ctx, article);
    if (!html) continue;
    const candidates = parseKuroArticleText(html, {
      articleId: article.articleId,
      title: article.articleTitle,
      url: ARTICLE_URL + '/' + String(article.articleId) + '.json',
      fetchedAt: ctx.nowCst,
    });
    for (const cand of candidates) {
      const key = cand.pool_type + '|' + cand.pool_name + '|' + (cand.start_at ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cand);
    }
  }
  if (out.length === 0) ctx.log('[source:kuro-site] 未解析出任何卡池');
  return out;
}

export const kuroSiteAdapter: SourceAdapter = {
  id: 'kuro-site',
  tier: 'L0',
  label: '鸣潮官网公告',
  games: ['wutheringwaves'],
  collect: collectKuroSite,
};

export default kuroSiteAdapter;
