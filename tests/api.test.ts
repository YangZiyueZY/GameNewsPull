// 离线测试：嵌入用静态 API v1（buildApiBundle 是纯函数，不联网、不写盘；落盘用临时目录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildApiBundle,
  writeApiBundle,
  API_VERSION,
  API_SCHEMA_VERSION,
  LATEST_NEWS_LIMIT,
} from '../apps/crawler/src/extract/api.ts';
import type { ApiBundle } from '../apps/crawler/src/extract/api.ts';
import { SITE } from '../apps/crawler/config/site.ts';

// 北京时间 2026-11-26 14:05:20（同一时刻的 UTC 写成 ...06:05:20Z，用于跨时区断言）
const GEN_UTC = '2026-11-26T06:05:20.000Z';
const GEN_CST = '2026-11-26T14:05:20+08:00';
const CDN_ROOT = `${SITE.cdnBase}/${SITE.owner}/${SITE.repo}@${SITE.branch}`;

const file = (bundle: ApiBundle, p: string) => {
  const hit = bundle.files.find((f) => f.path === p);
  assert.ok(hit, '缺少端点文件 ' + p);
  return hit!;
};
const json = (bundle: ApiBundle, p: string) => JSON.parse(file(bundle, p).body);

function newsItem(i: number, over: Record<string, unknown> = {}) {
  return {
    id: 'news-' + i,
    game_key: i % 2 === 0 ? 'genshin' : 'endfield',
    game_name: i % 2 === 0 ? '原神' : '明日方舟：终末地',
    type: i % 3 === 0 ? 'video' : 'dynamic',
    title: '标题 ' + i,
    summary: '摘要 ' + i,
    url: 'https://www.bilibili.com/opus/' + i,
    published_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
    images: [] as string[],
    ...over,
  };
}

function syntheticFeed() {
  const news: any[] = [
    // ① 三地址齐全：images 2 张、images_fallback 只有 1 条（验证按下标对齐，缺的回退/本地置 null）
    newsItem(101, {
      type: 'dynamic',
      published_at: '2026-11-26T05:00:00.000Z',
      images: [
        'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/a.jpg',
        'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/b.jpg',
      ],
      images_fallback: ['https://yangziyuezy.github.io/GameNewsPull/img/a.jpg'],
      images_local: ['img/a.jpg', 'img/b.jpg'],
      cover: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/c.jpg',
      cover_fallback: 'https://yangziyuezy.github.io/GameNewsPull/img/c.jpg',
      cover_local: 'img/c.jpg',
    }),
    // ② 未 cdnize / 无回退：url 取原串，fallback/local 为 null；无封面
    newsItem(102, {
      type: 'video',
      published_at: '2026-11-26T04:00:00.000Z',
      images: ['https://i0.hdslb.com/bfs/x.jpg'],
    }),
    // ③ 无图、只有封面
    newsItem(103, {
      type: 'dynamic',
      published_at: '2026-11-26T03:00:00.000Z',
      cover: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/e.jpg',
    }),
    // ④ 其余长尾：用于验证 latest 的 50 条上限
    ...Array.from({ length: 57 }, (_, i) => newsItem(i + 1)),
  ];

  const games = [
    {
      game_name: '明日方舟：终末地',
      key: 'endfield',
      icon_url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/icon-endfield.png',
      stage: 'live',
      current_up_characters: ['小刻'],
      up_banners: [{
        id: 'endfield:abc',
        game_key: 'endfield',
        label: '第 2 期',
        pool_name: '锻砧、行囊与蜜糖',
        pool_type: 'limited_character',
        pool_type_label: '限定角色',
        characters: ['小刻'],
        start_at: '2026-11-25T06:00:00+08:00',
        end_at: null,
        status: '进行中',
        days_remaining: 12,
        confidence: 'high',
        sources: [{
          id: 'hypergryph-cms',
          tier: 'L0',
          url: 'https://web-news.hypergryph.com/api/bulletin?code=endfield_web',
          fetched_at: '2026-11-26T14:00:00+08:00',
        }],
        note: null,
        source: 'hypergryph-cms',
      }],
      birthdays: [{
        character: '小刻',
        month_day: '11-26',
        next_at: '2026-11-26T00:00:00+08:00',
        days_until: 0,
        days_since: 0,
        state: 'today',
        url: null,
        source: 'official',
      }],
      events: [],
    },
    {
      game_name: '原神',
      key: 'genshin',
      // 故意保留未 cdnize 的站内相对图标：API 层要兜成绝对地址
      icon_url: 'img/icon-genshin.png',
      stage: 'live',
      current_up_characters: [],
      up_banners: [],
      birthdays: [],
      events: [],
    },
  ];

  const media = {
    categories: [{ id: 'version_pv', label: '版本 PV' }],
    items: [
      {
        id: 'endfield:BV1xx',
        game_key: 'endfield',
        game_name: '明日方舟：终末地',
        category: 'version_pv',
        category_label: '版本 PV',
        title: '《明日方舟：终末地》版本 PV',
        published_at: '2026-11-25T04:00:00.000Z',
        poster_url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/p.jpg',
        url: 'https://www.bilibili.com/video/BV1xx',
        player_url: 'https://player.bilibili.com/player.html?bvid=BV1xx',
        bvid: 'BV1xx',
        duration: '02:31',
        source: { platform: 'bilibili', official_mid: '1265652806' },
      },
      {
        id: 'genshin:BV1yy',
        game_key: 'genshin',
        game_name: '原神',
        category: 'character_pv',
        category_label: '角色 PV',
        title: '《原神》角色 PV',
        published_at: '2026-11-20T04:00:00.000Z',
        poster_url: 'img/q.jpg',   // 未 cdnize：应被兜成 CDN 绝对地址
        url: 'https://www.bilibili.com/video/BV1yy',
        player_url: 'https://player.bilibili.com/player.html?bvid=BV1yy',
        bvid: 'BV1yy',
        duration: '01:20',
        source: { platform: 'bilibili', official_mid: '401742377' },
      },
    ],
  };

  return {
    schema_version: 4,   // schema v4：新增 generated_at_utc / 卡池 confidence 等字段
    generated_at: GEN_UTC,
    publishers: [{ key: 'hypergryph', name: '鹰角网络', color: '#ffb454', order: 2 }],
    ui: { page: { title: '二游资讯' } },
    data: { games },
    media,
    news,
  };
}

const feed = syntheticFeed();
const bundle = buildApiBundle(feed);

test('index.json 自描述完整：版本号、双时间、条数、端点清单、CDN 根、说明', () => {
  const index = json(bundle, 'index.json');
  assert.equal(index.api_version, API_VERSION);
  assert.equal(index.api_version, 'v1');
  assert.equal(index.schema_version, API_SCHEMA_VERSION);

  // 东八区主时间 + UTC 并列，且是同一时刻（不依赖进程时区）
  assert.equal(index.generated_at, GEN_CST);
  assert.ok(index.generated_at.endsWith('+08:00'));
  assert.equal(index.generated_at_utc, GEN_UTC);
  assert.ok(index.generated_at_utc.endsWith('Z'));
  assert.equal(Date.parse(index.generated_at), Date.parse(index.generated_at_utc));

  assert.deepEqual(index.counts, { games: 2, news: 60, media: 2 });
  assert.ok(index.note.length > 0 && index.rate_limit_note.length > 0);

  // cdn 由 config/site.ts 生成，不硬编码域名
  assert.equal(index.cdn.api, `${CDN_ROOT}/${SITE.apiDir}`);
  assert.equal(index.cdn.images, `${CDN_ROOT}/docs/img`);

  // endpoints 必须与产出的文件一一对应（自描述不许漏项、不许写不存在的端点）
  const paths = index.endpoints.map((e: any) => e.path);
  assert.deepEqual(new Set(paths), new Set(bundle.files.map((f) => f.path)));
  assert.equal(new Set(paths).size, paths.length, '端点清单不应重复');

  for (const ep of index.endpoints) {
    assert.ok(ep.description.length > 0, ep.path + ' 缺少说明');
    assert.equal(ep.url, `${CDN_ROOT}/${SITE.apiDir}/${ep.path}`);
    assert.equal(ep.raw_url, `https://raw.githubusercontent.com/${SITE.owner}/${SITE.repo}/${SITE.branch}/${SITE.apiDir}/${ep.path}`);
    assert.equal(ep.updated_at, index.generated_at);
  }

  const countOf = (p: string) => index.endpoints.find((e: any) => e.path === p)!.count;
  assert.equal(countOf('news.json'), 60);
  assert.equal(countOf('news/latest.json'), LATEST_NEWS_LIMIT);
  assert.equal(countOf('games.json'), 2);
  assert.equal(countOf('games/endfield.json'), 1);
  assert.equal(countOf('media.json'), 2);
  assert.equal(countOf('birthdays.json'), 1);
  assert.equal(countOf('feed.json'), null);
});

test('news.json / news/latest.json：全量倒序 + 最新 50 条上限', () => {
  const news = json(bundle, 'news.json');
  const latest = json(bundle, 'news/latest.json');

  // 统一信封字段顺序与契约一致：api_version / schema_version / generated_at / generated_at_utc / count / cdn / items
  assert.deepEqual(Object.keys(news), [
    'api_version', 'schema_version', 'generated_at', 'generated_at_utc', 'count', 'cdn', 'items',
  ]);
  assert.equal(news.api_version, 'v1');
  assert.equal(news.count, news.items.length);
  assert.equal(news.items.length, feed.news.length);

  const ms = (s: string) => Date.parse(s);
  for (let i = 1; i < news.items.length; i++) {
    assert.ok(ms(news.items[i - 1].published_at) >= ms(news.items[i].published_at), 'news.json 必须按时间倒序');
  }
  assert.equal(news.items[0].id, 'news-101');

  assert.equal(latest.items.length, LATEST_NEWS_LIMIT);
  assert.equal(latest.count, LATEST_NEWS_LIMIT);
  assert.deepEqual(latest.items, news.items.slice(0, LATEST_NEWS_LIMIT));
  assert.equal(latest.items[0].id, 'news-101');
});

test('新闻图片对象化：images / cover 为 { url, fallback, local }，缺省为 null', () => {
  const news = json(bundle, 'news.json');
  const byId = (id: string) => news.items.find((i: any) => i.id === id)!;

  // ① 三地址齐全，且 fallback 按下标对齐（第二条没有 fallback 就是 null）
  const a = byId('news-101');
  assert.deepEqual(a.images, [
    {
      url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/a.jpg',
      fallback: 'https://yangziyuezy.github.io/GameNewsPull/img/a.jpg',
      local: 'img/a.jpg',
    },
    {
      url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/b.jpg',
      fallback: null,
      local: 'img/b.jpg',
    },
  ]);
  assert.deepEqual(a.cover, {
    url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/c.jpg',
    fallback: 'https://yangziyuezy.github.io/GameNewsPull/img/c.jpg',
    local: 'img/c.jpg',
  });

  // ② 只有主串：url 取原串，fallback/local 为 null
  const b = byId('news-102');
  assert.deepEqual(b.images, [{ url: 'https://i0.hdslb.com/bfs/x.jpg', fallback: null, local: null }]);
  assert.equal(b.cover, null);

  // ③ 无图、只有封面：images 为空数组而不是 undefined
  const c = byId('news-103');
  assert.deepEqual(c.images, []);
  assert.deepEqual(c.cover, { url: 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/e.jpg', fallback: null, local: null });

  // 投影后的字段集合固定，且图片对象键名稳定（嵌入方可以按结构写类型）
  assert.deepEqual(Object.keys(a), [
    'id', 'game_key', 'game_name', 'title', 'summary', 'url', 'published_at', 'type', 'images', 'cover',
  ]);
  for (const item of news.items) {
    assert.ok(Array.isArray(item.images));
    for (const img of item.images) assert.deepEqual(Object.keys(img), ['url', 'fallback', 'local']);
    if (item.cover !== null) assert.deepEqual(Object.keys(item.cover), ['url', 'fallback', 'local']);
  }
});

test('games.json / games/<key>.json：路径、game 单对象键、up_banners 的 confidence/sources', () => {
  assert.ok(bundle.files.some((f) => f.path === 'games/endfield.json'));
  assert.ok(bundle.files.some((f) => f.path === 'games/genshin.json'));

  const games = json(bundle, 'games.json');
  assert.equal(games.count, 2);
  assert.deepEqual(games.items.map((g: any) => g.key), ['endfield', 'genshin']);

  const single = json(bundle, 'games/endfield.json');
  // 单款游戏用 game 键放对象，不再有 items
  assert.ok(!('items' in single), 'games/<key>.json 不应带 items');
  assert.equal(single.api_version, 'v1');
  assert.equal(single.schema_version, API_SCHEMA_VERSION);
  assert.equal(single.generated_at, GEN_CST);
  assert.equal(single.generated_at_utc, GEN_UTC);
  assert.equal(single.count, 1);
  assert.deepEqual(single.cdn, games.cdn);
  assert.deepEqual(Object.keys(single), [
    'api_version', 'schema_version', 'generated_at', 'generated_at_utc', 'count', 'cdn', 'game',
  ]);

  assert.equal(single.game.key, 'endfield');
  assert.deepEqual(single.game, games.items.find((g: any) => g.key === 'endfield'));

  // 图片字段：已 cdnize 的远程地址原样保留，未 cdnize 的站内相对路径补成 CDN 绝对地址
  assert.equal(single.game.icon_url, 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/icon-endfield.png');
  assert.equal(games.items.find((g: any) => g.key === 'genshin').icon_url, `${CDN_ROOT}/docs/img/icon-genshin.png`);

  // 卡池的多源字段必须原样透出（契约 §3：confidence + sources[] 是嵌入方的核心诉求）
  const banner = single.game.up_banners[0];
  assert.equal(banner.confidence, 'high');
  assert.equal(banner.sources[0].id, 'hypergryph-cms');
  assert.equal(banner.sources[0].tier, 'L0');
  assert.deepEqual(banner.characters, ['小刻']);
});

test('media.json / birthdays.json：影像条目与按游戏聚合的生日', () => {
  const media = json(bundle, 'media.json');
  assert.equal(media.count, 2);
  assert.equal(media.items.length, 2);
  assert.equal(media.items[0].poster_url, 'https://cdn.jsdelivr.net/gh/o/r@main/docs/img/p.jpg');
  assert.equal(media.items[1].poster_url, `${CDN_ROOT}/docs/img/q.jpg`);

  const birthdays = json(bundle, 'birthdays.json');
  assert.equal(birthdays.count, 1, '没有生日的游戏不应占条目');
  assert.deepEqual(birthdays.items.map((g: any) => g.game_key), ['endfield']);
  assert.equal(birthdays.items[0].game_name, '明日方舟：终末地');
  assert.equal(birthdays.items[0].count, 1);
  assert.equal(birthdays.items[0].birthdays[0].character, '小刻');
  assert.equal(birthdays.items[0].birthdays[0].month_day, '11-26');
  assert.ok(!birthdays.items.some((g: any) => g.game_key === 'genshin'));
});

test('feed.json 与输入 feed 同构（不加信封、不重排）', () => {
  const mirror = json(bundle, 'feed.json');
  assert.deepEqual(mirror, JSON.parse(JSON.stringify(feed)));

  // 关键字段逐个核对（镜像必须 1:1，方便同构替换 docs/feed.json）
  assert.equal(mirror.schema_version, feed.schema_version);
  assert.equal(mirror.generated_at, feed.generated_at);
  assert.deepEqual(mirror.ui, feed.ui);
  assert.deepEqual(mirror.publishers, feed.publishers);
  assert.deepEqual(mirror.data.games.map((g: any) => g.key), feed.data.games.map((g) => g.key));
  assert.deepEqual(mirror.media, feed.media);
  assert.deepEqual(mirror.news.map((n: any) => n.id), feed.news.map((n) => n.id), '镜像不应重排资讯');
  assert.ok(!('items' in mirror) && !('api_version' in mirror));
});

test('generated_at 统一为 +08:00（Z / 已是 +08:00 / 缺失三种输入）', () => {
  // Z 输入 → 出口 +08:00，同一时刻
  const fromUtc = json(buildApiBundle(feed), 'index.json');
  assert.equal(fromUtc.generated_at, GEN_CST);
  assert.equal(fromUtc.generated_at_utc, GEN_UTC);

  // 已经是 +08:00 时保持不变（幂等，便于重复构建无 diff）
  const alreadyCst = json(buildApiBundle({ ...feed, generated_at: GEN_CST }), 'index.json');
  assert.equal(alreadyCst.generated_at, GEN_CST);
  assert.equal(alreadyCst.generated_at_utc, GEN_UTC);

  // 缺失时用注入的 now 兜底（测试可复现），并给出最小可用端点集
  const empty = buildApiBundle(
    { data: { games: [] }, news: [], media: { items: [] } },
    { now: Date.parse(GEN_UTC) },
  );
  const index = json(empty, 'index.json');
  assert.equal(index.generated_at, GEN_CST);
  assert.deepEqual(index.counts, { games: 0, news: 0, media: 0 });
  assert.deepEqual(json(empty, 'news/latest.json').items, []);
  assert.deepEqual(json(empty, 'birthdays.json').items, []);
  assert.ok(empty.files.some((f) => f.path === 'index.json'));
});

test('buildApiBundle 可重复：同一 feed 两次构建字节一致', () => {
  const again = buildApiBundle(feed);
  assert.deepEqual(again, bundle);
  for (const f of bundle.files) assert.ok(f.body.endsWith('\n'), f.path + ' 应以换行结尾');
});

test('writeApiBundle 落盘到指定 rootDir，并拒绝越界路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-v1-'));
  try {
    const written = writeApiBundle(dir, bundle);
    assert.equal(written.length, bundle.files.length);
    assert.ok(fs.existsSync(path.join(dir, 'index.json')));
    assert.ok(fs.existsSync(path.join(dir, 'news', 'latest.json')));
    assert.ok(fs.existsSync(path.join(dir, 'games', 'endfield.json')));

    const diskIndex = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(diskIndex.api_version, 'v1');
    assert.equal(diskIndex.counts.news, 60);
    const diskLatest = JSON.parse(fs.readFileSync(path.join(dir, 'news', 'latest.json'), 'utf8'));
    assert.equal(diskLatest.items.length, LATEST_NEWS_LIMIT);

    assert.throws(
      () => writeApiBundle(dir, { files: [{ path: '../escape.json', body: '{}' }] }),
      /越界/,
    );
    assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
