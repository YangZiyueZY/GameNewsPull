// 离线测试：异环官网公告（nte-site，L0）——限定棋盘（pact）解析。
// 全部 fixture 都在 data/fixtures/sources 下（真实响应的裁剪快照），测试用 offline ctx，绝不联网。
// data/source-cache/ 是运行时缓存，会被每日抓取覆盖，禁止用于断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import type { PoolCandidate, SourceContext } from '../apps/crawler/src/pools/types.ts';
import {
  nteSiteAdapter,
  collectNteSite,
  collectNteSiteRoster,
  parseNteListHtml,
  parseNteArticleHtml,
  findNteMaintenance,
  findNteStaleEnds,
  mergeNtePools,
  applyNteStaleEnds,
  findNtePoolName,
} from '../apps/crawler/src/sources/nte/site.ts';
import type { NteListItem, NteSitePool } from '../apps/crawler/src/sources/nte/site.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = resolve(ROOT, 'data/fixtures/sources');
/** 固定「当前时间」：2026-11-26T14:00:00+08:00 */
const NOW = Date.parse('2026-11-26T14:00:00+08:00');

function offlineCtx(overrides: Partial<SourceContext> = {}): SourceContext {
  const logs: string[] = [];
  return Object.assign({
    now: NOW,
    nowCst: '2026-11-26T14:00:00+08:00',
    cacheDir: CACHE_DIR,
    dataDir: resolve(ROOT, 'data'),
    offline: true,
    log: (...args: unknown[]) => { logs.push(args.map((a) => String(a)).join(' ')); },
  }, overrides) as SourceContext;
}

/** 读一份离线快照（与 withSourceCache 落盘格式一致：{ cached_at, data: { url, html } }） */
function fixture(cacheId: string): { url: string; html: string } {
  const payload = JSON.parse(fs.readFileSync(resolve(CACHE_DIR, cacheId + '.json'), 'utf8'));
  return payload.data as { url: string; html: string };
}

/** 从真实列表快照里取某篇正文的列表条目（标题/日期/链接都来自列表页） */
function listItem(articleId: string): NteListItem {
  for (const id of ['nte-site-list-gamenews', 'nte-site-list-gamenews-2', 'nte-site-list-news', 'nte-site-list-gameevent']) {
    const hit = parseNteListHtml(fixture(id).html).find((it) => it.articleId === articleId);
    if (hit) return hit;
  }
  throw new Error('列表快照里找不到正文 ' + articleId);
}

function find(pools: PoolCandidate[], name: string): PoolCandidate {
  const hit = pools.find((p) => p.pool_name === name);
  assert.ok(hit, '未找到棋盘 ' + name + '，实际有: ' + pools.map((p) => p.pool_name).join(', '));
  return hit!;
}

// ————————————————— 元信息 —————————————————

test('nte-site：适配器元信息与接口形状', () => {
  assert.equal(nteSiteAdapter.id, 'nte-site');
  assert.equal(nteSiteAdapter.tier, 'L0');
  assert.deepEqual(nteSiteAdapter.games, ['yh']);
  assert.equal(typeof nteSiteAdapter.collect, 'function');
  assert.equal(typeof nteSiteAdapter.roster, 'function');
  assert.match(nteSiteAdapter.label, /异环/);
});

// ————————————————— 列表页 —————————————————

test('nte-site：列表页解析（标题/日期/链接，3 条一页）', () => {
  const items = parseNteListHtml(fixture('nte-site-list-gamenews').html);
  assert.equal(items.length, 3, '公告列表首页 3 条');
  assert.deepEqual(items.map((it) => it.articleId), ['264946', '264673', '264407']);
  const first = items[0];
  assert.equal(first.path, '/cn/article/news/gamenews/20261109/264946.html');
  assert.equal(first.url, 'https://nte.perfectworld.com/cn/article/news/gamenews/20261109/264946.html');
  assert.equal(first.category, 'gamenews');
  assert.equal(first.date, '2026-11-09');
  assert.equal(first.title, '1.5版本「致电，空想迷数」更新公告');

  // 三个列表页都可用；「最新」页与公告页存在重复条目，由采集端按 path 去重
  const news = parseNteListHtml(fixture('nte-site-list-news').html);
  assert.equal(news.length, 3);
  assert.equal(news[0].date, '2026-11-23');
  const gameevent = parseNteListHtml(fixture('nte-site-list-gameevent').html);
  assert.ok(gameevent.every((it) => it.category === 'gameevent'));
});

// ————————————————— 离线采集 —————————————————

test('nte-site：离线只读缓存采集（禁止联网），解析出 5 个限定棋盘', async () => {
  const logs: string[] = [];
  const ctx = offlineCtx({ log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error('offline 测试不允许联网'); }) as typeof fetch;
  let pools: PoolCandidate[];
  try {
    pools = await nteSiteAdapter.collect(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, 'offline 模式不得发起任何请求');

  assert.deepEqual(
    pools.map((p) => p.pool_name),
    ['电子人之梦', '破晓前', '灿烂的星', '预言终幕时', '久梦初醒时'],
    '新公告在前',
  );

  // 1.5 更新公告：曳尔沐 / 「电子人之梦」
  const xm = find(pools, '电子人之梦');
  assert.equal(xm.game_key, 'yh');
  assert.equal(xm.pool_type, 'pact');
  assert.deepEqual(xm.characters, ['曳尔沐']);
  assert.equal(xm.version, '1.5');
  // 起点 = 同篇「更新维护时间：2026年11月11日06:00 - 11:00(UTC+8)」的结束时刻
  assert.equal(xm.start_at, '2026-11-11T11:00:00+08:00', '「版本更新后」应由同篇维护结束时刻锚定');
  // 终点 = 「…-12月2日05:59(UTC+8)」
  assert.equal(xm.end_at, '2026-12-02T05:59:00+08:00');
  // published_at = 列表页日期当天 12:00 +08:00
  assert.equal((xm as NteSitePool).published_at, '2026-11-09T12:00:00+08:00');
  assert.match(String(xm.note), /维护结束时刻锚定/);
  assert.equal(xm.source.id, 'nte-site');
  assert.equal(xm.source.tier, 'L0');
  assert.equal(xm.source.url, 'https://nte.perfectworld.com/cn/article/news/gamenews/20261109/264946.html');
  assert.match(String(xm.source.fetched_at), /\+08:00$/);
  // evidence 必须是截断正文（含原文关键句）
  assert.match(String(xm.evidence), /限定S级角色「曳尔沐」/);
  assert.match(String(xm.evidence), /棋盘说明：可通过「电子人之梦」限定棋盘/);
  assert.ok(String(xm.evidence).length <= 200, 'evidence 需截断');

  // 复刻/返场只写进 note，池类型仍是 pact
  const rerun = find(pools, '破晓前');
  assert.equal(rerun.pool_type, 'pact');
  assert.deepEqual(rerun.characters, ['真红']);
  assert.equal(rerun.start_at, '2026-11-11T11:00:00+08:00');
  assert.equal(rerun.end_at, '2026-12-02T05:59:00+08:00');
  assert.match(String(rerun.note), /返场/);

  // 上一期：「灿烂的星」（10月21日停服维护公告，原文写「维护更新后」）
  const past = find(pools, '灿烂的星');
  assert.deepEqual(past.characters, ['明音凛']);
  assert.equal(past.start_at, '2026-10-21T11:00:00+08:00', '「维护更新后」同样由同篇维护结束锚定');
  assert.equal(past.end_at, '2026-11-11T05:59:00+08:00');
  assert.match(String(past.note), /※ 行一致/, '更晚公告的 ※ 行应留痕');

  // 1.4 更新公告：黑羽 / 安魂曲（返场）
  assert.deepEqual(find(pools, '预言终幕时').characters, ['黑羽']);
  assert.equal(find(pools, '预言终幕时').end_at, '2026-10-21T05:59:00+08:00');
  assert.deepEqual(find(pools, '久梦初醒时').characters, ['安魂曲']);
  assert.match(String(find(pools, '久梦初醒时').note), /返场/);

  for (const p of pools) {
    assert.equal(p.pool_type, 'pact', '异环「限定棋盘」统一归 pact');
    assert.equal(p.game_key, 'yh');
    assert.ok(p.characters.length > 0, '不允许产出空角色池: ' + p.pool_name);
    for (const t of [p.start_at, p.end_at]) {
      if (t) assert.match(t, /\+08:00$/, '时间必须带东八区偏移: ' + t);
    }
  }

  // ※ 行提到的「全频带漫游中！」不在本次正文窗口内 → 忽略（不得凭空造池）
  assert.ok(!pools.some((p) => p.pool_name === '全频带漫游中！'));
  assert.ok(logs.some((l) => l.includes('全频带漫游中！') && l.includes('忽略')), '应打出忽略日志: ' + logs.join(' | '));
});

// ————————————————— 时间锚定 —————————————————

test('nte-site：同篇缺少维护窗口时「版本更新后」→ start_at=null（不近似）', () => {
  const html = fixture('nte-site-article-264946').html.replace('● 更新维护时间：2026年11月11日06:00 - 11:00(UTC+8)', '');
  // 把维护窗口那一行从快照里去掉，模拟「同篇没有维护锚点」的公告
  assert.equal(findNteMaintenance(html.split('\n')), null);
  const parsed = parseNteArticleHtml(html, listItem('264946'), '2026-11-26T14:00:00+08:00');
  assert.equal(parsed.pools.length, 2);
  const xm = parsed.pools[0];
  assert.equal(xm.pool_name, '电子人之梦');
  assert.equal(xm.start_at, null, '无锚点时起点必须为 null');
  assert.match(String(xm.note), /无同日维护窗口/);
  // 终点仍能解析
  assert.equal(xm.end_at, '2026-12-02T05:59:00+08:00');
});

test('nte-site：维护窗口解析（同日结束时刻锚点）', () => {
  const a = findNteMaintenance(['● 更新维护时间：2026年11月11日06:00 - 11:00(UTC+8)']);
  assert.ok(a);
  assert.equal(a!.endIso, '2026-11-11T11:00:00+08:00');
  assert.equal(a!.month, 11);
  assert.equal(a!.day, 11);
  const b = findNteMaintenance(['● 维护时间：2026年10月21日 06:00 - 11:00(UTC+8)']);
  assert.equal(b!.endIso, '2026-10-21T11:00:00+08:00');
  assert.equal(findNteMaintenance(['亲爱的鉴定师：', '维护完成后请重启客户端']), null);
});

// ————————————————— ※ 行补 end —————————————————

test('nte-site：※ 行补上一期 end_at（缺失才补、不在窗口内则忽略）', () => {
  const logs: string[] = [];
  // 上一期「灿烂的星」所在公告（2026-10-19）
  const past = parseNteArticleHtml(fixture('nte-site-article-264673').html, listItem('264673'), '2026-11-26T14:00:00+08:00');
  // 更晚公告（2026-11-09）里的 ※ 行
  const later = parseNteArticleHtml(fixture('nte-site-article-264946').html, listItem('264946'), '2026-11-26T14:00:00+08:00');
  const stale = later.staleEnds.find((s) => s.pool_name === '灿烂的星');
  assert.ok(stale, '※ 行应解析出「灿烂的星」的结束时间');
  assert.equal(stale!.end_at, '2026-11-11T05:59:00+08:00');

  // 场景一：更早公告只给了起点 → 由 ※ 行补齐
  const pools = mergeNtePools(past.pools);
  const target = pools.find((p) => p.pool_name === '灿烂的星')!;
  assert.equal(target.end_at, '2026-11-11T05:59:00+08:00', '原文本身已给终点');
  target.end_at = null; // 模拟更早公告缺终点
  applyNteStaleEnds(pools, [stale!], (...a: unknown[]) => logs.push(a.map(String).join(' ')));
  assert.equal(target.end_at, '2026-11-11T05:59:00+08:00', 'end_at 应由 ※ 行补齐');
  assert.match(String(target.note), /补自更晚公告/);

  // 场景二：池不在窗口内 → 忽略并打日志（不凭空造池）
  const before = pools.length;
  applyNteStaleEnds(pools, [{ pool_name: '生命线', end_at: '2026-08-19T05:59:00+08:00', raw: '', article_id: '263608', published_at: null }], (...a: unknown[]) => logs.push(a.map(String).join(' ')));
  assert.equal(pools.length, before);
  assert.ok(logs.some((l) => l.includes('生命线') && l.includes('忽略')));

  // 场景三：与原文不一致 → 保留正文值
  const conflict: string[] = [];
  applyNteStaleEnds(pools, [{ pool_name: '灿烂的星', end_at: '2026-11-12T05:59:00+08:00', raw: '', article_id: 'x', published_at: null }], (...a: unknown[]) => conflict.push(a.map(String).join(' ')));
  assert.equal(target.end_at, '2026-11-11T05:59:00+08:00', '冲突时保留正文值');
  assert.ok(conflict.some((l) => l.includes('冲突')));
});

test('nte-site：正则会挑出「可通过「X」限定棋盘」形式的池名', () => {
  assert.equal(findNtePoolName(['棋盘说明：可通过「电子人之梦」限定棋盘获得S级角色「曳尔沐」。']), '电子人之梦');
  assert.equal(findNtePoolName(['活动期间，限定棋盘「破晓前」内新增：滑翔翼涂装「蔽日之影」']), '破晓前');
  // ※ 行是上一期的说明，不能当本块池名
  assert.equal(findNtePoolName(['※当期明音凛「灿烂的星」限定棋盘将于2026年11月11日 05:59(UTC+8)结束']), null);
  assert.equal(findNtePoolName(['● 全新限定S级角色「曳尔沐」', '开放时间：11月11日版本更新后']), null);
});

// ————————————————— 失败处理 —————————————————

test('nte-site：离线且缓存缺失时返回 []（不编造、有日志）', async () => {
  const logs: string[] = [];
  const ctx = offlineCtx({
    cacheDir: resolve(ROOT, 'data/__no-such-cache__'),
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  });
  const pools = await collectNteSite(ctx);
  assert.deepEqual(pools, []);
  assert.ok(logs.some((l) => l.includes('nte-site')), '应打出失败日志: ' + logs.join(' | '));
});

test('nte-site：正文页缺失时逐篇跳过（只取最新 12 篇）', async () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'nte-site-offline-'));
  try {
    // 只放列表页快照 + 1.5 更新公告正文，其余 11 篇正文故意缺失
    for (const id of [
      'nte-site-list-gamenews', 'nte-site-list-gamenews-2',
      'nte-site-list-news', 'nte-site-list-news-2',
      'nte-site-list-gameevent', 'nte-site-list-gameevent-2',
      'nte-site-article-264946',
    ]) {
      fs.copyFileSync(resolve(CACHE_DIR, id + '.json'), join(tmp, id + '.json'));
    }
    const logs: string[] = [];
    const pools = await collectNteSite(offlineCtx({ cacheDir: tmp, log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) }));
    assert.deepEqual(pools.map((p) => p.pool_name), ['电子人之梦', '破晓前'], '只应解析出缓存里那篇公告的棋盘');
    const skipped = logs.filter((l) => l.includes('正文') && l.includes('跳过'));
    assert.equal(skipped.length, 11, '最新 12 篇里其余 11 篇正文缺失应逐篇跳过: ' + logs.join(' | '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ————————————————— roster —————————————————

test('nte-site：roster 从正文抽「限定S级角色」补全 yh 角色字典', async () => {
  const roster = await collectNteSiteRoster(offlineCtx());
  const names = roster.map((r) => r.cn);
  for (const expected of ['曳尔沐', '真红', '明音凛', '黑羽', '安魂曲']) {
    assert.ok(names.indexOf(expected) >= 0, '缺少角色 ' + expected + '，实际: ' + names.join(','));
  }
  for (const entry of roster) {
    assert.equal(entry.game_key, 'yh');
    assert.ok(entry.cn.length > 0);
  }
  // 去重
  assert.equal(new Set(names).size, names.length);
});
