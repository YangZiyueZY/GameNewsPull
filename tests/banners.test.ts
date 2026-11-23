// 离线回归测试：祈愿公告 → 卡池期次抽取。
// 数据来自 data/fixtures（B 站官方账号首屏快照），无需联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { normalizeDynamic } from '../apps/crawler/src/extract/normalize.ts';
import type { NewsItem } from '../apps/crawler/src/extract/normalize.ts';
import {
  parseBannerAnnouncements,
  normalizeCharacterName,
  buildBanners,
} from '../apps/crawler/src/extract/banners.ts';
import { GAMES } from '../apps/crawler/config/games.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureItems = (key: string): any[] =>
  JSON.parse(readFileSync(resolve(ROOT, 'data/fixtures', key + '.json'), 'utf8')).items;

function normalized(key: string): NewsItem[] {
  const game = GAMES.find((g) => g.key === key)!;
  return fixtureItems(key)
    .map((raw) => normalizeDynamic(raw, game))
    .filter((item): item is NewsItem => item !== null);
}

const genshinNews = normalized('genshin');

test('normalizeCharacterName 归一化角色名', () => {
  assert.equal(normalizeCharacterName('驹隙隐泉·兹白(岩)'), '兹白');
  assert.equal(normalizeCharacterName('博闻异旅·莉奈娅(岩)'), '莉奈娅');
  assert.equal(normalizeCharacterName('「兹白」'), '兹白');
  assert.equal(normalizeCharacterName('  '), '');
});

test('parseBannerAnnouncements 从原神公告解析出角色、开池时间与版本', () => {
  const periods = parseBannerAnnouncements(genshinNews);
  assert.equal(periods.length, 1, '应只解析出一期官方卡池');
  const p = periods[0];
  assert.deepEqual(p.characters, ['兹白', '莉奈娅']);
  assert.equal(p.start, '2026-11-24T18:00:00+08:00');
  assert.equal(p.end, '2026-12-15T14:59:00+08:00');
  assert.equal(p.version, '7.2');
  assert.equal(p.source, 'bilibili');
  assert.match(p.label, /7\.2版本/);
});

test('卡池公告本体（id 1273842634488545282）出现在 fixture 且解析结果可复现', () => {
  assert.ok(fixtureItems('genshin').some((it) => it.id_str === '1273842634488545282'));
  const announcement = genshinNews.find((n) => n.id === '1273842634488545282');
  assert.ok(announcement, '公告应能 normalize');
  const direct = parseBannerAnnouncements([announcement!]);
  assert.deepEqual(direct[0].characters, ['兹白', '莉奈娅']);
  assert.equal(direct[0].start, '2026-11-24T18:00:00+08:00');
});

test('视频/转发条目不会被误判为卡期或混入角色名', () => {
  const video = genshinNews.find((n) => n.id === '1270410171844132901');
  assert.ok(video);
  assert.equal(video!.type, 'video');
  // 只喂视频条目，不应凭空产出卡池期次
  assert.deepEqual(parseBannerAnnouncements([video!]), []);

  const endfieldNews = normalized('endfield');
  const forwards = endfieldNews.filter((n) => n.type === 'forward');
  assert.ok(forwards.length > 0, 'endfield fixture 应包含转发动态');
  for (const f of forwards) assert.ok(f.summary.length > 0 && f.images.length > 0, '转发不应被破坏');
  const fromForwards = parseBannerAnnouncements(forwards);
  assert.ok(fromForwards.every((p) => p.characters.length > 0), '解析结果角色名不应为空');
});

test('buildBanners 以人工 config 为骨架，官方公告补充角色（并集、不删人工项）', () => {
  const banners = buildBanners('genshin', genshinNews);
  assert.ok(banners.length >= 2, '应保留 config 的期次');
  const phase2 = banners.find((b) => b.start_at === '2026-11-24T18:00:00+08:00');
  assert.ok(phase2, '应存在第 2 期（开池时间与公告一致）');
  for (const name of ['兹白', '莉奈娅']) {
    assert.ok(phase2!.characters.includes(name), '第 2 期应补充官方角色 ' + name);
  }
  assert.ok(phase2!.characters.includes('莉奈娅'), '人工项莉奈娅不应被删除');
  assert.ok(['config+bilibili', 'bilibili'].includes(phase2!.source));
});

test('全部游戏 fixture 的卡池解析不抛错，角色名均合法', () => {
  for (const game of GAMES) {
    const news = normalized(game.key);
    const periods = parseBannerAnnouncements(news);
    for (const p of periods) {
      assert.ok(p.characters.length > 0, game.key + ' 的期次角色不应为空');
      for (const name of p.characters) {
        assert.ok(name.length >= 2 && name.length <= 12, game.key + ' 角色名长度异常: ' + name);
      }
      if (p.start) assert.match(p.start, /[+-]\d{2}:\d{2}$/, 'start 应带时区');
    }
    const banners = buildBanners(game.key, news);
    assert.ok(Array.isArray(banners));
  }
});
