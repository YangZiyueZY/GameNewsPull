// 图片本地化：抓取时下载到 public/img，构建时复制到 docs/img。
// docs/img 随 git 提交作为持久缓存；Actions 冷启动时从 docs/img 命中，避免重复下载。
//
// 配额（决策 q13）：新闻图（news[].images[] / news[].cover）只下沉最新
// IMAGE_QUOTA.newsMaxItems 条资讯、每条 ≤ imagesPerItem 张，落盘总字节 ≤ maxBytes。
// 超配额或下载失败的图一律保留官方原链并打日志——宁可外链也不猜、不截断（前端标 external）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IMAGE_QUOTA } from '../../config/site.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PUBLIC_IMG = path.resolve('apps/web/public/img');
const DOCS_IMG = path.resolve('docs/img');

/** 图片下载的最小依赖面：便于测试注入假下载器，不依赖真实网络 */
export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}>;

export interface LocalizeQuota {
  /** 只本地化最新 N 条资讯的图 */
  newsMaxItems: number;
  /** 单条资讯最多几张（cover 与 images 共用额度，先 cover 后 images） */
  imagesPerItem: number;
  /** 落盘总字节上限（含已提交到 docs/img 的存量） */
  maxBytes: number;
  /** 单轮最多新增几个新闻图文件 */
  maxFiles: number;
}

/** data/image-manifest.json 的单条记录：URL → 本地副本元信息 */
export interface ImageManifestEntry {
  /** 仓库内相对路径，如 img/xxxx.jpg */
  local: string;
  /** 内容 sha1（读不到文件时退化为地址 sha1） */
  sha1: string;
  bytes: number;
  /** 首次本地化时刻（ISO），跨轮保留，便于判断哪些图是历史存量 */
  first_seen: string;
}

export type ImageManifest = Record<string, ImageManifestEntry>;

export interface LocalizeStats {
  /** 本轮新下载并落盘的文件数 */
  downloaded: number;
  /** 命中既有缓存（docs/img 或 image-cache.json）的文件数 */
  cached: number;
  /** 因配额或下载失败而保留原链的数量 */
  skipped: number;
  /** 本轮新写盘字节数 */
  bytes: number;
  /** 候选 URL 总数（静态资产 + 新闻图） */
  candidates: number;
}

export interface LocalizeOptions {
  /** 覆盖配额（测试用） */
  quota?: Partial<LocalizeQuota>;
  /** 注入下载器（测试用假图） */
  fetchImpl?: FetchLike;
  /** 上一轮 manifest，用于保留 first_seen */
  manifest?: ImageManifest;
  /** 覆盖落盘目录（测试用临时目录，避免污染 docs/） */
  publicDir?: string;
  docsDir?: string;
  /** 统一「当前时间」，便于测试复现 */
  now?: number;
  log?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
}

export interface LocalizeResult {
  feed: any;
  cache: Record<string, string>;
  manifest: ImageManifest;
  stats: LocalizeStats;
}

/** 待本地化的新闻图候选（来源可回溯到具体资讯条目） */
export interface NewsImageCandidate {
  url: string;
  /** 资讯 id（缺失时用 feed.news 下标） */
  news_id: string;
  kind: 'cover' | 'image';
  /** images[] 下标；cover 为 -1 */
  index: number;
}

function safeExt(contentType: string | null, url: string): string {
  const ct = (contentType || '').split(';')[0];
  if (ct === 'image/png') return '.png';
  if (ct === 'image/webp') return '.webp';
  if (ct === 'image/gif') return '.gif';
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

function guessExtFromUrl(url: string): string {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

function isHttp(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * 按 IMAGE_QUOTA 挑出「值得本地化」的新闻图。
 * 规则：最新 newsMaxItems 条资讯 → 每条先 cover 再 images，合计 ≤ imagesPerItem；
 * 同一地址只下一份（跨条目复用），跨条目复用不占该条目的额度。
 * 纯函数：不修改 feed，便于离线测试与重放。
 */
export function selectImagesToLocalize(feed: any, quota: LocalizeQuota = IMAGE_QUOTA): NewsImageCandidate[] {
  const news: any[] = Array.isArray(feed?.news) ? feed.news : [];
  // 按发布时间倒序；时间不可解析的排最后（保持原有相对顺序，结果稳定可测）
  const ordered = news
    .map((n, i) => ({ n, i, at: Date.parse(n?.published_at ?? '') }))
    .sort((a, b) => {
      const av = Number.isFinite(a.at) ? a.at : Number.NEGATIVE_INFINITY;
      const bv = Number.isFinite(b.at) ? b.at : Number.NEGATIVE_INFINITY;
      return bv - av || a.i - b.i;
    })
    .slice(0, Math.max(0, quota.newsMaxItems));

  const seen = new Set<string>();
  const out: NewsImageCandidate[] = [];
  for (const { n, i } of ordered) {
    if (out.length >= quota.maxFiles) break;
    const newsId = String(n?.id ?? i);
    let perItem = 0;
    const take = (url: unknown, kind: 'cover' | 'image', index: number): void => {
      if (perItem >= quota.imagesPerItem) return;
      if (!isHttp(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, news_id: newsId, kind, index });
      perItem += 1;
    };
    take(n?.cover, 'cover', -1);
    const images: any[] = Array.isArray(n?.images) ? n.images : [];
    images.forEach((url, k) => take(url, 'image', k));
  }
  return out;
}

/**
 * 扫一遍落盘目录，一次拿到两样东西：
 * 1) 总字节数——把已提交到 git 的存量算进配额，避免「每轮都能再涨 200MB」；
 * 2) 「文件名前 16 位（= 地址 sha1 前缀）→ 实际文件名」索引——下载时按 content-type
 *    纠正过扩展名（.jpg→.png），不建索引的话下一轮按 URL 猜出来的文件名对不上，会重复下载。
 */
function scanDir(dir: string): { bytes: number; byPrefix: Map<string, string> } {
  const byPrefix = new Map<string, string>();
  let bytes = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, byPrefix };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      bytes += fs.statSync(path.join(dir, e.name)).size;
    } catch {
      // 单个文件读不到不影响配额估算
    }
    if (e.name.length > 16) byPrefix.set(e.name.slice(0, 16), e.name);
  }
  return { bytes, byPrefix };
}

function fileSha1(file: string): string | null {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export async function localizeImages(
  feed: any,
  cache: Record<string, string> = {},
  opts: LocalizeOptions = {},
): Promise<LocalizeResult> {
  const quota: LocalizeQuota = { ...IMAGE_QUOTA, ...(opts.quota ?? {}) };
  const log = opts.log ?? ((...args: any[]) => console.log('[media]', ...args));
  const warn = opts.warn ?? ((...args: any[]) => console.warn('[media]', ...args));
  const fetcher: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const publicDir = opts.publicDir ?? PUBLIC_IMG;
  const docsDir = opts.docsDir ?? DOCS_IMG;
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  const prevManifest: ImageManifest = opts.manifest ?? {};

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  // 有序去重：静态资产（图标 / 预览图 / 封面）不受新闻配额限制，量小且是站点骨架
  const urls: string[] = [];
  const push = (url: unknown): void => {
    if (isHttp(url) && !urls.includes(url)) urls.push(url);
  };
  for (const g of feed?.data?.games ?? []) {
    push(g.icon_url);
    for (const p of g.preview_images ?? []) push(p);
  }
  for (const m of feed?.media?.items ?? []) push(m.poster_url);
  const newsCandidates = selectImagesToLocalize(feed, quota);
  for (const c of newsCandidates) push(c.url);

  const mapping: Record<string, string> = {};
  const manifest: ImageManifest = {};
  // 已提交的存量计入配额，避免「每轮再涨 200MB」
  const { bytes: committedBytes, byPrefix: existingFiles } = scanDir(docsDir);
  let downloaded = 0;
  let cached = 0;
  let skipped = 0;
  let bytes = 0;

  // 写清单：sha1 优先取内容（可做完整性校验），读不到文件时退化为地址 sha1
  const record = (url: string, local: string, size: number, buf?: Buffer, hashFile?: string): void => {
    const prev = prevManifest[url];
    const sha1 = buf
      ? crypto.createHash('sha1').update(buf).digest('hex')
      : (fileSha1(hashFile ?? path.join(docsDir, path.basename(local))) ?? crypto.createHash('sha1').update(url).digest('hex'));
    manifest[url] = { local, sha1, bytes: size, first_seen: prev?.first_seen ?? nowIso };
  };

  for (const url of urls) {
    const hash16 = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    // 已落盘的文件优先（可能因 content-type 纠正过扩展名）
    const known = existingFiles.get(hash16);
    const name = known ?? hash16 + guessExtFromUrl(url);
    const docFile = path.join(docsDir, name);
    const pubFile = path.join(publicDir, name);
    const rel = `img/${name}`;

    if (fs.existsSync(docFile)) {
      // 命中已提交到 git 的持久缓存，复制到 public 供构建使用
      if (!fs.existsSync(pubFile)) {
        try {
          fs.copyFileSync(docFile, pubFile);
        } catch (e: any) {
          warn('缓存复制失败:', rel, e?.message ?? e);
        }
      }
      mapping[url] = rel;
      record(url, rel, fs.statSync(docFile).size);
      cached += 1;
      continue;
    }

    const hit = cache[url];
    if (hit) {
      const hitFile = path.join(publicDir, path.basename(hit));
      if (fs.existsSync(hitFile)) {
        mapping[url] = hit;
        record(url, hit, fs.statSync(hitFile).size, undefined, hitFile);
        cached += 1;
        continue;
      }
    }

    if (committedBytes + bytes >= quota.maxBytes) {
      skipped += 1;
      warn('字节配额已满，保留原链:', url.slice(0, 80));
      continue;
    }

    try {
      const res = await fetcher(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      // 配额判断放在拿字节之后：超了就丢弃这次下载（保原链），不再写盘
      if (committedBytes + bytes + buf.length > quota.maxBytes) {
        skipped += 1;
        warn('超出字节配额，保留原链:', url.slice(0, 80));
        continue;
      }
      const withExt = hash16 + safeExt(res.headers.get('content-type'), url);
      fs.writeFileSync(path.join(publicDir, withExt), buf);
      fs.writeFileSync(path.join(docsDir, withExt), buf);
      mapping[url] = `img/${withExt}`;
      record(url, `img/${withExt}`, buf.length, buf);
      downloaded += 1;
      bytes += buf.length;
    } catch (e: any) {
      skipped += 1;
      warn('下载失败，保留原链接:', url.slice(0, 80), e?.message ?? e);
    }
  }

  for (const g of feed?.data?.games ?? []) {
    if (g.icon_url && mapping[g.icon_url]) g.icon_url = mapping[g.icon_url];
    g.preview_images = (g.preview_images ?? []).map((p: string) => mapping[p] || p);
  }
  for (const m of feed?.media?.items ?? []) {
    if (m.poster_url && mapping[m.poster_url]) m.poster_url = mapping[m.poster_url];
  }
  // 新闻图与封面：未命中（超配额/失败）的原样保留官方链接，交给 cdnize 标 external
  for (const n of feed?.news ?? []) {
    if (n?.cover && mapping[n.cover]) n.cover = mapping[n.cover];
    if (Array.isArray(n?.images)) n.images = n.images.map((u: string) => mapping[u] || u);
  }

  log(`下载 ${downloaded} 张，命中缓存 ${cached} 张，跳过 ${skipped} 张（配额/失败），新增 ${(bytes / 1024).toFixed(0)} KB`);
  return {
    feed,
    cache: { ...cache, ...mapping },
    manifest,
    stats: { downloaded, cached, skipped, bytes, candidates: urls.length },
  };
}
