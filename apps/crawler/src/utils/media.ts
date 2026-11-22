// 图片本地化：抓取时下载到 public/img，构建时复制到 docs/img。
// docs/img 随 git 提交作为持久缓存；Actions 冷启动时从 docs/img 命中，避免重复下载。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PUBLIC_IMG = path.resolve('apps/web/public/img');
const DOCS_IMG = path.resolve('docs/img');

function safeExt(contentType: string | null, url: string): string {
  const ct = (contentType || '').split(';')[0];
  if (ct === 'image/png') return '.png';
  if (ct === 'image/webp') return '.webp';
  if (ct === 'image/gif') return '.gif';
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

export async function localizeImages(feed: any, cache: Record<string, string> = {}): Promise<{ feed: any; cache: Record<string, string> }> {
  fs.mkdirSync(PUBLIC_IMG, { recursive: true });
  fs.mkdirSync(DOCS_IMG, { recursive: true });
  const urls = new Set<string>();

  for (const g of feed.data?.games ?? []) {
    if (g.icon_url) urls.add(g.icon_url);
    for (const p of g.preview_images ?? []) urls.add(p);
  }
  for (const m of feed.media?.items ?? []) {
    if (m.poster_url) urls.add(m.poster_url);
  }

  const mapping: Record<string, string> = {};
  let downloaded = 0, cached = 0;
  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) continue;
    const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + guessExtFromUrl(url);
    const docFile = path.join(DOCS_IMG, name);
    const pubFile = path.join(PUBLIC_IMG, name);
    const rel = `img/${name}`;

    if (fs.existsSync(docFile)) {
      // 命中已提交到 git 的缓存，复制到 public 供构建使用
      if (!fs.existsSync(pubFile)) fs.copyFileSync(docFile, pubFile);
      mapping[url] = rel;
      cached++;
      continue;
    }
    if (cache[url] && fs.existsSync(path.join(PUBLIC_IMG, path.basename(cache[url])))) {
      mapping[url] = cache[url];
      cached++;
      continue;
    }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const withExt = name.replace(/\.[^.]+$/, '') + safeExt(res.headers.get('content-type'), url);
      fs.writeFileSync(path.join(PUBLIC_IMG, withExt), buf);
      fs.writeFileSync(path.join(DOCS_IMG, withExt), buf);
      mapping[url] = `img/${withExt}`;
      downloaded++;
    } catch (e: any) {
      console.warn('[media] 下载失败，保留原链接:', url.slice(0, 80), e.message);
      mapping[url] = url;
    }
  }

  for (const g of feed.data?.games ?? []) {
    if (g.icon_url && mapping[g.icon_url]) g.icon_url = mapping[g.icon_url];
    g.preview_images = (g.preview_images ?? []).map((p: string) => mapping[p] || p);
  }
  for (const m of feed.media?.items ?? []) {
    if (m.poster_url && mapping[m.poster_url]) m.poster_url = mapping[m.poster_url];
  }

  console.log(`[media] 下载 ${downloaded} 张，命中缓存 ${cached} 张`);
  return { feed, cache: { ...cache, ...mapping } };
}

function guessExtFromUrl(url: string): string {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}
