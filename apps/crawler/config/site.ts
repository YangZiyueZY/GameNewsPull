// 站点与交付配置：集中管理仓库标识、CDN/Pages/raw 三个地址基准、图片体积配额。
// 全部可用环境变量覆盖，避免把 owner/repo 硬编码散落到各处。
export interface SiteConfig {
  owner: string;
  repo: string;
  /** jsDelivr 引用的 ref：默认 main；需要「立即可见」时可切到具体 commit sha */
  branch: string;
  /** GitHub Pages 站点根（带子路径，无尾斜杠） */
  pagesBase: string;
  /** jsDelivr gh 入口 */
  cdnBase: string;
  /** API 静态端点目录（相对仓库根） */
  apiDir: string;
}

export const SITE: SiteConfig = {
  owner: process.env.SITE_OWNER || 'YangZiyueZY',
  repo: process.env.SITE_REPO || 'GameNewsPull',
  branch: process.env.CDN_REF || 'main',
  pagesBase: (process.env.PAGES_BASE || 'https://yangziyuezy.github.io/GameNewsPull').replace(/\/+$/, ''),
  cdnBase: 'https://cdn.jsdelivr.net/gh',
  apiDir: 'docs/api/v1',
};

/**
 * 图片本地化配额（决策 q13=A）：
 * - 新闻图只下沉最新 N 条资讯、每条最多 M 张；
 * - 全局字节上限，超出后长尾保留 B 站原链并标 external，不再下载。
 */
export const IMAGE_QUOTA = {
  newsMaxItems: Number(process.env.IMAGE_NEWS_MAX_ITEMS || 150),
  imagesPerItem: Number(process.env.IMAGE_PER_ITEM || 2),
  maxBytes: Number(process.env.IMAGE_MAX_BYTES || 200 * 1024 * 1024),
  maxFiles: Number(process.env.IMAGE_MAX_FILES || 4000),
} as const;

/** 站点页面根（用于 human 可读链接） */
export const SITE_URL = SITE.pagesBase + '/';
