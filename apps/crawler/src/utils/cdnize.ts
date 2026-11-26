// CDN 三地址落地：把本地化后的仓库内相对路径展开成「主字段 / *_fallback / *_local」三件套。
// 主字段 = jsDelivr（自带 CORS，第三方嵌入首选）；fallback = GitHub Pages；local = 站内相对路径。
//
// 目录口径（与 utils/cdn.ts 保持一致）：
// - feed 里的相对路径以 docs 为根（img/x.jpg）；
// - jsDelivr / raw 需要仓库内真实路径（docs/img/x.jpg），由 cdnUrl()/rawUrl() 负责加前缀；
// - Pages 把 docs 当站点根，所以 pagesUrl() 不加前缀。
//
// 外链（B 站原图、超配额保留的官方链接等不属于本仓库的地址）不动主字段，
// 但仍在资讯条目上打 image_status='external'——前端据此知道「这张图没有本地副本」，
// 不要再去猜 CDN 路径（猜出来的地址必然 404，白白多一次失败请求）。
import { SITE } from '../../config/site.ts';
import { assetRel, cdnUrl, isRemote, pagesUrl } from './cdn.ts';

/** jsDelivr gh 入口前缀：<cdnBase>/<owner>/<repo>@<ref>/ */
const CDN_PREFIX = `${SITE.cdnBase}/${SITE.owner}/${SITE.repo}@`;
/** raw.githubusercontent 前缀：https://raw.githubusercontent.com/<owner>/<repo>/<ref>/ */
const RAW_PREFIX = `https://raw.githubusercontent.com/${SITE.owner}/${SITE.repo}/`;
/** GitHub Pages 前缀：<pagesBase>/ */
const PAGES_PREFIX = `${SITE.pagesBase}/`;

/** 大小写不敏感的前缀剥离（仓库 owner/repo 在 URL 里大小写可能被改写） */
function stripPrefix(url: string, prefix: string): string | null {
  return url.toLowerCase().startsWith(prefix.toLowerCase()) ? url.slice(prefix.length) : null;
}

/** 剥掉 jsDelivr / raw 地址里的 <ref> 段，只留仓库内路径 */
function stripRef(tail: string): string {
  return tail.replace(/^[^/]+\//, '');
}

/** 仓库内 / Pages 路径统一成「相对 docs 根」：docs/img/x.jpg → img/x.jpg */
function docsRel(value: string): string {
  const rel = assetRel(value);
  return rel.startsWith('docs/') ? rel.slice(5) : rel;
}

/**
 * 把任意图片地址归一化成「相对 docs 根」的路径（img/xxx.jpg）。
 * 已是本站 CDN / raw / Pages 地址时剥掉 ref 与前缀；外链返回 null。
 */
export function repoRel(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!isRemote(url)) return docsRel(url) || null;
  const cdnTail = stripPrefix(url, CDN_PREFIX);
  if (cdnTail !== null) return docsRel(stripRef(cdnTail)) || null;
  const rawTail = stripPrefix(url, RAW_PREFIX);
  if (rawTail !== null) return docsRel(stripRef(rawTail)) || null;
  const pagesTail = stripPrefix(url, PAGES_PREFIX);
  if (pagesTail !== null) return docsRel(pagesTail) || null;
  return null;
}

/** 该地址是否属于本仓库（可安全改写成 CDN 地址） */
export function isRepoAsset(url: string | null | undefined): boolean {
  return repoRel(url) !== null;
}

interface Triple { main: string; fallback: string; local: string; external: boolean }

/**
 * 主字段挑选策略（CDN_PRIMARY 环境变量）：
 * - cdn（默认，生产）：主字段 jsDelivr，回退 GitHub Pages；
 * - pages：主字段 GitHub Pages，回退 jsDelivr；
 * - local：主字段站内相对路径（本地/内网预览用，jsDelivr 在部分网络不可达）。
 */
export type CdnPrimary = 'cdn' | 'pages' | 'local';
export function primaryMode(): CdnPrimary {
  const mode = (process.env.CDN_PRIMARY || 'cdn').toLowerCase();
  return mode === 'pages' || mode === 'local' ? mode : 'cdn';
}

/** 单地址 → 三件套。外链三者都保持原地址（cdnUrl/pagesUrl 对外链是恒等函数），不产出 null。 */
function tripleOf(url: string): Triple {
  const rel = repoRel(url);
  if (rel === null) return { main: url, fallback: url, local: url, external: true };
  const mode = primaryMode();
  const cdn = cdnUrl(rel);
  const pages = pagesUrl(rel);
  if (mode === 'local') return { main: rel, fallback: pages, local: rel, external: false };
  if (mode === 'pages') return { main: pages, fallback: cdn, local: rel, external: false };
  return { main: cdn, fallback: pages, local: rel, external: false };
}

/** 单值字段三件套；返回是否外链（无值或非字符串返回 null） */
export function applyFieldCdn(target: any, field: string): boolean | null {
  const value = target?.[field];
  if (typeof value !== 'string' || !value) return null;
  const t = tripleOf(value);
  target[field] = t.main;
  target[`${field}_fallback`] = t.fallback;
  target[`${field}_local`] = t.local;
  return t.external;
}

/** 数组字段三件套：fallback/local 与主字段等长、同序；返回外链条目数 */
export function applyArrayCdn(target: any, field: string): number {
  const list = target?.[field];
  if (!Array.isArray(list) || list.length === 0) return 0;
  const triples = list.map((u: unknown) => (typeof u === 'string' && u ? tripleOf(u) : null));
  target[field] = triples.map((t, i) => t?.main ?? list[i]);
  target[`${field}_fallback`] = triples.map((t, i) => t?.fallback ?? list[i]);
  target[`${field}_local`] = triples.map((t, i) => t?.local ?? list[i]);
  return triples.filter(t => t?.external).length;
}

export interface ApplyCdnStats {
  /** 处理过的字段个数（含数组字段） */
  fields: number;
  /** 外链地址个数 */
  external: number;
  /** 被打上 image_status='external' 的资讯条数 */
  external_news: number;
}

/**
 * 给整份 feed 补上 CDN 三件套（原地修改并返回 feed，与 localizeImages 的用法保持一致）。
 * 幂等：重复调用结果不变（CDN / Pages 地址会被 repoRel 还原成相对路径再重新展开）。
 */
export function applyCdn(feed: any): any {
  applyCdnWithStats(feed);
  return feed;
}

/** 同 applyCdn，额外返回统计（供调用方写 health / 日志） */
export function applyCdnWithStats(feed: any, stats: ApplyCdnStats = { fields: 0, external: 0, external_news: 0 }): ApplyCdnStats {
  for (const g of feed?.data?.games ?? []) {
    const iconExternal = applyFieldCdn(g, 'icon_url');
    if (iconExternal !== null) { stats.fields += 1; if (iconExternal) stats.external += 1; }
    const hasPreview = Array.isArray(g?.preview_images) && g.preview_images.length > 0;
    const previewExternal = applyArrayCdn(g, 'preview_images');
    if (hasPreview) { stats.fields += 1; stats.external += previewExternal; }
  }

  for (const m of feed?.media?.items ?? []) {
    const posterExternal = applyFieldCdn(m, 'poster_url');
    if (posterExternal !== null) { stats.fields += 1; if (posterExternal) stats.external += 1; }
  }

  for (const n of feed?.news ?? []) {
    const hasImages = Array.isArray(n?.images) && n.images.length > 0;
    const imagesExternal = applyArrayCdn(n, 'images');
    if (hasImages) { stats.fields += 1; stats.external += imagesExternal; }
    const coverExternal = applyFieldCdn(n, 'cover');
    if (coverExternal !== null) { stats.fields += 1; if (coverExternal) stats.external += 1; }
    // 一条资讯只要有一张图没本地化，就整体标 external：前端不再尝试 CDN 变体
    if (imagesExternal > 0 || coverExternal === true) {
      n.image_status = 'external';
      stats.external_news += 1;
    }
  }
  return stats;
}
