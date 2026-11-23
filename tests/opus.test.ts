// 离线回归测试：Opus-only 动态（desc.text 为空、正文在 major.opus）的解析。
// 数据来自 data/fixtures（B 站官方账号首屏快照），无需联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { normalizeDynamic } from '../apps/crawler/src/extract/normalize.ts';
import type { NewsItem } from '../apps/crawler/src/extract/normalize.ts';
import { GAMES } from '../apps/crawler/config/games.ts';
import {
  isOpusOnlyItem,
  readDynamicText,
  readDynamicImages,
  readDynamicTitle,
  toHttpsUrl,
} from '../apps/crawler/src/extract/opus.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (key: string): { captured_at: string; mid: string; items: any[] } =>
  JSON.parse(readFileSync(resolve(ROOT, 'data/fixtures', key + '.json'), 'utf8'));

const genshin = GAMES.find((g) => g.key === 'genshin')!;
const gItems = fixture('genshin').items;
const opusOnly = gItems.filter(isOpusOnlyItem);

test('原神 fixture 加载正常且包含预期 opus-only 条目', () => {
  assert.ok(gItems.length > 0, 'fixture items 不能为空');
  assert.ok(opusOnly.length > 0, '应至少有一条 opus-only 动态');
  assert.ok(
    opusOnly.some((it) => it.id_str === '1273842634488545282'),
    '应包含卡池公告 1273842634488545282（opus-only）',
  );
});

test('所有 opus-only 条目 normalize 后非空，且文本与图片均不为空', () => {
  for (const raw of opusOnly) {
    const item: NewsItem | null = normalizeDynamic(raw, genshin);
    assert.ok(item, it => 'opus-only 条目 ' + raw.id_str + ' 不应返回 null：' + it);
    assert.equal(item!.type, 'dynamic');
    assert.equal(item!.id, String(raw.id_str));
    assert.ok(item!.summary.trim().length > 0, raw.id_str + ' 的 summary 不应为空');
    assert.ok(item!.images.length > 0, raw.id_str + ' 的 images 不应为空');
    assert.ok(item!.title.trim().length > 0, raw.id_str + ' 的 title 不应为空');
    assert.ok(item!.images.every((u) => u.startsWith('https://')), raw.id_str + ' 图片应为 https');
    assert.ok(item!.published_at.includes('T'), raw.id_str + ' 应有 ISO 发布时间');
  }
});

test('opus 读取函数：文本、图片、标题、协议升级与去重', () => {
  const announcement = gItems.find((it) => it.id_str === '1273842634488545282')!;
  const text = readDynamicText(announcement);
  assert.ok(text.includes('本期活动祈愿时间为2026/11/24 18:00'), '公告应含开池时间');
  assert.ok(text.includes('兹白') && text.includes('莉奈娅'));

  const images = readDynamicImages(announcement);
  assert.ok(images.length > 0);
  assert.ok(images.every((u) => u.startsWith('https://')), 'http: 图片应升级为 https:');

  assert.ok(readDynamicTitle(announcement).length > 0, '公告标题不应为空');
  assert.equal(toHttpsUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(toHttpsUrl('http://x.cn/a.jpg'), 'https://x.cn/a.jpg');
  assert.equal(toHttpsUrl(''), '');
});

test('视频条目不被破坏：normalize 后仍是 video 且保留 bvid/cover', () => {
  const raw = gItems.find((it) => it.id_str === '1270410171844132901')!;
  assert.equal(raw.type, 'DYNAMIC_TYPE_AV');
  const item = normalizeDynamic(raw, genshin);
  assert.ok(item, '视频条目不应返回 null');
  assert.equal(item!.type, 'video');
  assert.equal(item!.id, '1270410171844132901');
  assert.equal(item!.bvid, 'BV1jiWi6dEQg');
  assert.match(item!.url, /bilibili\.com\/video\/BV1jiWi6dEQg/);
  assert.ok(item!.cover?.startsWith('https://'), 'cover 应升级为 https');
  assert.ok(item!.title.length > 0);
  assert.ok(item!.summary.length > 0);
  assert.ok(item!.published_at.includes('T'));
});

test('转发条目不被破坏：从 orig 读取 Opus 文本与图片', () => {
  const endfield = GAMES.find((g) => g.key === 'endfield')!;
  const raw = fixture('endfield').items.find((it) => it.type === 'DYNAMIC_TYPE_FORWARD');
  assert.ok(raw, 'endfield fixture 应包含转发动态');
  const item = normalizeDynamic(raw, endfield);
  assert.ok(item, '转发条目不应返回 null');
  assert.equal(item!.type, 'forward');
  assert.equal(item!.id, String(raw!.id_str));
  assert.ok(readDynamicText(raw!).length > 0 || (raw!.orig && readDynamicText(raw!.orig).length > 0),
    '转发的 orig 正文应可读');
  assert.ok(item!.summary.length > 0, '转发 summary 不应为空');
  assert.ok(item!.images.length > 0, '转发图片不应为空');
  assert.ok(item!.images.every((u) => u.startsWith('https://')));
});

test('全部 5 个游戏 fixture 均能完整 normalize，不丢条、不抛错', () => {
  for (const game of GAMES) {
    const items = fixture(game.key).items;
    let parsed = 0;
    for (const raw of items) {
      const item = normalizeDynamic(raw, game);
      assert.ok(item, game.key + ' / ' + raw.id_str + ' 不应解析失败');
      assert.equal(item!.game_key, game.key);
      parsed++;
    }
    assert.equal(parsed, items.length, game.key + ' 的条目数应全部解析成功');
  }
});
