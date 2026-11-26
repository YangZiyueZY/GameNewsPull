// RSS 2.0 输出（自 extract/feed.ts 迁出）：时间统一走 rfc822Cst（+0800），
// 有图条目追加 enclosure / media:content / description 内 <img>，让阅读器直接出封面。
import type { NewsItem } from './normalize.ts';
import { GAMES } from '../../config/games.ts';
import type { GameConfig } from '../../config/games.ts';
import { SITE_URL } from '../../config/site.ts';
import { rfc822Cst } from '../utils/datetime.ts';
import { cdnUrl, isRemote } from '../utils/cdn.ts';

const MAX_ITEMS = 100;
const MAX_SUMMARY = 300;
// 契约 §2 固定用 image/jpeg：与 data/image-manifest.json 的本地化产物一致，
// 阅读器只按这个 type 判断是否当封面图缓存，长度未知按 0 处理（不阻塞预取）。
const ENCLOSURE_TYPE = 'image/jpeg';

/** 元素文本/属性统一转义；单引号也转，避免拼进属性时出问题 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA 内唯一非法序列是 "]]>"，拆成两段 CDATA 即可安全承载任意正文 */
function cdata(s: string): string {
  return '<![CDATA[' + s.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

/** 兼容 string 与未来 {url,fallback,local} 三种图片值形态 */
function toUrl(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const o = v as { url?: unknown; fallback?: unknown; local?: unknown };
    for (const candidate of [o.url, o.fallback, o.local]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

/** 条目的首图：images[0] 优先，其次 cover（内联 data:/blob: 不算图） */
function firstImage(item: NewsItem): string | null {
  for (const raw of [...(item.images ?? []), item.cover]) {
    const url = toUrl(raw);
    if (url && !/^(data|blob):/i.test(url)) return url;
  }
  return null;
}

/** 站内相对路径换成 CDN 绝对地址：RSS 阅读器没法解析相对路径 */
function publicUrl(url: string): string {
  return isRemote(url) ? url : cdnUrl(url);
}

function itemXml(item: NewsItem): string {
  const image = firstImage(item);
  const pubMs = Date.parse(item.published_at);
  const summary = esc(item.summary.slice(0, MAX_SUMMARY));
  const description = image
    ? cdata('<p>' + summary + '</p><img src="' + esc(publicUrl(image)) + '" alt="' + esc(item.title) + '"/>')
    : summary;
  const lines = [
    '    <item>',
    `      <title>${esc(`[${item.game_name}] ${item.title}`)}</title>`,
    `      <link>${esc(item.url)}</link>`,
    `      <guid isPermaLink="false">${esc(item.id)}</guid>`,
  ];
  // 发布时间坏掉的条目宁可不出 pubDate，也不要输出 Invalid Date
  if (Number.isFinite(pubMs)) lines.push(`      <pubDate>${rfc822Cst(pubMs)}</pubDate>`);
  lines.push(`      <description>${description}</description>`, `      <category>${esc(item.game_name)}</category>`);
  if (image) {
    const url = esc(publicUrl(image));
    lines.push(
      `      <enclosure url="${url}" type="${ENCLOSURE_TYPE}" length="0"/>`,
      `      <media:content url="${url}" medium="image"/>`,
    );
  }
  lines.push('    </item>');
  return lines.join('\n');
}

/**
 * 生成 feed.rss。
 * @param now 构建时刻（epoch ms），测试可注入以保证输出稳定
 */
export function buildRss(items: NewsItem[], gameConfigs: GameConfig[] = GAMES, now: number = Date.now()): string {
  const sorted = [...items]
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, MAX_ITEMS);
  const channelTitle = '二游资讯 · B站官方动态';
  const games = gameConfigs.map((g) => g.name).slice(0, 8).join('、');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(channelTitle)}</title>
    <link>${esc(SITE_URL)}</link>
    <atom:link href="${esc(SITE_URL + 'feed.rss')}" rel="self" type="application/rss+xml"/>
    <description>${esc(`${games} 等 ${gameConfigs.length} 款二游官方 B 站资讯聚合`)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${rfc822Cst(now)}</lastBuildDate>
${sorted.map(itemXml).join('\n')}
  </channel>
</rss>
`;
}
