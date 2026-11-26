// 离线测试：新闻图本地化配额（selectImagesToLocalize / localizeImages）与 CDN 三地址映射（applyCdn）。
// 全部使用合成 feed + 注入的假下载器 + 临时目录，不联网、不写 docs/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { localizeImages, selectImagesToLocalize } from '../apps/crawler/src/utils/media.ts';
import type { FetchLike, LocalizeQuota } from '../apps/crawler/src/utils/media.ts';
import { applyCdn, applyCdnWithStats, repoRel } from '../apps/crawler/src/utils/cdnize.ts';
import { cdnUrl, pagesUrl } from '../apps/crawler/src/utils/cdn.ts';
import { SITE } from '../apps/crawler/config/site.ts';

// 期望值直接复用 cdn.ts，保证「feed 相对 docs 根 / CDN 含 docs 前缀 / Pages 去掉 docs 前缀」口径一致
const CDN = (rel: string) => cdnUrl(rel);
const PAGES = (rel: string) => pagesUrl(rel);

const QUOTA: LocalizeQuota = { newsMaxItems: 150, imagesPerItem: 2, maxBytes: 200 * 1024 * 1024, maxFiles: 4000 };

interface NewsLike {
  id: string;
  published_at: string;
  images?: string[];
  cover?: string;
}

function news(id: string, publishedAt: string, images: string[] = [], cover?: string): NewsLike {
  return { id, published_at: publishedAt, images, cover };
}

/** 合成 feed：只保留本任务关心的字段 */
function makeFeed(overrides: any = {}) {
  return {
    data: {
      games: [
        { key: 'endfield', icon_url: 'img/icon-endfield.png', preview_images: [] as string[] },
        { key: 'genshin', icon_url: 'img/icon-genshin.png', preview_images: ['img/preview-genshin.jpg'] as string[] },
      ],
    },
    media: { items: [{ id: 'm1', poster_url: 'img/poster-m1.jpg' }] },
    news: [] as NewsLike[],
    ...overrides,
  };
}

// ——————————————————————— selectImagesToLocalize：配额选择 ———————————————————————

test('selectImagesToLocalize：只取最新 newsMaxItems 条，每条 ≤ imagesPerItem 张且 cover 优先', () => {
  const feed = makeFeed({
    news: [
      news('a', '2026-11-20T10:00:00+08:00', ['https://i0.hdslb.com/a1.jpg', 'https://i0.hdslb.com/a2.jpg', 'https://i0.hdslb.com/a3.jpg'], 'https://i0.hdslb.com/a-cover.jpg'),
      news('b', '2026-11-22T10:00:00+08:00', ['https://i0.hdslb.com/b1.jpg']),
      news('c', '2026-11-24T10:00:00+08:00', ['https://i0.hdslb.com/c1.jpg', 'https://i0.hdslb.com/c2.jpg'], 'https://i0.hdslb.com/c-cover.jpg'),
      news('d', '2026-11-10T10:00:00+08:00', ['https://i0.hdslb.com/d1.jpg']),
    ],
  });

  const picked = selectImagesToLocalize(feed, { ...QUOTA, newsMaxItems: 2, imagesPerItem: 2 });

  // 只有最新的 c（11-24）与 b（11-22）入选；c 先 cover 再 c1，c2 超单条额度；a/d 完全不在窗口内
  assert.deepEqual(picked.map(p => p.url), [
    'https://i0.hdslb.com/c-cover.jpg',
    'https://i0.hdslb.com/c1.jpg',
    'https://i0.hdslb.com/b1.jpg',
  ]);
  assert.deepEqual(picked.map(p => p.news_id), ['c', 'c', 'b']);
  assert.deepEqual(picked.map(p => p.kind), ['cover', 'image', 'image']);
  // 选择是纯函数：不能把 feed 里的图改掉或截断
  assert.equal(feed.news[0].images!.length, 3);
  assert.equal(feed.news[2].images!.length, 2);
});

test('selectImagesToLocalize：imagesPerItem=1 时每条只留 cover（无 cover 才取第一张图）', () => {
  const feed = makeFeed({
    news: [
      news('v', '2026-11-24T10:00:00+08:00', [], 'https://i0.hdslb.com/v-cover.jpg'),
      news('p', '2026-11-23T10:00:00+08:00', ['https://i0.hdslb.com/p1.jpg', 'https://i0.hdslb.com/p2.jpg']),
    ],
  });
  const picked = selectImagesToLocalize(feed, { ...QUOTA, imagesPerItem: 1 });
  assert.deepEqual(picked.map(p => p.url), ['https://i0.hdslb.com/v-cover.jpg', 'https://i0.hdslb.com/p1.jpg']);
});

test('selectImagesToLocalize：同图跨条目只下一次，maxFiles 截断全局数量', () => {
  const shared = 'https://i0.hdslb.com/shared.jpg';
  const feed = makeFeed({
    news: [
      news('n1', '2026-11-24T10:00:00+08:00', [shared, 'https://i0.hdslb.com/n1b.jpg']),
      news('n2', '2026-11-23T10:00:00+08:00', [shared, 'https://i0.hdslb.com/n2b.jpg']),
      news('n3', '2026-11-22T10:00:00+08:00', ['https://i0.hdslb.com/n3a.jpg']),
    ],
  });

  const all = selectImagesToLocalize(feed, QUOTA);
  // shared 只出现一次；n2 的额度不被重复的 shared 占掉，因此取到 n2b
  assert.deepEqual(all.map(p => p.url), [
    shared,
    'https://i0.hdslb.com/n1b.jpg',
    'https://i0.hdslb.com/n2b.jpg',
    'https://i0.hdslb.com/n3a.jpg',
  ]);

  const capped = selectImagesToLocalize(feed, { ...QUOTA, maxFiles: 2 });
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map(p => p.news_id), ['n1', 'n1']);
});

test('selectImagesToLocalize：非 http 地址（相对路径 / data:）不进候选，时间不可解析的排最后', () => {
  const feed = makeFeed({
    news: [
      news('bad', 'not-a-date', ['img/already-local.jpg', 'https://i0.hdslb.com/bad.jpg']),
      news('good', '2026-11-24T10:00:00+08:00', ['data:image/png;base64,AAAA', 'https://i0.hdslb.com/good.jpg']),
    ],
  });
  const picked = selectImagesToLocalize(feed, QUOTA);
  assert.deepEqual(picked.map(p => p.url), ['https://i0.hdslb.com/good.jpg', 'https://i0.hdslb.com/bad.jpg']);
});

// ——————————————————————— localizeImages：新闻图本地化 + 字节配额 ———————————————————————

const IMG_BYTES = 200;
/** 假下载器：返回固定 200 字节的 png，不联网 */
const fakeFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => Buffer.alloc(IMG_BYTES, 7).buffer,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
});

const localName = (url: string) => `img/${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}.png`;

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  return { root, publicDir: path.join(root, 'public/img'), docsDir: path.join(root, 'docs/img') };
}

test('localizeImages：新闻图与封面纳入本地化，超出字节配额的长尾保留 B 站原链并计入 manifest', async () => {
  const dirs = tmpDirs();
  try {
    const iconUrl = 'https://i0.hdslb.com/icon.png';
    const posterUrl = 'https://i0.hdslb.com/poster.jpg';
    const coverUrl = 'https://i0.hdslb.com/cover.jpg';
    const imageA = 'https://i0.hdslb.com/n1a.jpg';
    const imageB = 'https://i0.hdslb.com/n1b.jpg';
    const feed = makeFeed({
      data: { games: [{ key: 'endfield', icon_url: iconUrl, preview_images: [] as string[] }] },
      media: { items: [{ id: 'm1', poster_url: posterUrl }] },
      news: [news('n1', '2026-11-24T10:00:00+08:00', [imageA, imageB], coverUrl)],
    });

    // 450 字节预算：图标 200 + poster 200 用完后，封面与新闻图一律超配额
    const result = await localizeImages(feed, {}, {
      ...dirs,
      fetchImpl: fakeFetch,
      quota: { maxBytes: 450 },
      now: Date.parse('2026-11-24T12:00:00+08:00'),
      log: () => {},
      warn: () => {},
    });

    assert.equal(result.feed.data.games[0].icon_url, localName(iconUrl));
    assert.equal(result.feed.media.items[0].poster_url, localName(posterUrl));
    // 超配额的新闻图保留官方原链（不写坏地址、不截断）
    assert.equal(result.feed.news[0].cover, coverUrl);
    assert.deepEqual(result.feed.news[0].images, [imageA, imageB]);

    assert.equal(result.stats.downloaded, 2);
    assert.equal(result.stats.skipped, 2);
    assert.equal(result.stats.bytes, IMG_BYTES * 2);
    assert.equal(result.stats.candidates, 4);

    // manifest 形状：{ url: { local, sha1, bytes, first_seen } }，只记录真正落盘的条目
    assert.deepEqual(Object.keys(result.manifest).sort(), [iconUrl, posterUrl].sort());
    const entry = result.manifest[iconUrl];
    assert.equal(entry.local, localName(iconUrl));
    assert.equal(entry.bytes, IMG_BYTES);
    assert.equal(entry.sha1, crypto.createHash('sha1').update(Buffer.alloc(IMG_BYTES, 7)).digest('hex'));
    assert.equal(entry.first_seen, '2026-11-24T04:00:00.000Z');
    // 文件确实落到注入的临时目录，而不是 docs/
    assert.ok(fs.existsSync(path.join(dirs.docsDir, path.basename(entry.local))));
    assert.ok(fs.existsSync(path.join(dirs.publicDir, path.basename(entry.local))));
    // 旧契约仍然可用：cache 是 url → img/xxx 的映射
    assert.equal(result.cache[iconUrl], localName(iconUrl));
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('localizeImages：字节预算充足时按 newsMaxItems / imagesPerItem 落盘，名额外的图保留原链', async () => {
  const dirs = tmpDirs();
  try {
    const coverUrl = 'https://i0.hdslb.com/c-cover.jpg';
    const first = 'https://i0.hdslb.com/c1.jpg';
    const second = 'https://i0.hdslb.com/c2.jpg';
    const older = 'https://i0.hdslb.com/old.jpg';
    const feed = makeFeed({
      data: { games: [] },
      media: { items: [] },
      news: [
        news('new', '2026-11-24T10:00:00+08:00', [first, second], coverUrl),
        news('old', '2026-10-01T10:00:00+08:00', [older]),
      ],
    });

    const result = await localizeImages({ ...feed, news: feed.news }, {}, {
      ...dirs,
      fetchImpl: fakeFetch,
      quota: { newsMaxItems: 1, imagesPerItem: 2, maxBytes: 10_000_000, maxFiles: 4000 },
      now: Date.parse('2026-11-24T12:00:00+08:00'),
      log: () => {},
      warn: () => {},
    });

    assert.equal(result.feed.news[0].cover, localName(coverUrl));
    assert.deepEqual(result.feed.news[0].images, [localName(first), second]);
    // 不在最新 N 条窗口内的资讯完全不动
    assert.deepEqual(result.feed.news[1].images, [older]);
    assert.equal(result.stats.downloaded, 2);
    assert.equal(result.stats.skipped, 0);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('localizeImages：同一目录重跑命中持久缓存，不再重复下载（扩展名被 content-type 纠正也认得）', async () => {
  const dirs = tmpDirs();
  try {
    const url = 'https://i0.hdslb.com/n1-cover.jpg';   // URL 是 .jpg，但下载回来是 png
    const feed = makeFeed({
      data: { games: [] },
      media: { items: [] },
      news: [news('n1', '2026-11-24T10:00:00+08:00', [], url)],
    });
    const opts = {
      ...dirs,
      fetchImpl: fakeFetch,
      quota: { newsMaxItems: 10, imagesPerItem: 2, maxBytes: 10_000_000, maxFiles: 100 },
      now: Date.parse('2026-11-24T12:00:00+08:00'),
      log: () => {},
      warn: () => {},
    } as const;

    const first = await localizeImages(feed, {}, opts);
    assert.equal(first.stats.downloaded, 1);
    const localRel = first.feed.news[0].cover;
    assert.equal(localRel, localName(url));   // 落盘扩展名以 content-type 为准（.png）

    // 第二轮：真实抓取会重建 feed（图又变回远程地址），文件已存在（名字前缀 = 地址 sha1 前 16 位）应直接命中
    const feedAgain = makeFeed({
      data: { games: [] },
      media: { items: [] },
      news: [news('n1', '2026-11-24T10:00:00+08:00', [], url)],
    });
    const second = await localizeImages(feedAgain, first.cache, { ...opts });
    assert.equal(second.stats.downloaded, 0);
    assert.equal(second.stats.cached, 1);
    assert.equal(second.feed.news[0].cover, localRel);
    // first_seen 跨轮保留，便于判断哪些图是历史存量
    assert.equal(second.manifest[url].first_seen, first.manifest[url].first_seen);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ——————————————————————— applyCdn：三地址映射 ———————————————————————

test('applyCdn：单字段产出 CDN 主字段 + Pages fallback + 相对路径 local', () => {
  const feed = makeFeed({ news: [news('n1', '2026-11-24T10:00:00+08:00', [], 'img/cover-n1.jpg')] });
  applyCdn(feed);

  assert.equal(feed.data.games[0].icon_url, CDN('img/icon-endfield.png'));
  assert.equal(feed.data.games[0].icon_url_fallback, PAGES('img/icon-endfield.png'));
  assert.equal(feed.data.games[0].icon_url_local, 'img/icon-endfield.png');
  // 口径钉死：jsDelivr 走仓库内真实路径 docs/img/…，Pages 的站点根就是 docs
  assert.equal(
    feed.data.games[0].icon_url,
    `https://cdn.jsdelivr.net/gh/${SITE.owner}/${SITE.repo}@${SITE.branch}/docs/img/icon-endfield.png`,
  );
  assert.equal(feed.data.games[0].icon_url_fallback, `${SITE.pagesBase}/img/icon-endfield.png`);

  assert.equal(feed.media.items[0].poster_url, CDN('img/poster-m1.jpg'));
  assert.equal(feed.media.items[0].poster_url_fallback, PAGES('img/poster-m1.jpg'));
  assert.equal(feed.media.items[0].poster_url_local, 'img/poster-m1.jpg');

  assert.equal(feed.news[0].cover, CDN('img/cover-n1.jpg'));
  assert.equal(feed.news[0].cover_fallback, PAGES('img/cover-n1.jpg'));
  assert.equal(feed.news[0].cover_local, 'img/cover-n1.jpg');
  assert.equal(feed.news[0].image_status, undefined);
});

test('applyCdn：数组字段的 fallback/local 与主字段等长同序', () => {
  const feed = makeFeed({
    data: { games: [{ key: 'genshin', icon_url: 'img/icon-genshin.png', preview_images: ['img/p1.jpg', 'img/p2.jpg'] }] },
    news: [news('n1', '2026-11-24T10:00:00+08:00', ['img/n1a.jpg', 'img/n1b.jpg'], 'img/n1-cover.jpg')],
  });
  applyCdn(feed);

  assert.deepEqual(feed.data.games[0].preview_images, [CDN('img/p1.jpg'), CDN('img/p2.jpg')]);
  assert.deepEqual(feed.data.games[0].preview_images_fallback, [PAGES('img/p1.jpg'), PAGES('img/p2.jpg')]);
  assert.deepEqual(feed.data.games[0].preview_images_local, ['img/p1.jpg', 'img/p2.jpg']);

  assert.deepEqual(feed.news[0].images, [CDN('img/n1a.jpg'), CDN('img/n1b.jpg')]);
  assert.deepEqual(feed.news[0].images_fallback, [PAGES('img/n1a.jpg'), PAGES('img/n1b.jpg')]);
  assert.deepEqual(feed.news[0].images_local, ['img/n1a.jpg', 'img/n1b.jpg']);
  // 空数组不产出多余字段，避免喂大 feed.json
  assert.equal(feed.data.games[0].preview_images_fallback.length, 2);
});

test('applyCdn：外链（B 站原图）主字段保持原样，资讯标 image_status=external', () => {
  const external = 'https://i0.hdslb.com/bfs/new_dyn/abc.jpg';
  const feed = makeFeed({
    news: [
      news('mixed', '2026-11-24T10:00:00+08:00', ['img/local1.jpg', external], 'img/cover.jpg'),
      news('pure', '2026-11-23T10:00:00+08:00', [], 'img/cover2.jpg'),
    ],
  });
  const stats = applyCdnWithStats(feed);

  // 混合条目：本地图照常 CDN 化，外链保持原地址且同序
  assert.equal(feed.news[0].images[0], CDN('img/local1.jpg'));
  assert.equal(feed.news[0].images[1], external);
  assert.equal(feed.news[0].images_fallback[1], external);
  assert.equal(feed.news[0].images_local[1], external);
  assert.equal(feed.news[0].image_status, 'external');

  // 全本地的条目不打 external
  assert.equal(feed.news[1].image_status, undefined);
  assert.equal(stats.external, 1);
  assert.equal(stats.external_news, 1);
});

test('applyCdn：幂等，且能识别已是 CDN / Pages / raw 的地址', () => {
  const feed = makeFeed({ news: [news('n1', '2026-11-24T10:00:00+08:00', ['img/a.jpg'])] });
  applyCdn(feed);
  const snapshot = JSON.stringify(feed.news[0]);
  applyCdn(feed);
  assert.equal(JSON.stringify(feed.news[0]), snapshot);

  assert.equal(repoRel(CDN('img/a.jpg')), 'img/a.jpg');
  assert.equal(repoRel(PAGES('img/a.jpg')), 'img/a.jpg');
  // raw 与 CDN 都指向仓库内真实路径（docs/img/…），归一化后要回到「相对 docs 根」
  assert.equal(repoRel(`https://raw.githubusercontent.com/${SITE.owner}/${SITE.repo}/${SITE.branch}/docs/img/a.jpg`), 'img/a.jpg');
  assert.equal(repoRel('https://i0.hdslb.com/x.jpg'), null);
  assert.equal(repoRel('img/a.jpg'), 'img/a.jpg');
  // 已经是 docs 前缀的输入不会叠成 docs/docs
  assert.equal(repoRel('docs/img/a.jpg'), 'img/a.jpg');
  assert.equal(CDN(repoRel('docs/img/a.jpg')!), CDN('img/a.jpg'));
  assert.equal(repoRel(''), null);
  assert.equal(repoRel(null), null);
});

test('applyCdn：缺字段 / 空数组的 feed 不抛错（构建降级路径）', () => {
  const feed: any = { data: { games: [{ key: 'x' }] }, media: { items: [{ id: 'm' }] }, news: [{ id: 'n' }] };
  assert.doesNotThrow(() => applyCdn(feed));
  assert.equal(feed.data.games[0].icon_url_fallback, undefined);
});
