// 离线测试：鸣潮官网 / 蔚蓝档案 Cargo / 碧蓝航线（日服+国际服）/ 异环角色库 / B 站动态正文卡池解析。
// 全部 fixture 都在 data/source-cache 下（真实响应裁剪快照），测试用 offline ctx，绝不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { PoolCandidate, SourceContext } from '../apps/crawler/src/pools/types.ts';
import { kuroSiteAdapter } from '../apps/crawler/src/sources/kuro/site.ts';
import { bluearchiveCargoAdapter } from '../apps/crawler/src/sources/bluearchive/cargo.ts';
import { azurlaneJpAdapter, azurlaneEnAdapter, parseJpMaintenanceRow } from '../apps/crawler/src/sources/azurlane/news.ts';
import { nteGuideAdapter } from '../apps/crawler/src/sources/nte/guide.ts';
import {
  biliDynamicsAdapter,
  dynamicTextFromRaw,
  parseAzurpromiliaText,
  parseBlueArchiveText,
  parseHsrText,
  parseKuroDynamicText,
  parseGenshinText,
} from '../apps/crawler/src/sources/bili/pools.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = resolve(ROOT, 'data/source-cache');

/** 固定的「当前时间」：2026-11-26T14:00:00+08:00 */
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

function find(pools: PoolCandidate[], name: string): PoolCandidate {
  const hit = pools.find((p) => p.pool_name === name);
  assert.ok(hit, '未找到池 ' + name + '，实际有: ' + pools.map((p) => p.pool_type + '/' + p.pool_name).join(', '));
  return hit!;
}

function assertCst(value: string | null, label: string): void {
  assert.equal(value, null, label + ' 期望为 null');
}

// ————————————————— 鸣潮官网（kuro-site，L0） —————————————————

test('kuro-site：离线读取缓存，解析版本说明与单池公告', async () => {
  const pools = await kuroSiteAdapter.collect(offlineCtx());
  assert.ok(pools.length >= 4, '至少 4 个池，实际: ' + pools.length);
  assert.equal(kuroSiteAdapter.id, 'kuro-site');
  assert.equal(kuroSiteAdapter.tier, 'L0');
  assert.deepEqual(kuroSiteAdapter.games, ['wutheringwaves']);

  // 3.8 版本说明：角色池带 5星共鸣者「莉莉」，武器池不带角色
  const characterPool = find(pools, '盛放于昨日梦土的花朵');
  assert.equal(characterPool.pool_type, 'limited_character');
  assert.deepEqual(characterPool.characters, ['莉莉']);
  assert.equal(characterPool.version, '3.8');
  // 版本说明只写「3.8版本更新后」：起点用同篇维护窗口结束时刻锚定（2026-11-12 11:00 +08:00）
  assert.equal(characterPool.start_at, '2026-11-12T11:00:00+08:00', '起点应由维护窗口锚定');
  assertCst(characterPool.end_at, '版本说明未给该池时间 end_at');
  assert.match(String(characterPool.note), /维护窗口/);

  const weaponPool = find(pools, '安魂');
  assert.equal(weaponPool.pool_type, 'weapon');
  assert.deepEqual(weaponPool.characters, [], '武器池不允许带角色');

  // 2024 单池公告：相对起点无锚点 → null；终点绝对时间 → 东八区 ISO
  const oldCharacter = find(pools, '徘徊迷宫尽处');
  assert.equal(oldCharacter.pool_type, 'limited_character');
  assert.deepEqual(oldCharacter.characters, ['椿']);
  assert.equal(oldCharacter.version, '1.4');
  assertCst(oldCharacter.start_at, '「1.4版本更新后」没有锚点');
  assert.equal(oldCharacter.end_at, '2024-12-12T09:59:00+08:00');
  assert.match(String(oldCharacter.note), /start_at=null/);

  const oldWeapon = find(pools, '浮声沉兵');
  assert.equal(oldWeapon.pool_type, 'weapon');
  assert.deepEqual(oldWeapon.characters, []);
  assert.equal(oldWeapon.end_at, '2024-12-12T09:59:00+08:00');

  for (const p of pools) {
    for (const t of [p.start_at, p.end_at]) {
      if (t) assert.match(t, /\+08:00$/, '时间必须带东八区偏移: ' + t);
    }
  }
});

test('kuro-site：离线且缓存缺失时返回 []（不编造、有日志）', async () => {
  const logs: string[] = [];
  const ctx = offlineCtx({ cacheDir: resolve(ROOT, 'data/__no-such-cache__'), log: (...a: unknown[]) => logs.push(a.join(' ')) });
  const pools = await kuroSiteAdapter.collect(ctx);
  assert.deepEqual(pools, []);
  assert.ok(logs.some((l) => l.indexOf('kuro-site') >= 0), '应打出失败日志: ' + logs.join(' | '));
});

// ————————————————— 蔚蓝档案（bluearchive-cargo，L2） —————————————————

test('bluearchive-cargo：只保留 GL/JP，UTC → 东八区，复刻/FES 映射', async () => {
  const pools = await bluearchiveCargoAdapter.collect(offlineCtx());
  assert.equal(bluearchiveCargoAdapter.tier, 'L2');
  assert.deepEqual(bluearchiveCargoAdapter.games, ['bluearchive']);
  assert.ok(pools.length > 0);

  for (const p of pools) {
    assert.match(String(p.note), /server=(GL|JP)/, 'note 必须标注 server=' + p.pool_name);
    // CN 行必须被过滤
    assert.ok(String(p.note).indexOf('server=CN') < 0, '不得出现 CN 记录');
    if (p.start_at) assert.match(p.start_at, /\+08:00$/);
    if (p.end_at) assert.match(p.end_at, /\+08:00$/);
    assert.equal(p.game_key, 'bluearchive');
  }

  const jp = pools.find((p) => String(p.note).indexOf('server=JP') >= 0)!;
  assert.ok(jp, '应保留 JP 记录');
  assert.equal(jp.characters.length, 1);
  // Cargo 存 UTC：02:00Z = 10:00 +08:00
  assert.equal(jp.start_at, '2026-11-25T10:00:00+08:00');
  assert.equal(jp.end_at, '2026-12-09T09:59:00+08:00');

  const gl = pools.find((p) => String(p.note).indexOf('server=GL') >= 0)!;
  assert.ok(gl, '应保留 GL 记录');
  assert.equal(gl.start_at, '2026-11-24T10:00:00+08:00');

  // Rerun=1 → rerun_character；FesGacha → fes
  assert.ok(pools.some((p) => p.pool_type === 'rerun_character'), '应有复刻池');
  assert.ok(pools.some((p) => p.pool_type === 'fes'), '应有 FES 池');
});

// ————————————————— 碧蓝航线（azurlane-jp / azurlane-en，L0） —————————————————

test('azurlane-jp：維護時間 + 開催期間 → 绝对时间与舰名', async () => {
  assert.equal(azurlaneJpAdapter.tier, 'L0');
  assert.deepEqual(azurlaneJpAdapter.games, ['azurlane']);
  const pools = await azurlaneJpAdapter.collect(offlineCtx());
  assert.equal(pools.length, 1, '最新一版维护公告应解析出 1 个期间限定建造');
  const p = pools[0];
  assert.equal(p.pool_name, '期間限定建造');
  assert.equal(p.pool_type, 'limited_character');
  assert.deepEqual(p.characters, ['モロトフ', 'シノープ']);
  // JST 20:00 维护结束 → 19:00 +08:00；12月10日 维护开始 14:00 JST → 13:00 +08:00
  assert.equal(p.start_at, '2026-11-24T19:00:00+08:00');
  assert.equal(p.end_at, '2026-12-10T13:00:00+08:00');
  assert.match(String(p.note), /server=JP/);
});

test('azurlane-jp：公告缺少維護時間时 start_at=null', () => {
  const cand = parseJpMaintenanceRow({
    id: 766,
    type: 3,
    publishTime: Date.parse('2026-09-22T10:30:00Z'),
    content: '<p>【機能更新】</p><p>・「期間限定建造」を追加</p><p>下記の艦が期間限定建造で出現します。</p><p>開催期間：9月22日(火)メンテナンス後～10月6日(火)メンテナンスまで</p><p>SSR</p><p>「サン・マルタン」2% (pickup)</p><p>※その他、期間限定建造で出現する艦は将来通常建造などに常設実装されます。</p>',
  });
  assert.ok(cand);
  assert.equal(cand!.start_at, null);
  assert.deepEqual(cand!.characters, ['サン・マルタン']);
  assert.match(String(cand!.note), /start_at 无法定位/);
});

test('azurlane-en：Rate up 与 between 区间 → 东八区时间', async () => {
  assert.equal(azurlaneEnAdapter.tier, 'L0');
  const pools = await azurlaneEnAdapter.collect(offlineCtx());
  assert.equal(pools.length, 1);
  const p = pools[0];
  assert.equal(p.pool_name, 'Event Construction Pool');
  assert.deepEqual(p.characters, ['Molotov', 'Sinop']);
  // 11/24 00:00 UTC-7 维护开始 + 约 8 小时 = 08:00 UTC-7 = 23:00 +08:00
  assert.equal(p.start_at, '2026-11-24T23:00:00+08:00');
  // 12/9 23:59 UTC-7 = 12/10 14:59 +08:00
  assert.equal(p.end_at, '2026-12-10T14:59:00+08:00');
  assert.match(String(p.note), /server=EN/);
});

// ————————————————— 异环（nte-guide，L2） —————————————————

test('nte-guide：只提供 roster，collect 返回 []', async () => {
  assert.equal(nteGuideAdapter.tier, 'L2');
  assert.deepEqual(nteGuideAdapter.games, ['yh']);
  const pools = await nteGuideAdapter.collect(offlineCtx());
  assert.deepEqual(pools, []);
  assert.ok(typeof nteGuideAdapter.roster === 'function');
  const roster = await nteGuideAdapter.roster!(offlineCtx());
  assert.ok(roster.length >= 3, '应解析出角色名单');
  const nanally = roster.find((e) => e.cn === '娜娜莉');
  assert.ok(nanally, '应有「娜娜莉」，实际: ' + roster.map((r) => r.cn).join(','));
  assert.equal(nanally!.game_key, 'yh');
  assert.equal(nanally!.en, 'Nanally');
  assert.ok((nanally!.aliases ?? []).indexOf('nanally') >= 0, 'aliases 应含 slug');
  for (const e of roster) {
    assert.equal(e.game_key, 'yh');
    assert.ok(e.cn.length > 0);
  }
});

// ————————————————— B 站动态正文（bili-dynamics，L0） —————————————————

interface BiliFixture {
  dynamics: Array<{ id: string; game_key: string; published_at: string; url?: string | null; raw: string }>;
}
const fixtures: BiliFixture = JSON.parse(fs.readFileSync(resolve(CACHE_DIR, 'fixtures-bili-pools.json'), 'utf8')).data;
const fixture = (id: string) => fixtures.dynamics.find((d) => d.id === id)!;

test('bili/pools：适配器元信息与 store.json 采集', async () => {
  assert.equal(biliDynamicsAdapter.id, 'bili-dynamics');
  assert.equal(biliDynamicsAdapter.tier, 'L0');
  // yh 加入：异环「限定棋盘」也走 B 站正文解析（归到 pact 协定卡池）
  assert.deepEqual(biliDynamicsAdapter.games, ['azurpromilia', 'genshin', 'wutheringwaves', 'bluearchive', 'hsr', 'yh']);
  const pools = await biliDynamicsAdapter.collect(offlineCtx());
  assert.ok(pools.length > 0, '应从 data/store.json 解析出卡池');
  assert.ok(pools.every((p) => p.source.id === 'bili-dynamics'));
  assert.ok(pools.some((p) => p.game_key === 'azurpromilia'));
  assert.ok(pools.some((p) => p.game_key === 'genshin'), '原神应有候选（页面 UP 角色依赖它）');
  assert.ok(pools.some((p) => p.game_key === 'wutheringwaves'));
  assert.ok(pools.some((p) => p.game_key === 'bluearchive'));
  assert.ok(pools.some((p) => p.game_key === 'hsr'));
});

test('bili/pools：蓝色星原「弦定观测」', () => {
  const text = dynamicTextFromRaw(fixture('1274151900107767840').raw);
  assert.match(text, /弦定观测/);
  const pools = parseAzurpromiliaText(text, {
    id: '1274151900107767840', gameKey: 'azurpromilia', publishedAt: '2026-11-24T06:00:07.000Z',
  });
  assert.equal(pools.length, 1);
  const p = pools[0];
  assert.equal(p.pool_name, '桃笺为契');
  assert.equal(p.pool_type, 'limited_character');
  assert.deepEqual(p.characters, ['涂山小玉'], '角色名应去掉括号属性');
  assert.equal(p.start_at, null, '「开服后」起点为 null');
  assert.match(String(p.note), /开服后/);
  assert.equal(p.end_at, '2026-12-17T03:59:00+08:00');
});


test('bili/pools：原神活动祈愿（区间版 + 「将于…开启」版 + 武器池）', () => {
  const textA = dynamicTextFromRaw(fixture('genshin-range-variant').raw);
  const poolsA = parseGenshinText(textA, { id: 'genshin-range-variant', gameKey: 'genshin', publishedAt: '2026-11-21T10:00:00.000Z' });
  const charA = find(poolsA, '活动祈愿');
  assert.equal(charA.pool_type, 'limited_character');
  assert.deepEqual(charA.characters, ['兹白', '莉奈娅'], '应去掉 ·前缀 与 (岩) 属性');
  assert.equal(charA.start_at, '2026-11-24T18:00:00+08:00');
  assert.equal(charA.end_at, '2026-12-15T14:59:00+08:00');
  assert.equal(charA.version, '7.2');
  const weaponA = find(poolsA, '武器祈愿');
  assert.equal(weaponA.pool_type, 'weapon');
  assert.deepEqual(weaponA.characters, [], '武器池不允许带角色');

  const textB = dynamicTextFromRaw(fixture('genshin-open-variant').raw);
  const poolsB = parseGenshinText(textB, { id: 'genshin-open-variant', gameKey: 'genshin', publishedAt: '2026-11-22T10:00:00.000Z' });
  assert.equal(poolsB.length, 1);
  const charB = poolsB[0];
  assert.equal(charB.pool_name, '呀吼吼博物志', '池名取紧邻的「…」活动祈愿');
  assert.equal(charB.pool_type, 'limited_character');
  assert.deepEqual(charB.characters, ['莉奈娅']);
  assert.equal(charB.start_at, '2026-11-24T18:00:00+08:00');
  assert.equal(charB.end_at, null, '「将于…开启」只给起点');
});

test('bili/pools：鸣潮「[角色/武器活动唤取・第一期]」分组公告', () => {
  const text = dynamicTextFromRaw(fixture('1269283956235173890').raw);
  const pools = parseKuroDynamicText(text, {
    id: '1269283956235173890', gameKey: 'wutheringwaves', publishedAt: '2026-11-11T03:10:00.000Z',
  });
  const names = pools.map((p) => p.pool_type + '/' + p.pool_name);
  for (const expected of ['limited_character/盛放于昨日梦土的花朵', 'limited_character/符文烁醒之刻', 'limited_character/倦客不知身近远']) {
    assert.ok(names.indexOf(expected) >= 0, '缺少 ' + expected + '，实际: ' + names.join(','));
  }
  for (const expected of ['weapon/安魂', 'weapon/昭日译注', 'weapon/裁竹']) {
    assert.ok(names.indexOf(expected) >= 0, '缺少 ' + expected + '，实际: ' + names.join(','));
  }
  for (const p of pools) {
    assert.equal(p.period, '第一期');
    assert.equal(p.version, '3.8');
    assert.equal(p.end_at, '2026-12-03T09:59:00+08:00');
    assert.equal(p.start_at, null, '「3.8版本更新后」起点为 null');
    if (p.pool_type === 'weapon') assert.deepEqual(p.characters, [], '武器池角色必须为空');
  }
});

test('bili/pools：鸣潮单池公告（5星角色「莉莉」）与噪声串', () => {
  const text = dynamicTextFromRaw(fixture('kuro-single-variant').raw);
  const pools = parseKuroDynamicText(text, {
    id: 'kuro-single-variant', gameKey: 'wutheringwaves', publishedAt: '2026-11-11T03:00:00.000Z',
  });
  assert.equal(pools.length, 1);
  const p = pools[0];
  assert.equal(p.pool_name, '盛放于昨日梦土的花朵');
  assert.equal(p.pool_type, 'limited_character');
  assert.deepEqual(p.characters, ['莉莉']);
  assert.equal(p.end_at, '2026-12-03T09:59:00+08:00');
  assert.equal(p.start_at, null);
  // 噪声串不得被当角色
  for (const bad of ['全部可能出现', '秧秧', '白芷', '散华']) {
    assert.ok(p.characters.indexOf(bad) < 0, '噪声串被当角色: ' + bad);
  }
});

test('bili/pools：鸣潮武器池单池公告不带角色', () => {
  const text = dynamicTextFromRaw(fixture('1269282667717722137').raw);
  const pools = parseKuroDynamicText(text, {
    id: '1269282667717722137', gameKey: 'wutheringwaves', publishedAt: '2026-11-11T03:05:00.000Z',
  });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].pool_name, '安魂');
  assert.equal(pools[0].pool_type, 'weapon');
  assert.deepEqual(pools[0].characters, []);
  assert.equal(pools[0].end_at, '2026-12-03T09:59:00+08:00');
});

test('bili/pools：蔚蓝档案「限时复刻招募」与「限时招募」', () => {
  const rerunText = dynamicTextFromRaw(fixture('1274105486497546261').raw);
  const rerun = parseBlueArchiveText(rerunText, {
    id: '1274105486497546261', gameKey: 'bluearchive', publishedAt: '2026-11-24T03:00:00.000Z',
  });
  assert.equal(rerun.length, 2);
  const silver = find(rerun, '银装素裹，一樽星月');
  assert.equal(silver.pool_type, 'rerun_character');
  assert.deepEqual(silver.characters, ['时雨']);
  // 「11月26日 维护结束后」：按当日 14:00 近似（否则状态永远是「时间待公布」）
  assert.equal(silver.start_at, '2026-11-26T14:00:00+08:00', '「维护结束后」→ 当日 14:00 近似');
  assert.equal(silver.end_at, '2026-12-10T13:59:00+08:00');
  assert.match(String(silver.note), /维护结束后/);
  assert.deepEqual(find(rerun, '这里是RABBIT 4，凭指尖完成证明').characters, ['美游']);

  const limitedText = dynamicTextFromRaw(fixture('ba-limited-variant').raw);
  const limited = parseBlueArchiveText(limitedText, {
    id: 'ba-limited-variant', gameKey: 'bluearchive', publishedAt: '2026-11-24T03:00:00.000Z',
  });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].pool_type, 'limited_character');
  assert.deepEqual(limited[0].characters, ['时雨']);
  assert.equal(limited[0].end_at, '2026-12-10T13:59:00+08:00');
});

test('bili/pools：星穹铁道活动跃迁（分窗口版 + 「活动跃迁：A、B」版）', () => {
  const text = dynamicTextFromRaw(fixture('1268910294088810533').raw);
  const pools = parseHsrText(text, { id: '1268910294088810533', gameKey: 'hsr', publishedAt: '2026-11-10T03:00:00.000Z' });
  assert.equal(pools.length, 2);
  const first = pools[0];
  assert.equal(first.pool_type, 'limited_character');
  assert.deepEqual(first.characters, ['星神★阿哈']);
  assert.equal(first.version, '4.7');
  assert.equal(first.start_at, null, '「版本更新后」→ null');
  assert.equal(first.end_at, '2026-12-22T15:00:00+08:00');
  const second = pools[1];
  assert.deepEqual(second.characters, ['银狼LV.999']);
  assert.equal(second.end_at, '2026-12-02T11:59:00+08:00');

  const listText = dynamicTextFromRaw(fixture('hsr-list-variant').raw);
  const listPools = parseHsrText(listText, { id: 'hsr-list-variant', gameKey: 'hsr', publishedAt: '2026-11-10T03:00:00.000Z' });
  assert.equal(listPools.length, 1);
  assert.equal(listPools[0].pool_name, '星神★阿哈、银狼LV.999');
  assert.deepEqual(listPools[0].characters, ['星神★阿哈', '银狼LV.999']);
  assert.equal(listPools[0].start_at, null);
  assert.equal(listPools[0].end_at, '2026-12-02T03:59:00+08:00');
});

test('bili/pools：store.json 缺失时返回 [] 并打日志', async () => {
  const logs: string[] = [];
  const ctx = offlineCtx({ dataDir: resolve(ROOT, 'data/__no-store__'), log: (...a: unknown[]) => logs.push(a.join(' ')) });
  const pools = await biliDynamicsAdapter.collect(ctx);
  assert.deepEqual(pools, []);
  assert.ok(logs.some((l) => l.indexOf('bili-dynamics') >= 0));
});
