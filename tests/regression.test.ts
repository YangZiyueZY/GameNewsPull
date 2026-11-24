// 第二轮回归测试：HSR 深度卡池快照 / store raw 压缩等价 / 下个节点语义。
// 数据来自 data/fixtures，无需联网与 Cookie。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { normalizeDynamic } from '../apps/crawler/src/extract/normalize.ts';
import type { NewsItem } from '../apps/crawler/src/extract/normalize.ts';
import { parseBannerAnnouncements, buildBanners } from '../apps/crawler/src/extract/banners.ts';
import { extractVersion, buildFeed } from '../apps/crawler/src/extract/feed.ts';
import { compactRaw } from '../apps/crawler/src/store/json.ts';
import { GAMES } from '../apps/crawler/config/games.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (file: string): { captured_at: string; mid: string; items: any[] } =>
  JSON.parse(readFileSync(resolve(ROOT, 'data/fixtures', file), 'utf8'));
const gameOf = (key: string) => GAMES.find((g) => g.key === key)!;
function normalized(file: string, gameKey: string): NewsItem[] {
  const game = gameOf(gameKey);
  return fixture(file).items
    .map((raw) => normalizeDynamic(raw, game))
    .filter((item): item is NewsItem => item !== null);
}

// ——————————————————————— HSR 深度快照卡池解析 ———————————————————————

test('HSR 深度快照含两条关键公告', () => {
  const deep = fixture('hsr-banners.json');
  assert.equal(deep.mid, '1340190821');
  assert.ok(deep.items.length > 0);
  for (const id of ['1268910294088810533', '1269281379227533315']) {
    assert.ok(deep.items.some((it) => it.id_str === id), '深度快照应包含 ' + id);
  }
});

test('HSR parseBannerAnnouncements 得到 4.7 期（起止时间与 4 名角色）', () => {
  const periods = parseBannerAnnouncements(normalized('hsr-banners.json', 'hsr'));
  const p = periods.find((x) => x.version === '4.7');
  assert.ok(p, '应解析出 4.7 版本卡池期次');
  assert.equal(p!.start, '2026-11-11T00:00:00+08:00');
  assert.equal(p!.end, '2026-12-22T15:00:00+08:00');
  for (const name of ['星神★阿哈', '银狼LV.999', '火花', '爻光']) {
    assert.ok(p!.characters.includes(name), '4.7 期应包含角色 ' + name);
  }
});

test('HSR buildBanners 只返回未结束期次，且角色完整', () => {
  const banners = buildBanners('hsr', normalized('hsr-banners.json', 'hsr'));
  assert.ok(banners.length >= 1, '应至少返回当前期次');
  for (const b of banners) assert.notEqual(b.status, '已结束', 'HSR 不应显示已结束期次（4.6 应被过滤）');
  const current = banners.find((b) => b.start_at === '2026-11-11T00:00:00+08:00');
  assert.ok(current, '应包含 4.7 期');
  assert.equal(current!.end_at, '2026-12-22T15:00:00+08:00');
  for (const name of ['星神★阿哈', '银狼LV.999', '火花', '爻光']) {
    assert.ok(current!.characters.includes(name), '4.7 期 characters 应含 ' + name);
  }
});

// ——————————————————————— store raw 压缩 ———————————————————————

test('compactRaw 后 normalizeDynamic 结果等价，且幂等', () => {
  const game = gameOf('genshin');
  let totalOriginal = 0;
  let totalCompacted = 0;
  for (const raw of fixture('genshin.json').items) {
    const compactedStr = compactRaw(raw);
    const compacted = JSON.parse(compactedStr);
    const before = normalizeDynamic(raw, game);
    const after = normalizeDynamic(compacted, game);
    assert.ok(before && after, '压缩前后都应能 normalize');
    for (const field of ['title', 'summary', 'images', 'type', 'url'] as const) {
      assert.deepEqual(after![field], before![field], raw.id_str + ' 的 ' + field + ' 压缩后应一致');
    }
    assert.equal(compactRaw(compacted), compactedStr, raw.id_str + ' 的 compactRaw 应幂等');
    totalOriginal += JSON.stringify(raw).length;
    totalCompacted += compactedStr.length;
  }
  assert.ok(totalCompacted < totalOriginal, '压缩后总体积应明显小于原始体积');
  assert.ok(totalCompacted * 5 < totalOriginal, '压缩应有数量级收益（约 10x）');
});

// ——————————————————————— 下个节点语义 ———————————————————————

// fixture 快照时间：第 2 期卡池（11-24 18:00）当时尚未开始。
// 固定时钟避免测试随真实时间漂移（开池后「下个节点」语义会自然变化）。
const FIXTURE_NOW = Date.parse(fixture('genshin.json').captured_at);

test('原神无更高版本时，下个节点取未开始的 7.2 第 2 期卡池期次', () => {
  const items = normalized('genshin.json', 'genshin');
  const state = extractVersion(items, 'genshin', FIXTURE_NOW);
  assert.equal(state.nextKind, 'phase');
  assert.ok(state.next, '应有下个节点');
  assert.match(state.next!.label, /第 2 期/, 'label 应含「第 2 期」');
  assert.equal(state.nextRelease, new Date('2026-11-24T18:00:00+08:00').getTime());
});

test('buildFeed 输出 next_version_kind=phase，next_version 含第 2 期', () => {
  const items = normalized('genshin.json', 'genshin');
  const feed = buildFeed(items, [gameOf('genshin')], {}, { now: FIXTURE_NOW });
  const g = feed.data.games[0];
  assert.equal(g.next_version_kind, 'phase');
  assert.match(g.next_version, /第 2 期/);
});
