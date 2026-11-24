// 离线回归测试：活动日历 / 生日学习 / 预约卡语义。
// 固定时钟（NOW），不依赖真实时间与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventStatus,
  daysRemaining,
  parseDateRange,
  buildEvents,
  learnBirthdays,
  mergeBirthdayBook,
  nextBirthday,
  birthdayItems,
  cleanCharacterTag,
} from '../apps/crawler/src/extract/calendar.ts';
import type { BirthdayBook, BirthdayRecord } from '../apps/crawler/src/extract/calendar.ts';
import { buildFeed } from '../apps/crawler/src/extract/feed.ts';
import { GAMES } from '../apps/crawler/config/games.ts';
import { PUBLISHERS } from '../apps/crawler/config/publishers.ts';
import type { NewsItem } from '../apps/crawler/src/extract/normalize.ts';

const NOW = Date.parse('2026-11-24T12:00:00+08:00');
const gameOf = (key: string) => GAMES.find((g) => g.key === key)!;

function news(gameKey: string, id: string, text: string, publishedAt: string): NewsItem {
  const game = gameOf(gameKey);
  return {
    id,
    game_key: gameKey,
    game_name: game?.name ?? gameKey,
    type: 'dynamic',
    title: text.split('\n')[0],
    summary: text,
    published_at: publishedAt,
    url: 'https://www.bilibili.com/opus/' + id,
    images: [],
    source_mid: game?.mid ?? '',
    source_name: game?.name ?? gameKey,
  };
}

// ——————————————————————— 活动状态 / 剩余天数 ———————————————————————

test('eventStatus 覆盖进行中 / 即将开始 / 已结束 / 时间待定', () => {
  assert.equal(eventStatus(null, null, NOW), '时间待定');
  assert.equal(eventStatus('2026-11-26T00:00:00+08:00', null, NOW), '即将开始');
  assert.equal(eventStatus('2026-11-01T00:00:00+08:00', null, NOW), '进行中');
  assert.equal(eventStatus('2026-11-01T00:00:00+08:00', '2026-11-20T00:00:00+08:00', NOW), '已结束');
  assert.equal(eventStatus('2026-11-20T00:00:00+08:00', '2026-11-30T00:00:00+08:00', NOW), '进行中');
});

test('daysRemaining 向上取整，无结束时间返回 null', () => {
  assert.equal(daysRemaining(null, NOW), null);
  assert.equal(daysRemaining('2026-11-20T00:00:00+08:00', NOW), 0);
  assert.equal(daysRemaining('2026-11-27T12:00:00+08:00', NOW), 3);
  assert.equal(daysRemaining('2026-11-27T13:00:00+08:00', NOW), 4);
});

test('parseDateRange 解析官方公告里的起止时间（含跨年）', () => {
  const range = parseDateRange('活动时间2026/11/20 12:00 ~ 2026/12/05 03:59', NOW);
  assert.deepEqual(range, {
    start_at: '2026-11-20T12:00:00+08:00',
    end_at: '2026-12-05T03:59:00+08:00',
  });
  const crossYear = parseDateRange('活动时间：12月20日-1月5日', NOW);
  assert.equal(crossYear?.start_at, '2026-12-20T00:00:00+08:00');
  assert.equal(crossYear?.end_at, '2027-01-05T23:59:00+08:00');
  assert.equal(parseDateRange('活动将于11月25日开启', NOW), null, '单个日期不构成区间');
});

// ——————————————————————— 活动排序 / 去重 / 上限 ———————————————————————

test('buildEvents 输出人工种子（进行中优先）且最多 3 条', () => {
  const events = buildEvents('genshin', [], NOW);
  assert.equal(events.length, 3);
  for (const ev of events) {
    assert.equal(ev.status, '进行中');
    assert.equal(ev.source, 'curated');
    assert.ok(ev.title.length > 4, '标题应可读');
    assert.match(ev.url ?? '', /^https:\/\/www\.bilibili\.com\//, 'url 应指向官方动态');
  }
  assert.ok(events.every((ev) => ev.category === 'event'));
});

test('buildEvents 排序：进行中 → 即将开始 → 时间待定 → 最近结束', () => {
  const events = buildEvents('azurpromilia', [], NOW);
  assert.equal(events[0].status, '即将开始', '公测（11-26）应排在最前');
  assert.equal(events[events.length - 1].status, '已结束', '已结束活动排最后');
  assert.ok(events.every((ev) => ev.category === 'prelaunch'));
  const statuses = events.map((ev) => ev.status);
  const rank: Record<string, number> = { 进行中: 0, 即将开始: 1, 时间待定: 2, 已结束: 3 };
  for (let i = 1; i < statuses.length; i++) {
    assert.ok(rank[statuses[i - 1]] <= rank[statuses[i]], '状态顺序应递增: ' + statuses.join(','));
  }
});

test('buildEvents 人工声明「已结束」的一次性直播不显示为进行中', () => {
  const zzz = buildEvents('zzz', [], NOW);
  const preview = zzz.find((ev) => ev.title.includes('前瞻特别节目'));
  // zzz 的 3 条人工种子已占满，前瞻节目被挤掉时也允许（不做硬断言），但若出现必须已结束
  if (preview) assert.equal(preview.status, '已结束');
  const endfield = buildEvents('endfield', [], NOW);
  assert.ok(endfield.every((ev) => ev.status === '进行中'));
});

test('buildEvents 未知游戏返回空数组', () => {
  assert.deepEqual(buildEvents('not-a-game', [], NOW), []);
});

// ——————————————————————— 生日学习 ———————————————————————

test('learnBirthdays 从 #角色# #生日快乐# 学习原神生日（发布日即可信）', () => {
  const items = [
    news('genshin', 'g1', '#原神# #芙宁娜# #生日快乐#\n祝芙宁娜生日快乐！', '2026-10-13T04:00:00Z'),
    news('genshin', 'g2', '#原神# #早柚# #生日快乐#\n忍法·生日之术！', '2026-10-19T04:00:00Z'),
  ];
  const learned = learnBirthdays('genshin', items, NOW);
  const map = new Map(learned.map((r) => [r.character, r.month_day]));
  assert.equal(map.get('芙宁娜'), '10-13');
  assert.equal(map.get('早柚'), '10-19');
  assert.ok(!map.has('原神'), '游戏名不应被当成角色');
  assert.ok(learned.every((r) => r.source === 'official'));
});

test('绝区零抽奖类「生日快乐」动态不产生生日（无明确日期不猜）', () => {
  const items = [
    news('zzz', 'z1', '互动抽奖 #绝区零妮可# #生日快乐#\n关注并转发，抽 10 位绳匠送周边！', '2026-10-31T04:00:00Z'),
    news('zzz', 'z2', '互动抽奖 #绝区零妮可# #生日快乐#\n关注并转发，抽 10 位绳匠送周边！', '2026-11-07T04:00:00Z'),
    news('zzz', 'z3', '互动抽奖 #绝区零派派# #生日快乐#\n关注并转发抽奖！', '2026-10-21T04:00:00Z'),
    news('zzz', 'z4', '互动抽奖 #绝区零派派# #生日快乐#\n关注并转发抽奖！', '2026-10-28T04:00:00Z'),
  ];
  assert.deepEqual(learnBirthdays('zzz', items, NOW), []);
});

test('明确写了「X月X日」时才采纳，且同一角色多个日期视为不可靠', () => {
  const explicitOnce = learnBirthdays('zzz', [
    news('zzz', 'z5', '#绝区零妮可# #生日快乐#\n今天是妮可的生日，11月11日，一起庆祝吧！', '2026-11-11T04:00:00Z'),
  ], NOW);
  assert.equal(explicitOnce.length, 1);
  assert.equal(explicitOnce[0].character, '妮可');
  assert.equal(explicitOnce[0].month_day, '11-11');

  const conflicting = learnBirthdays('zzz', [
    news('zzz', 'z6', '#绝区零妮可# #生日快乐#\n妮可的生日是11月11日', '2026-11-11T04:00:00Z'),
    news('zzz', 'z7', '#绝区零妮可# #生日快乐#\n妮可的生日是11月12日', '2026-11-12T04:00:00Z'),
  ], NOW);
  assert.deepEqual(conflicting, [], '同一角色多个不同日期应整条丢弃');
});

test('角色话题标签清洗：#绝区零妮可# / #生日快乐妮可# → 妮可', () => {
  assert.equal(cleanCharacterTag('#绝区零妮可#'.replace(/#/g, ''), 'zzz'), '妮可');
  assert.equal(cleanCharacterTag('生日快乐妮可', 'zzz'), '妮可');
  assert.equal(cleanCharacterTag('明日方舟终末地小刻', 'endfield'), '小刻');
  assert.equal(cleanCharacterTag('原神', 'genshin'), '原神');
});

test('mergeBirthdayBook 跨运行累积并去重，无数据游戏不产生空键', () => {
  const prev: BirthdayBook = {
    genshin: [{ character: '芙宁娜', month_day: '10-13', url: 'old', source: 'official' }],
    zzz: [{ character: '妮可', month_day: '11-11', url: null, source: 'official' }],
  };
  const learned: BirthdayBook = {
    genshin: [{ character: '芙宁娜', month_day: '10-13', url: 'new', source: 'official' }],
    hsr: [],
  };
  const merged = mergeBirthdayBook(prev, learned);
  assert.equal(merged.genshin.length, 1);
  assert.equal(merged.genshin[0].url, 'new', '新链接应覆盖旧值');
  assert.equal(merged.zzz.length, 1, '未重新学到的历史记录应保留');
  assert.equal(merged.hsr, undefined, '空数组不应产生键');
});

// ——————————————————————— 下一次生日 ———————————————————————

test('nextBirthday 跨年取明年，生日当天 days_until=0', () => {
  const endOfYear = Date.parse('2026-12-31T20:00:00+08:00');
  const next = nextBirthday('01-05', endOfYear);
  assert.equal(next?.next_at, '2027-01-05T00:00:00+08:00');
  assert.equal(next?.days_until, 5);

  const today = nextBirthday('12-31', endOfYear);
  assert.equal(today?.days_until, 0);
  assert.equal(today?.next_at, '2026-12-31T00:00:00+08:00');
});

test('birthdayItems 没有数据返回 []，有数据按天数排序且最多 4 条', () => {
  assert.deepEqual(birthdayItems([]), []);
  assert.deepEqual(birthdayItems({}, NOW), []);

  const records: BirthdayRecord[] = [
    { character: 'A', month_day: '12-01', url: null, source: 'official' },
    { character: 'B', month_day: '11-25', url: null, source: 'official' },
    { character: 'C', month_day: '11-24', url: null, source: 'official' },
    { character: 'D', month_day: '12-10', url: null, source: 'official' },
    { character: 'E', month_day: '11-30', url: null, source: 'official' },
  ];
  const items = birthdayItems(records, NOW);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.character), ['C', 'B', 'E', 'A']);
  assert.equal(items[0].days_until, 0);
  assert.match(items[0].next_at, /\+08:00$/);
});

test('生日状态：今天 / 30 天内 / 过去 30 天内 / 其余，并给出 days_since', () => {
  const at = (md: string) => birthdayItems([{ character: 'X', month_day: md, url: null, source: 'official' }], NOW)[0];

  const today = at('11-24');
  assert.equal(today.state, 'today');
  assert.equal(today.days_until, 0);
  assert.equal(today.days_since, 0);

  const upcoming = at('11-30');
  assert.equal(upcoming.state, 'upcoming');
  assert.equal(upcoming.days_since, null, '未来生日 days_since 为 null');

  // 莱欧斯利 11-23：在 11-24 应为「刚刚过生日」
  const recent = at('11-23');
  assert.equal(recent.state, 'recent');
  assert.equal(recent.days_since, 1);
  assert.equal(recent.days_until, 364);

  // 10-13：距离下一次还有 323 天、上次已过 42 天 → far
  const far = at('10-13');
  assert.equal(far.state, 'far');
  assert.equal(far.days_since, null);
  assert.equal(far.days_until, 323);
});

test('生日排序：今天 / 30 天内优先，其次过去 30 天内，最后其余', () => {
  const records: BirthdayRecord[] = [
    { character: '远日', month_day: '10-13', url: null, source: 'official' },
    { character: '刚过', month_day: '11-23', url: null, source: 'official' },
    { character: '今天', month_day: '11-24', url: null, source: 'official' },
    { character: '近期', month_day: '12-01', url: null, source: 'official' },
  ];
  const items = birthdayItems(records, NOW);
  assert.deepEqual(items.map((i) => i.character), ['今天', '近期', '刚过', '远日']);
  assert.deepEqual(items.map((i) => i.state), ['today', 'upcoming', 'recent', 'far']);
});

test('没有生日数据的游戏 birthdayItems 返回空（明日方舟 / 终末地 / 预约游戏）', () => {
  for (const key of ['arknights', 'endfield', 'nexusanima', 'azurpromilia', 'silverpalace']) {
    assert.deepEqual(birthdayItems(mergeBirthdayBook({}, {})[key] ?? [], NOW), []);
  }
});

// ——————————————————————— 预约卡 / feed v3 ———————————————————————

test('buildFeed：预约游戏没有正式卡池与版本号，release 用官方档期', () => {
  const feed = buildFeed([], [gameOf('azurpromilia')], {}, { now: NOW });
  const game = feed.data.games[0];
  assert.equal(game.stage, 'prelaunch');
  assert.deepEqual(game.up_banners, []);
  assert.deepEqual(game.current_up_characters, []);
  assert.equal(game.current_version, '尚未上线');
  assert.equal(game.next_version, '待定档');
  assert.equal(game.next_version_kind, null);
  assert.equal(game.days_to_next_version, null);
  assert.equal(game.download.available, false);
  assert.equal(game.release.date, '2026-11-26T00:00:00+08:00');
  assert.deepEqual(game.birthdays, []);
  assert.ok(game.events.length >= 2, '预约游戏应有预热里程碑');
  assert.ok(game.events.every((ev) => ev.category === 'prelaunch'));
});

test('buildFeed：live 游戏保留卡池与版本字段，未知游戏不抛错', () => {
  const feed = buildFeed([], GAMES, {}, { now: NOW });
  assert.equal(feed.schema_version, 3);
  assert.equal(feed.data.games.length, 11);
  const genshin = feed.data.games.find((g) => g.key === 'genshin')!;
  assert.equal(genshin.stage, 'live');
  assert.ok(genshin.up_banners.length >= 2);
  assert.equal(genshin.release.days_until, null);
  assert.ok(Array.isArray(genshin.events) && Array.isArray(genshin.birthdays));
  assert.equal(genshin.current_version === '暂未获取', false, '不应出现「暂未获取」');
});

test('buildFeed 顶层 publishers 按契约顺序输出 7 个厂商', () => {
  const feed = buildFeed([], GAMES, {}, { now: NOW });
  assert.equal(feed.publishers.length, 7);
  assert.deepEqual(feed.publishers.map((p) => p.key), [
    'mihoyo', 'hypergryph', 'kuro', 'yostar', 'manjuu', 'happyelements', 'perfectworld',
  ]);
  assert.deepEqual(feed.publishers.map((p) => p.name), [
    '米哈游', '鹰角网络', '库洛游戏', '悠星网络', '蛮啾网络', '乐元素', '完美世界',
  ]);
  assert.equal(PUBLISHERS.length, 7);
  const counts = feed.data.games.reduce<Record<string, number>>((acc, g) => {
    acc[g.publisher_key] = (acc[g.publisher_key] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { mihoyo: 4, hypergryph: 2, kuro: 1, yostar: 1, manjuu: 1, happyelements: 1, perfectworld: 1 });
});
