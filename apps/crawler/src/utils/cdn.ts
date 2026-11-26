// 图片与静态资源的三地址模型：CDN 首选 / GitHub 原始地址回退 / 站内相对路径兜底。
// 目录约定：feed 里的相对路径都相对 docs 根（如 img/x.jpg）；
// jsDelivr 与 raw 需要仓库内真实路径（docs/img/x.jpg），Pages 则把 docs 当站点根（img/x.jpg）。
import { SITE } from '../../config/site.ts';

/** 去掉开头的 ./ 与 /；保留 docs/ 前缀判断权交给 repoPath */
export function assetRel(url: string): string {
  return url.replace(/^\.?\//, '');
}

/** 仓库内真实路径：相对 docs 根的 img/x.jpg → docs/img/x.jpg */
export function repoPath(url: string): string {
  const rel = assetRel(url);
  return rel.startsWith('docs/') ? rel : 'docs/' + rel;
}

export function isRemote(url: string | null | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

/** 站内相对资源（非 http 开头，且不是 data:/blob:） */
export function isLocalAsset(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/^(data|blob):/i.test(url)) return false;
  return !isRemote(url);
}

/** jsDelivr：https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/docs/img/x.jpg */
export function cdnUrl(relOrUrl: string): string {
  if (!relOrUrl || isRemote(relOrUrl)) return relOrUrl;
  return SITE.cdnBase + '/' + SITE.owner + '/' + SITE.repo + '@' + SITE.branch + '/' + repoPath(relOrUrl);
}

/** GitHub 原始地址：https://raw.githubusercontent.com/<owner>/<repo>/<ref>/docs/img/x.jpg */
export function rawUrl(relOrUrl: string): string {
  if (!relOrUrl || isRemote(relOrUrl)) return relOrUrl;
  return 'https://raw.githubusercontent.com/' + SITE.owner + '/' + SITE.repo + '/' + SITE.branch + '/' + repoPath(relOrUrl);
}

/** GitHub Pages（docs 是站点根）：<pagesBase>/img/x.jpg */
export function pagesUrl(relOrUrl: string): string {
  if (!relOrUrl || isRemote(relOrUrl)) return relOrUrl;
  const rel = assetRel(relOrUrl);
  return SITE.pagesBase + '/' + (rel.startsWith('docs/') ? rel.slice(5) : rel);
}

/** API 端点的 CDN 地址（第三方嵌入首选，自带 CORS） */
export function apiCdnUrl(pathInApi: string): string {
  return cdnUrl(SITE.apiDir + '/' + pathInApi.replace(/^\//, ''));
}

/** API 端点的 raw 回退地址 */
export function apiRawUrl(pathInApi: string): string {
  return rawUrl(SITE.apiDir + '/' + pathInApi.replace(/^\//, ''));
}