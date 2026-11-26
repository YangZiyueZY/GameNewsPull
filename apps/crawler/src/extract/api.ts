// 嵌入用静态 API v1 构建器（决策 q11/q12）：把 feed.json 投影成第三方可直接 fetch 的只读 JSON 端点。
// 设计：
// 1) buildApiBundle() 是纯函数：只把 feed 投影成内存文件表（不读盘、不写盘、不联网），离线可测；
// 2) writeApiBundle() 只负责落盘，rootDir 由调用方给（通常是 docs/api/v1），模块不关心部署位置；
// 3) 所有列表端点共用同一信封（api_version/generated_at/cdn/count/items），index.json 自描述，
//    列出每个端点的地址、条数与更新时刻，嵌入方只需认识一个入口；
// 4) 新闻图片对象化为 { url, fallback, local }：三地址由上游 cdnize 阶段写好，这里只做投影，
//    不再改写地址（缺 *_fallback / *_local 时置 null，绝不猜测）；
// 5) 游戏/影像的图片字段若还是站内相对路径，这里补成 CDN 绝对地址（对已 cdnize 的远程地址无副作用），
//    保证第三方嵌入方拿到的地址一定可以直接用。
import fs from 'node:fs';
import path from 'node:path';
import { SITE } from '../../config/site.ts';
import { assetRel, isLocalAsset } from '../utils/cdn.ts';

export const API_VERSION = 'v1';
// 与 feed 的 schema_version 对齐：v4 引入 generated_at_utc / 卡池 confidence / 图片三地址
export const API_SCHEMA_VERSION = 4;
/** news/latest.json 只保留最新 N 条（契约 §5） */
export const LATEST_NEWS_LIMIT = 50;

const TZ_OFFSET = 8 * 3_600_000;   // Asia/Shanghai，无夏令时
/** docs 目录（相对仓库根）：SITE.apiDir 形如 docs/api/v1，首段即站点发布根 */
const DOCS_DIR = SITE.apiDir.split('/')[0] || 'docs';

export interface ApiImageRef {
  url: string;
  fallback: string | null;
  local: string | null;
}

export interface ApiCdn {
  /** 站内图片的 jsDelivr 根地址 */
  images: string;
  /** 本 API 目录的 jsDelivr 根地址 */
  api: string;
}

export interface ApiNewsItem {
  id: string;
  game_key: string;
  game_name: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  type: string;
  images: ApiImageRef[];
  cover: ApiImageRef | null;
}

/** 生日按游戏聚合的一段（只为有生日的游戏生成，避免端点里全是空数组） */
export interface ApiGameBirthdays {
  game_key: string;
  game_name: string;
  count: number;
  birthdays: any[];
}

export interface ApiEnvelope<T> {
  api_version: typeof API_VERSION;
  schema_version: number;
  generated_at: string;
  generated_at_utc: string;
  count: number;
  cdn: ApiCdn;
  items: T[];
}

export interface ApiEndpointMeta {
  /** API 目录内的相对路径，如 news/latest.json */
  path: string;
  /** 主入口（jsDelivr，自带 CORS） */
  url: string;
  /** 回退地址（raw.githubusercontent，同样直读、无 CORS 限制） */
  raw_url: string;
  description: string;
  /** 端点条数；不适用的端点（index / feed 镜像）为 null */
  count: number | null;
  updated_at: string;
}

export interface ApiIndex {
  api_version: typeof API_VERSION;
  schema_version: number;
  generated_at: string;
  generated_at_utc: string;
  counts: { games: number; news: number; media: number };
  endpoints: ApiEndpointMeta[];
  cdn: ApiCdn;
  note: string;
  rate_limit_note: string;
}

export interface ApiFile {
  /** API 目录内的相对路径，统一用 / 分隔 */
  path: string;
  body: string;
}

export interface ApiBundle {
  files: ApiFile[];
}

export interface BuildApiOptions {
  /** feed.generated_at 缺失/非法时的兜底时间（epoch ms），便于测试复现 */
  now?: number;
}

interface GeneratedMeta {
  generated_at: string;
  generated_at_utc: string;
  cdn: ApiCdn;
}

// ——————————————————————————— 小工具 ———————————————————————————

const pad2 = (n: number): string => String(n).padStart(2, '0');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** epoch ms → 'YYYY-MM-DDTHH:mm:ss+08:00'（显式 +8 构造，不依赖进程时区）
 *  注：契约 §1 计划把它收到 utils/datetime.ts 的 toCstIso；该文件正在并行扩展，
 *  落地后可删掉本函数直接引用，行为保持一致。 */
function toCstIso(ms: number): string {
  const d = new Date(ms + TZ_OFFSET);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`;
}

/** 仓库内路径 → jsDelivr 绝对地址（与 utils/cdn.ts 的 cdnUrl 同一模板）。
 *  这里不复用 cdnUrl()/apiCdnUrl()：它们的 assetRel() 会剥掉 "docs/" 前缀，
 *  而 SITE.apiDir 与图片目录都在 docs/ 下，直接调用会生成缺 docs/ 的错误地址。
 *  待 cdn.ts 的 assetRel 修正后，可换回 apiCdnUrl()/apiRawUrl()。 */
function repoCdnUrl(repoRelPath: string): string {
  const rel = repoRelPath.replace(/^\.?\//, '').replace(/\/+$/, '');
  return `${SITE.cdnBase}/${SITE.owner}/${SITE.repo}@${SITE.branch}/${rel}`;
}

/** 仓库内路径 → raw.githubusercontent 回退地址（与 utils/cdn.ts 的 rawUrl 同模板） */
function repoRawUrl(repoRelPath: string): string {
  const rel = repoRelPath.replace(/^\.?\//, '').replace(/\/+$/, '');
  return `https://raw.githubusercontent.com/${SITE.owner}/${SITE.repo}/${SITE.branch}/${rel}`;
}

/** 站内相对资源（img/xxx.jpg、icons/x.svg）→ jsDelivr 绝对地址；远程/data: 地址原样返回。
 *  上游 cdnize 已把大部分字段改成远程地址，这里兜住还没 cdnize 的构建：
 *  否则第三方嵌入方会拿到站内相对路径，指向它自己的静态目录。 */
function absAsset(url: unknown): string | null {
  const v = str(url);
  if (!v) return null;
  return isLocalAsset(v) ? repoCdnUrl(`${DOCS_DIR}/${assetRel(v)}`) : v;
}

function envelopeHead(meta: GeneratedMeta, count: number): Omit<ApiEnvelope<never>, 'items'> {
  return {
    api_version: API_VERSION,
    schema_version: API_SCHEMA_VERSION,
    generated_at: meta.generated_at,
    generated_at_utc: meta.generated_at_utc,
    count,
    cdn: meta.cdn,
  };
}

function envelope<T>(items: T[], meta: GeneratedMeta): ApiEnvelope<T> {
  return { ...envelopeHead(meta, items.length), items };
}

function endpointMeta(p: string, description: string, count: number | null, updatedAt: string): ApiEndpointMeta {
  const repoPath = `${SITE.apiDir}/${p}`;
  return { path: p, url: repoCdnUrl(repoPath), raw_url: repoRawUrl(repoPath), description, count, updated_at: updatedAt };
}

// ——————————————————————————— 投影 ———————————————————————————

/** 新闻图片数组：主串来自 images，回退/本地按下标对齐 images_fallback / images_local */
function imageRefs(item: any): ApiImageRef[] {
  const main: unknown[] = Array.isArray(item?.images) ? item.images : [];
  const fallback: unknown[] = Array.isArray(item?.images_fallback) ? item.images_fallback : [];
  const local: unknown[] = Array.isArray(item?.images_local) ? item.images_local : [];
  const total = Math.max(main.length, fallback.length, local.length);
  const out: ApiImageRef[] = [];
  for (let i = 0; i < total; i++) {
    const fb = str(fallback[i]);
    const lc = str(local[i]);
    const url = str(main[i]) ?? fb ?? lc;   // 缺主串时退到回退/本地串，仍不编造地址
    if (!url) continue;
    out.push({ url, fallback: fb, local: lc });
  }
  return out;
}

/** 封面：与 images 同结构（单个对象），无封面时为 null（前端按空处理，不塞占位图） */
function coverRef(item: any): ApiImageRef | null {
  const url = str(item?.cover);
  if (!url) return null;
  return { url, fallback: str(item?.cover_fallback), local: str(item?.cover_local) };
}

function toNewsItem(item: any): ApiNewsItem {
  return {
    id: String(item?.id ?? ''),
    game_key: String(item?.game_key ?? ''),
    game_name: String(item?.game_name ?? ''),
    title: String(item?.title ?? ''),
    summary: String(item?.summary ?? ''),
    url: String(item?.url ?? ''),
    published_at: String(item?.published_at ?? ''),
    type: String(item?.type ?? 'dynamic'),
    images: imageRefs(item),
    cover: coverRef(item),
  };
}

/** 按发布时间倒序（非法时间当 0，稳定排序保留输入次序） */
function byPublishedDesc(a: ApiNewsItem, b: ApiNewsItem): number {
  return (parseMs(b.published_at) ?? 0) - (parseMs(a.published_at) ?? 0);
}

/** 游戏对象：图片字段补成绝对地址，其余（含 up_banners 的 confidence/sources）原样透出 */
function projectGame(game: any): any {
  const preview = Array.isArray(game?.preview_images) ? game.preview_images : [];
  return {
    ...game,
    icon_url: absAsset(game?.icon_url),
    preview_images: preview.map(absAsset).filter((u: string | null): u is string => !!u),
  };
}

/** 影像条目：封面同样补成绝对地址，其它字段不动 */
function projectMediaItem(item: any): any {
  return { ...item, poster_url: absAsset(item?.poster_url) };
}

/** 生日按游戏聚合：只为确实有生日的游戏出条目（前端隐藏空块，端点也不留噪音） */
function groupBirthdays(games: any[]): ApiGameBirthdays[] {
  const out: ApiGameBirthdays[] = [];
  for (const g of games) {
    const list = Array.isArray(g?.birthdays) ? g.birthdays : [];
    if (!list.length) continue;
    out.push({
      game_key: String(g?.key ?? ''),
      game_name: String(g?.game_name ?? ''),
      count: list.length,
      birthdays: list,
    });
  }
  return out;
}

// ——————————————————————————— 构建 ———————————————————————————

/**
 * feed.json（站点全量 feed）→ API 文件表。
 * 纯函数：同一 feed 必然产出同一份字节，便于 diff 与离线校验。
 */
export function buildApiBundle(feed: any, opts: BuildApiOptions = {}): ApiBundle {
  const genMs = parseMs(feed?.generated_at) ?? opts.now ?? Date.now();
  const meta: GeneratedMeta = {
    generated_at: toCstIso(genMs),
    generated_at_utc: new Date(genMs).toISOString(),
    cdn: {
      images: repoCdnUrl(`${DOCS_DIR}/img`),
      api: repoCdnUrl(SITE.apiDir),
    },
  };

  const games: any[] = (Array.isArray(feed?.data?.games) ? feed.data.games : []).map(projectGame);
  const news: ApiNewsItem[] = (Array.isArray(feed?.news) ? feed.news : []).map(toNewsItem).sort(byPublishedDesc);
  const media: any[] = (Array.isArray(feed?.media?.items) ? feed.media.items : []).map(projectMediaItem);
  const birthdays = groupBirthdays(games);

  const dataFiles: ApiFile[] = [];
  const dataEndpoints: ApiEndpointMeta[] = [];
  const add = (p: string, body: unknown, description: string, count: number | null): void => {
    dataFiles.push({ path: p, body: JSON.stringify(body, null, 2) + '\n' });
    dataEndpoints.push(endpointMeta(p, description, count, meta.generated_at));
  };

  add('news.json', envelope(news, meta), '全量资讯（按 published_at 倒序，图片含 CDN/回退/本地三地址）', news.length);
  const latest = news.slice(0, LATEST_NEWS_LIMIT);
  add(`news/latest.json`, envelope(latest, meta), `最新 ${LATEST_NEWS_LIMIT} 条资讯（嵌入方通常只读这个）`, latest.length);
  add('games.json', envelope(games, meta), '全部游戏状态（含 up_banners 的 confidence/sources）', games.length);
  for (const game of games) {
    const key = str(game?.key);
    if (!key) continue;
    add(
      `games/${key}.json`,
      { ...envelopeHead(meta, 1), game },
      `单款游戏状态：${String(game?.game_name ?? key)}`,
      1,
    );
  }
  add('media.json', envelope(media, meta), '版本 PV / 角色 PV 等影像条目', media.length);
  add('birthdays.json', envelope(birthdays, meta), '角色生日（按游戏聚合，只含有生日的游戏）', birthdays.length);
  // feed.json 是「全量镜像」：刻意不加信封，保持与站点 docs/feed.json 完全同构，便于同构校验/替换
  add('feed.json', feed, '全量镜像：与站点 docs/feed.json 同构（需要 ui/data 全量字段时用它）', null);

  const index: ApiIndex = {
    api_version: API_VERSION,
    schema_version: API_SCHEMA_VERSION,
    generated_at: meta.generated_at,
    generated_at_utc: meta.generated_at_utc,
    counts: { games: games.length, news: news.length, media: media.length },
    endpoints: [
      endpointMeta('index.json', '端点总览（自描述：地址、条数、更新时刻）', null, meta.generated_at),
      ...dataEndpoints,
    ],
    cdn: meta.cdn,
    note: '静态只读 API：全部为纯 JSON 文件，无鉴权、无频控；主入口走 jsDelivr（响应自带 ACAO: *，可直接在浏览器 fetch），raw_url 为回退地址。时间字段为东八区 ISO（+08:00），generated_at_utc 为同一时刻的 UTC 表示。',
    rate_limit_note: 'GitHub/jsDelivr 侧的缓存策略决定刷新延迟（通常数分钟）；建议客户端本地缓存 30 分钟以上。',
  };

  return {
    files: [
      { path: 'index.json', body: JSON.stringify(index, null, 2) + '\n' },
      ...dataFiles,
    ],
  };
}

/**
 * 把文件表写到 rootDir（通常是 docs/api/v1）。只写 api/v1 子树，不改 feed.json / 图片。
 * 返回实际写入的绝对路径，便于日志与测试断言。
 */
export function writeApiBundle(rootDir: string, bundle: ApiBundle): string[] {
  const root = path.resolve(rootDir);
  const written: string[] = [];
  for (const file of bundle.files) {
    const target = path.resolve(root, file.path);
    // bundle 内的路径由本模块拼装，仍然做一次越界校验：防止游戏 key 之类的外部数据带出 ".."
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`API 输出路径越界：${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.body, 'utf8');
    written.push(target);
  }
  return written;
}
