// 统一动态内容模型：文本 / 图片 / 标题读取
//
// 背景（2026-11 实测）：B 站官方账号已把图文动态统一切到 Opus 结构，
//  - 文本：modules.module_dynamic.major.opus.summary.text
//  - 图片：modules.module_dynamic.major.opus.pics[].url
//  - 而 modules.module_dynamic.desc.text 为空
// 旧解析只读 desc.text / major.draw / major.archive，
// 导致原神首屏 13 条里有 12 条 text 与 images 皆空而被整条丢弃。
//
// 本模块只做「读取」，不做裁剪与业务判断，调用方（normalize.ts）决定长度与取舍。

const MAX_TITLE_LENGTH = 60;

function dynamicOf(item: any): any {
  return item?.modules?.module_dynamic ?? null;
}

function moduleAuthorPubTs(item: any): number | null {
  const ts = item?.modules?.module_author?.pub_ts ?? item?.pub_ts;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 统一 http: → https:，协议相对 //host 也补成 https:，其余非法值返回空串 */
export function toHttpsUrl(raw: any): string {
  if (typeof raw !== 'string') return '';
  const url = raw.trim();
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^http:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  return url;
}

/** 单个 module_dynamic 节点上的文本：opus → desc → 富文本节点兜底 */
function textOfDynamic(dyn: any): string {
  if (!dyn) return '';
  const opusText = dyn.major?.opus?.summary?.text;
  if (typeof opusText === 'string' && opusText.trim()) return opusText.trim();

  const descText = dyn.desc?.text;
  if (typeof descText === 'string' && descText.trim()) return descText.trim();

  // 兜底：个别动态 summary.text 为空但 rich_text_nodes 有正文
  const nodes = dyn.major?.opus?.summary?.rich_text_nodes;
  if (Array.isArray(nodes)) {
    const joined = nodes
      .map((n: any) => (typeof n?.orig_text === 'string' ? n.orig_text : typeof n?.text === 'string' ? n.text : ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  return '';
}

/** 单个 module_dynamic 节点上的图片：opus.pics → draw.items */
function imagesOfDynamic(dyn: any): string[] {
  if (!dyn) return [];
  const out: string[] = [];
  const opusPics = dyn.major?.opus?.pics;
  if (Array.isArray(opusPics)) {
    for (const pic of opusPics) out.push(toHttpsUrl(pic?.url ?? pic?.src));
  }
  const drawItems = dyn.major?.draw?.items;
  if (Array.isArray(drawItems)) {
    for (const draw of drawItems) out.push(toHttpsUrl(draw?.src ?? draw?.url));
  }
  return out;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of list) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * 读取动态正文。
 * 优先级：major.opus.summary.text → desc.text → 转发时 item.orig 的同上逻辑。
 * 返回 trim 后的纯文本（不裁剪长度）。
 */
export function readDynamicText(item: any): string {
  const own = textOfDynamic(dynamicOf(item));
  if (own) return own;
  const orig = item?.orig;
  if (orig) return textOfDynamic(dynamicOf(orig));
  return '';
}

/**
 * 读取动态图片。
 * 优先级：major.opus.pics[].url → major.draw.items[].src → 转发时 item.orig 的同上逻辑。
 * 统一 https、过滤空值、保序去重。
 */
export function readDynamicImages(item: any): string[] {
  const own = imagesOfDynamic(dynamicOf(item));
  if (own.length) return dedupe(own);
  const orig = item?.orig;
  if (orig) return dedupe(imagesOfDynamic(dynamicOf(orig)));
  return [];
}

function clampTitle(title: string): string {
  const t = title.trim();
  if (!t) return '';
  return t.length > MAX_TITLE_LENGTH ? `${t.slice(0, MAX_TITLE_LENGTH - 1)}…` : t;
}

// 只由话题标签组成的行，例如「#原神# #原神7.2版本#」
const TOPIC_ONLY_LINE_RE = /^(?:#[^#\n]{1,24}#\s*)+$/;

/** 正文首个有效行；若该行只有话题标签，则补上下一个有效行，避免标题只有「#原神#」 */
function titleFromText(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const first = lines[0];
  if (TOPIC_ONLY_LINE_RE.test(first) && lines[1]) return `${first} ${lines[1]}`;
  return first;
}

/** 动态的 opus 标题（官方新格式会带标题，例如「海特洛衣橱 | Exe时装展示」） */
export function readDynamicOpusTitle(item: any): string {
  const title = dynamicOf(item)?.major?.opus?.title;
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * 读取动态标题：优先 major.opus.title，否则正文首个非空行；转发时再退到 orig。
 * 公告类以 # 话题 开头时，标题即首个有效行（含话题），保证不为空串；上限 60 字符。
 */
export function readDynamicTitle(item: any): string {
  const opusTitle = readDynamicOpusTitle(item);
  if (opusTitle) return clampTitle(opusTitle);

  const firstLine = titleFromText(readDynamicText(item));
  if (firstLine) return clampTitle(firstLine);

  const orig = item?.orig;
  if (orig) {
    const origOpusTitle = readDynamicOpusTitle(orig);
    if (origOpusTitle) return clampTitle(origOpusTitle);
    const origLine = titleFromText(readDynamicText(orig));
    if (origLine) return clampTitle(origLine);
  }
  return '';
}

/**
 * 是否为「Opus-only」动态：desc.text 为空但 opus 里有内容。
 * 供抓取统计（CrawlStats.opusOnly / opusParsed）使用。
 */
export function isOpusOnlyItem(item: any): boolean {
  const dyn = dynamicOf(item);
  if (!dyn) return false;
  const descText = typeof dyn.desc?.text === 'string' ? dyn.desc.text.trim() : '';
  if (descText) return false;
  return !!(textOfDynamic(dyn) || imagesOfDynamic(dyn).length);
}

/** 动态发布时间（秒级时间戳 → 毫秒），拿不到时返回 null */
export function readDynamicPubTime(item: any): number | null {
  const ts = moduleAuthorPubTs(item);
  return ts === null ? null : ts * 1000;
}
