// 离线单测：卡池合并 / 守卫 / 置信度 / status 计算 / feed 写入。
// 全纯函数，不联网；角色字典用仓库里的 data/char-names.json（只读）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PoolCandidate, ResolvedPool } from '../apps/crawler/src/pools/types.ts';
import {
  loadCharBook,
  buildRosterIndex,
  flattenCharBook,
  normalizeCharacterName,
  validateCharacters,
  sanitizeCharacterNames,
  mergeCharBook,
} from '../apps/crawler/src/pools/roster.ts';
import { resolvePools, applyPoolsToFeed, stablePoolId, visiblePools } from '../apps/crawler/src/pools/resolver.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK = loadCharBook(resolve(ROOT, 'data'));
const INDEX = buildRosterIndex(flattenCharBook(BOOK));

/** 统一「当前时间」：2026-11-26 14:05（东八区），所有 status 断言都以它为基准 */
const NOW = Date.parse('2026-11-26T14:05:00+08:00');

function candidate(over: Partial<PoolCandidate> & Pick<PoolCandidate, 'game_key' | 'characters' | 'source'>): PoolCandidate {
  return {
    game_key: over.game_key,
    pool_name: over.pool_name ?? '限定寻访',
    pool_type: over.pool_type ?? 'limited_character',
    characters: over.characters,
    start_at: over.start_at ?? null,
    end_at: over.end_at ?? null,
    version: over.version ?? null,
    period: over.period ?? null,
    evidence: over.evidence ?? null,
    note: over.note ?? null,
    source: over.source,
  };
}

// ————————————————————————— roaster：归一化与字典 —————————————————————————

test('roster：loadCharBook 读得到全部 10 款游戏的字典', () => {
  const games = Object.keys(BOOK.games);
  assert.ok(games.length >= 10, '字典游戏数应 >= 10，实际 ' + games.length);
  const endfield = BOOK.games.endfield ?? [];
  assert.ok(endfield.some((e) => e.cn === '小刻'), '终末地字典应含小刻');
  const index = buildRosterIndex(flattenCharBook(BOOK));
  assert.equal(index.byGame.get('endfield')?.get('xiaoke'), '小刻', '英文名应映射回中文');
  assert.ok(index.names.get('genshin')?.has('芙宁娜'));
});

test('roster：normalizeCharacterName 去引号 / ·前缀 / 属性括号 / 尾部标注', () => {
  assert.equal(normalizeCharacterName('驹隙隐泉·兹白(岩)'), '兹白');
  assert.equal(normalizeCharacterName('「小刻」'), '小刻');
  assert.equal(normalizeCharacterName('【小刻】'), '小刻');
  assert.equal(normalizeCharacterName('博闻异旅·莉奈娅(岩) UP'), '莉奈娅');
  assert.equal(normalizeCharacterName('   '), '');
  // 形态名（泳装）不是属性，必须保留，否则 BA 的「纱织（泳装）」会被映射丢
  assert.equal(normalizeCharacterName('纱织（泳装）'), '纱织(泳装)');
});

test('roster：validateCharacters 映射中文名，映射不到但在 roster 里也算 valid', () => {
  const roster = INDEX.names.get('genshin');
  const result = validateCharacters(['兹白', 'Furina', '不存在的角色'], INDEX, roster, 'genshin');
  assert.deepEqual(result.valid, ['兹白', '芙宁娜']);
  assert.deepEqual(result.invalid, ['不存在的角色']);
  // roster 里手写、字典没有的写法：仍算 valid（保留原名）
  const manual = new Set(['神秘角色']);
  const loose = validateCharacters(['神秘角色'], INDEX, manual, 'genshin');
  assert.deepEqual(loose.valid, ['神秘角色']);
});

test('roster：sanitizeCharacterNames 从公告整句里回收角色名，纯噪声串丢弃', () => {
  const roster = INDEX.names.get('endfield');
  const result = sanitizeCharacterNames(
    ['概率提升的6星干员为【小刻】', '全部可能出现', '★★★★', '明河'],
    INDEX,
    roster,
    'endfield',
  );
  assert.deepEqual(result.valid, ['小刻', '明河']);
  assert.deepEqual(result.invalid, ['全部可能出现', '★★★★']);
});

// ————————————————————————— resolver：合并 / 置信度 —————————————————————————

test('resolvePools：同键多源合并，角色取交集，≥2 源一致 → high', () => {
  const start = '2026-11-24T18:00:00+08:00';
  const end = '2026-12-15T14:59:00+08:00';
  const { pools, warnings } = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '众水的颂诗', characters: ['芙宁娜', '兹白'], start_at: start, end_at: end, source: { id: 'akasha', tier: 'L2' } }),
    candidate({ game_key: 'genshin', pool_name: '众水的颂诗', characters: ['兹白', '芙宁娜'], start_at: start, end_at: end, source: { id: 'bili-dynamics', tier: 'L3' } }),
  ], { now: NOW, roster: BOOK });

  assert.equal(pools.length, 1);
  const pool = pools[0];
  assert.deepEqual([...pool.characters].sort(), ['兹白', '芙宁娜'].sort());
  assert.equal(pool.confidence, 'high');
  assert.equal(pool.sources.length, 2);
  assert.deepEqual(pool.sources.map((s) => s.id), ['akasha', 'bili-dynamics']);
  assert.equal(pool.source, 'akasha', '旧字段 source 取最高 tier 源 id');
  assert.equal(pool.status, '进行中');
  assert.equal(pool.days_remaining, 19);
  assert.deepEqual(warnings, []);
});

test('resolvePools：单源 L2 → low；单源 L0 → high', () => {
  const solo = resolvePools([
    candidate({ game_key: 'zzz', pool_name: '限定寻访', characters: ['菲欧妮'], start_at: '2026-11-25T12:00:00+08:00', end_at: '2026-12-09T11:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(solo.pools[0].confidence, 'low');

  const official = resolvePools([
    candidate({ game_key: 'zzz', pool_name: '限定寻访', characters: ['菲欧妮'], start_at: '2026-11-25T12:00:00+08:00', end_at: '2026-12-09T11:59:00+08:00', source: { id: 'kuro-site', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(official.pools[0].confidence, 'high');
});

test('resolvePools：多源角色矛盾 → 取最高 tier 源并降为 low', () => {
  const start = '2026-11-24T18:00:00+08:00';
  const end = '2026-12-15T14:59:00+08:00';
  const { pools, warnings } = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '众水的颂诗', characters: ['芙宁娜'], start_at: start, end_at: end, source: { id: 'akasha', tier: 'L2' } }),
    candidate({ game_key: 'genshin', pool_name: '众水的颂诗', characters: ['兹白'], start_at: start, end_at: end, source: { id: 'bili-dynamics', tier: 'L3' } }),
  ], { now: NOW, roster: BOOK });

  assert.equal(pools.length, 1);
  assert.deepEqual(pools[0].characters, ['芙宁娜'], '交集为空时取最高 tier 源');
  assert.equal(pools[0].confidence, 'low');
  assert.ok(warnings.some((w) => w.includes('多源角色不一致')));
});

test('resolvePools：池名漂移（一方包含另一方）+ 同起止 → 合并成一个池', () => {
  const start = '2026-11-05T12:00:00+08:00';
  const end = '2026-11-26T11:59:00+08:00';
  const { pools } = resolvePools([
    candidate({ game_key: 'endfield', pool_name: '限定寻访', characters: ['小刻'], start_at: start, end_at: end, source: { id: 'hypergryph-cms', tier: 'L0' } }),
    candidate({ game_key: 'endfield', pool_name: '限定寻访·锻砧', characters: ['小刻'], start_at: start, end_at: end, source: { id: 'prts-smw', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].sources.length, 2);
  assert.deepEqual(pools[0].characters, ['小刻']);
});

test('resolvePools：id 稳定（同输入同 id，起止不同则变）', () => {
  assert.equal(stablePoolId('genshin', '众水的颂诗', '2026-11-24T18:00:00+08:00'), stablePoolId('genshin', '众水的颂诗', '2026-11-24T18:00:00+08:00'));
  assert.notEqual(stablePoolId('genshin', '众水的颂诗', '2026-11-24T18:00:00+08:00'), stablePoolId('genshin', '众水的颂诗', '2026-12-24T18:00:00+08:00'));
  const key = stablePoolId('genshin', '众水的颂诗', '2026-11-24T18:00:00+08:00');
  assert.ok(key.startsWith('genshin:'));
  assert.ok(key.length <= 'genshin:'.length + 8, 'id 要短，实际 ' + key);
});

// ————————————————————————— resolver：守卫 —————————————————————————

test('守卫：UP 人数超过上限（hsr 上限 3 人 → 4 人丢弃）→ 整条丢弃并告警', () => {
  // 4.7 池 1 实测有 3 名 UP（银狼LV.999/火花/爻光），所以 hsr 上限放宽到 3；超 3 人才算解析异常
  const { pools, warnings } = resolvePools([
    candidate({
      game_key: 'hsr',
      pool_name: '限定跃迁',
      characters: ['银狼LV.999', '火花', '爻光', '星神★阿哈'],
      start_at: '2026-11-25T12:00:00+08:00',
      end_at: '2026-12-09T11:59:00+08:00',
      source: { id: 'akasha', tier: 'L2' },
    }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 0);
  assert.ok(warnings.some((w) => w.includes('超过上限')), JSON.stringify(warnings));
});

test('守卫：BA 上限只有 1 人，2 人即丢弃', () => {
  const { pools, warnings } = resolvePools([
    candidate({ game_key: 'bluearchive', pool_name: '限定招募', characters: ['时雨', '美游'], start_at: '2026-11-25T12:00:00+08:00', end_at: '2026-12-02T11:59:00+08:00', source: { id: 'bluearchive-cargo', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 0);
  assert.ok(warnings.some((w) => w.includes('上限 1')));
});

test('守卫：时长必须 1 小时 – 90 天（起止都有时校验）', () => {
  const short = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '短池', characters: ['兹白'], start_at: '2026-11-26T12:00:00+08:00', end_at: '2026-11-26T12:30:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(short.pools.length, 0);
  assert.ok(short.warnings.some((w) => w.includes('不在 1 小时–90 天范围内')));

  const long = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '超长池', characters: ['兹白'], start_at: '2026-01-01T00:00:00+08:00', end_at: '2026-04-10T00:00:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(long.pools.length, 0);

  // 只有单边时间时无法判断时长，不拦
  const partial = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '待定结束', characters: ['兹白'], start_at: '2026-11-25T12:00:00+08:00', end_at: null, source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(partial.pools.length, 1);
  assert.equal(partial.pools[0].status, '进行中');
  assert.equal(partial.pools[0].days_remaining, null);
});

test('守卫：角色名噪声（全部可能出现 / ★★★★）不入池', () => {
  const { pools, warnings } = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '噪声池', characters: ['全部可能出现', '★★★★', '芙宁娜'], start_at: '2026-11-25T12:00:00+08:00', end_at: '2026-12-09T11:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 1);
  assert.deepEqual(pools[0].characters, ['芙宁娜']);
  assert.ok(warnings.some((w) => w.includes('角色名未通过校验')));
});

test('守卫：武器池角色清空，且不进 current_up_characters', () => {
  const { pools } = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '神铸定轨', pool_type: 'weapon', characters: ['兹白'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 1);
  assert.deepEqual(pools[0].characters, []);
  assert.equal(pools[0].pool_type, 'weapon');
  assert.equal(pools[0].pool_type_label, '武器');

  const feed = { data: { games: [{ key: 'genshin', stage: 'live', up_banners: [], current_up_characters: [] }] } };
  const applied = applyPoolsToFeed(feed, pools);
  const game = (applied.feed.data!.games as any[])[0];
  // 2026-11-26 决策：武器池不再输出半成品（无武器名）→ up_banners 里直接不出现
  assert.equal(game.up_banners.length, 0);
  assert.deepEqual(game.current_up_characters, []);
});

// ————————————————————————— resolver：status / days_remaining —————————————————————————

test('status：进行中按东八区日历日给 days_remaining', () => {
  const { pools } = resolvePools([
    candidate({ game_key: 'wutheringwaves', pool_name: '唤取', characters: ['椿'], start_at: '2026-11-25T12:00:00+08:00', end_at: '2026-11-29T11:59:00+08:00', source: { id: 'kuro-site', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools[0].status, '进行中');
  assert.equal(pools[0].days_remaining, 3);
  assert.equal(pools[0].start_at, '2026-11-25T12:00:00+08:00', '输出统一到 +08:00');
});

test('status：未开始 / 已结束 / 时间待定', () => {
  const upcoming = resolvePools([
    candidate({ game_key: 'wutheringwaves', pool_name: '下期唤取', characters: ['莉莉'], start_at: '2026-11-28T12:00:00+08:00', end_at: '2026-12-12T11:59:00+08:00', source: { id: 'kuro-site', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(upcoming.pools[0].status, '未开始');
  assert.equal(upcoming.pools[0].days_remaining, null);

  const ended = resolvePools([
    candidate({ game_key: 'azurlane', pool_name: '期間限定建造', characters: ['莫洛托夫'], start_at: '2026-11-01T12:00:00+08:00', end_at: '2026-11-20T11:59:00+08:00', source: { id: 'azurlane-jp', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(ended.pools[0].status, '已结束');

  const unknown = resolvePools([
    candidate({ game_key: 'azurpromilia', pool_name: '弦定观测', characters: ['枫糖'], start_at: null, end_at: null, source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(unknown.pools[0].status, '时间待定');
  assert.equal(unknown.pools[0].start_at, null);
});

// ————————————————————————— 终末地：config 明河 vs L0 小刻 —————————————————————————

test('终末地：config 给明河、L0 给「概率提升的6星干员为【小刻】」→ 最终是小刻不是明河', () => {
  const start = '2026-11-05T12:00:00+08:00';
  const { pools, warnings } = resolvePools([
    // 人工配置（L4）只留时段骨架；历史遗留的明河必须被官方一手覆盖
    candidate({
      game_key: 'endfield',
      pool_name: '第 2 期',
      characters: ['明河'],
      start_at: start,
      end_at: '2026-12-15T11:59:00+08:00',
      period: '第 2 期',
      source: { id: 'config', tier: 'L4' },
    }),
    // 鹰角 CMS（L0）：公告正文是整句，角色名藏在【】里
    candidate({
      game_key: 'endfield',
      pool_name: '限定寻访',
      characters: ['概率提升的6星干员为【小刻】'],
      start_at: start,
      end_at: null,
      source: { id: 'hypergryph-cms', tier: 'L0' },
    }),
    // PRTS（L2）只作校验/来源，不能把官方角色裁掉
    candidate({
      game_key: 'endfield',
      pool_name: '限定寻访',
      characters: ['小刻'],
      start_at: start,
      end_at: null,
      source: { id: 'prts-smw', tier: 'L2' },
    }),
  ], { now: NOW, roster: BOOK });

  assert.equal(pools.length, 1, '三条候选应合并成一个池: ' + JSON.stringify(warnings));
  const pool = pools[0];
  assert.ok(pool.characters.includes('小刻'), '应含小刻，实际 ' + JSON.stringify(pool.characters));
  assert.ok(!pool.characters.includes('明河'), '不应含明河，实际 ' + JSON.stringify(pool.characters));
  assert.equal(pool.confidence, 'high');
  assert.deepEqual(pool.sources.map((s) => s.id), ['hypergryph-cms', 'prts-smw', 'config']);
  assert.equal(pool.status, '进行中');
  assert.equal(pool.days_remaining, 19, '结束时间由 config 骨架补齐');
  assert.equal(pool.label, '第 2 期');

  // 写进 feed 后 current_up_characters 也必须是官方口径
  const applied = applyPoolsToFeed({ data: { games: [{ key: 'endfield', stage: 'live', up_banners: [], current_up_characters: [] }] } }, pools);
  const game = (applied.feed.data!.games as any[])[0];
  assert.deepEqual(game.current_up_characters, ['小刻']);
});

// ————————————————————————— applyPoolsToFeed —————————————————————————

test('applyPoolsToFeed：旧字段保留 + 新字段齐全，不改入参', () => {
  const resolved: ResolvedPool[] = resolvePools([
    candidate({
      game_key: 'genshin',
      pool_name: '众水的颂诗',
      characters: ['芙宁娜', '兹白'],
      start_at: '2026-11-24T18:00:00+08:00',
      end_at: '2026-12-15T14:59:00+08:00',
      version: '7.2',
      note: null,
      source: { id: 'akasha', tier: 'L2' },
    }),
  ], { now: NOW, roster: BOOK }).pools;

  const oldBanner = { label: '旧期次', characters: ['米提亚'], start_at: null, end_at: null, status: '已结束', days_remaining: null, source: 'config' };
  const feed: any = {
    schema_version: 4,   // schema v4：新增 generated_at_utc / 卡池 confidence 等字段
    data: {
      games: [
        { key: 'genshin', game_name: '原神', stage: 'live', up_banners: [oldBanner], current_up_characters: ['米提亚'] },
        { key: 'zzz', game_name: '绝区零', stage: 'live', up_banners: [], current_up_characters: [] },
        { key: 'wutheringwaves', game_name: '鸣潮', stage: 'prelaunch', up_banners: [], current_up_characters: [] },
      ],
    },
  };

  const { feed: next, warnings } = applyPoolsToFeed(feed, resolved);
  assert.notEqual(next, feed, '应返回新对象');
  assert.notEqual(next.data, feed.data);

  const genshin = (next.data!.games as any[])[0];
  assert.equal(genshin.up_banners.length, 1);
  const banner = genshin.up_banners[0];
  for (const field of ['label', 'characters', 'start_at', 'end_at', 'status', 'days_remaining', 'source']) {
    assert.ok(field in banner, '缺旧字段 ' + field);
  }
  for (const field of ['pool_name', 'pool_type', 'pool_type_label', 'confidence', 'sources']) {
    assert.ok(field in banner, '缺新字段 ' + field);
  }
  assert.equal(banner.pool_name, '众水的颂诗');
  assert.equal(banner.pool_type, 'limited_character');
  assert.equal(banner.pool_type_label, '限定角色');
  assert.equal(banner.confidence, 'low');
  assert.equal(banner.status, '进行中');
  assert.equal(banner.days_remaining, 19);
  assert.equal(banner.source, 'akasha');
  assert.equal(banner.sources.length, 1);
  assert.equal(banner.sources[0].tier, 'L2');
  assert.deepEqual(genshin.current_up_characters, ['芙宁娜', '兹白']);

  // 没有解析结果的游戏 → up_banners 置空 + 告警
  const zzz = (next.data!.games as any[])[1];
  assert.deepEqual(zzz.up_banners, []);
  assert.ok(warnings.some((w) => w.includes('[zzz]')));

  // 预约游戏不告警（本来就没有卡池）
  assert.ok(!warnings.some((w) => w.includes('[wutheringwaves]')));

  // 入参未被修改
  assert.equal(feed.data.games[0].up_banners[0].label, '旧期次');
  assert.deepEqual(feed.data.games[0].current_up_characters, ['米提亚']);
});

test('applyPoolsToFeed：current_up_characters 只保留「进行中」的当前批次（已结束/未开始都不进）', () => {
  const resolved: ResolvedPool[] = resolvePools([
    // 进行中：当期常驻轮换
    candidate({ game_key: 'arknights', pool_name: '标准寻访', pool_type: 'standard_character', characters: ['薇薇安娜'], start_at: '2026-11-20T04:00:00+08:00', end_at: '2026-12-04T03:59:00+08:00', source: { id: 'prts-smw', tier: 'L2' } }),
    // 已结束：不进 current
    candidate({ game_key: 'arknights', pool_name: '限定寻访', characters: ['霍尔海雅'], start_at: '2026-11-10T12:00:00+08:00', end_at: '2026-11-18T11:59:00+08:00', source: { id: 'prts-smw', tier: 'L2' } }),
    // 未开始（11-28 才开）：按「当前卡池」语义不进 current
    candidate({ game_key: 'arknights', pool_name: '复刻寻访', pool_type: 'rerun_character', characters: ['隐德来希'], start_at: '2026-11-28T12:00:00+08:00', end_at: '2026-12-08T11:59:00+08:00', source: { id: 'prts-smw', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK }).pools;

  const feed = { data: { games: [{ key: 'arknights', stage: 'live', up_banners: [], current_up_characters: [] }] } };
  const game = (applyPoolsToFeed(feed, resolved).feed.data!.games as any[])[0];
  assert.deepEqual(game.current_up_characters, ['薇薇安娜']);
  assert.equal(game.up_banners.length, 3, 'banner 列表仍保留其它期次，便于回溯');
});

test('current_up_characters：并行双池都算当前，旧版本池（开始更早）不进', () => {
  const resolved: ResolvedPool[] = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '活动祈愿', characters: ['兹白', '莉奈娅'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
    candidate({ game_key: 'genshin', pool_name: '呀吼吼博物志', characters: ['莉奈娅'], start_at: '2026-11-24T18:00:00+08:00', end_at: null, source: { id: 'bili-dynamics', tier: 'L0' } }),
    // 旧池：缺结束时间仍被判进行中，但开始时间是 10-13，属于上一版
    candidate({ game_key: 'genshin', pool_name: '莓色香颂', characters: ['爱可菲'], start_at: '2026-10-13T18:00:00+08:00', end_at: null, source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK }).pools;
  const feed = { data: { games: [{ key: 'genshin', stage: 'live', up_banners: [], current_up_characters: [] }] } };
  const game = (applyPoolsToFeed(feed, resolved).feed.data!.games as any[])[0];
  assert.deepEqual([...game.current_up_characters].sort(), ['兹白', '莉奈娅'].sort());
  assert.ok(!game.current_up_characters.includes('爱可菲'), '上一版本的池子不应混入当前 UP');
});

test('up_banners 不再输出武器池；协定池单独进 pact_banners', () => {
  const resolved: ResolvedPool[] = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '活动祈愿', characters: ['兹白'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
    candidate({ game_key: 'genshin', pool_name: '神铸赋形', pool_type: 'weapon', characters: [], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
    candidate({ game_key: 'yh', pool_name: '协定·示例', pool_type: 'pact', characters: ['曳尔沐'], start_at: '2026-11-20T12:00:00+08:00', end_at: '2026-12-04T11:59:00+08:00', source: { id: 'nte-guide', tier: 'L3' } }),
  ], { now: NOW, roster: BOOK }).pools;
  const feed = { data: { games: [
    { key: 'genshin', stage: 'live', up_banners: [], current_up_characters: [] },
    { key: 'yh', stage: 'live', up_banners: [], current_up_characters: [] },
  ] } };
  const games = applyPoolsToFeed(feed, resolved).feed.data!.games as any[];
  const genshin = games[0];
  assert.ok(genshin.up_banners.every((b: any) => b.pool_type !== 'weapon'), '武器池不应出现在 up_banners');
  assert.equal(genshin.up_banners.length, 1);
  const yh = games[1];
  assert.equal(yh.pact_banners.length, 1, '协定池进 pact_banners');
  assert.equal(yh.pact_banners[0].pool_type, 'pact');
  assert.equal(yh.up_banners.length, 0, '协定池不重复出现在 up_banners');
  assert.deepEqual(yh.current_up_characters, ['曳尔沐']);
});

// ——————————————————————— 展示过滤（2026-11-26 反馈固化） ———————————————————————

test('visiblePools：丢弃无 UP 角色的卡池、无起止时间的卡池，已结束最多留 2 条', () => {
  const mk = (over: Partial<ResolvedPool>): ResolvedPool => ({
    id: over.id ?? 'x', game_key: 'genshin', label: over.label ?? '池', pool_name: over.pool_name ?? '池',
    pool_type: over.pool_type ?? 'limited_character', pool_type_label: '限定角色',
    characters: over.characters ?? [], start_at: over.start_at ?? null, end_at: over.end_at ?? null,
    version: null, status: over.status ?? '已结束', days_remaining: null,
    confidence: 'high', sources: [], note: null, source: 'test',
  });
  const pools: ResolvedPool[] = [
    mk({ id: 'a', label: '空角色池', characters: [] }),
    mk({ id: 'b', label: '无时间池', characters: ['兹白'] }),
    mk({ id: 'c', label: '已结束1', characters: ['甲'], start_at: '2026-11-01T00:00:00+08:00', end_at: '2026-11-10T00:00:00+08:00' }),
    mk({ id: 'd', label: '已结束2', characters: ['乙'], start_at: '2026-11-11T00:00:00+08:00', end_at: '2026-11-20T00:00:00+08:00' }),
    mk({ id: 'e', label: '已结束3', characters: ['丙'], start_at: '2026-11-21T00:00:00+08:00', end_at: '2026-11-24T00:00:00+08:00' }),
    mk({ id: 'f', label: '进行中', characters: ['兹白'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', status: '进行中' }),
    mk({ id: 'g', label: '武器', pool_type: 'weapon', start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', status: '进行中' }),
  ];
  const warnings: string[] = [];
  const kept = visiblePools(pools, warnings, 'genshin');
  assert.deepEqual(kept.map((p) => p.id).sort(), ['d', 'e', 'f'].sort(), '只留最近的 2 条已结束 + 进行中');
  assert.ok(warnings.some((w) => w.includes('无 UP 角色')));
  assert.ok(warnings.some((w) => w.includes('无起止时间')));
});

test('refinePools（经由 resolvePools）：缺结束时间用下一期开池近似；起点缺但未结束算进行中', () => {
  const { pools } = resolvePools([
    // 缺结束时间：下一期 11-24 开池 → 结束时间补成 11-24
    candidate({ game_key: 'genshin', pool_name: '旧池', characters: ['爱可菲'], start_at: '2026-10-13T18:00:00+08:00', end_at: null, source: { id: 'bili-dynamics', tier: 'L0' } }),
    candidate({ game_key: 'genshin', pool_name: '新池', characters: ['兹白'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  const old = pools.find((p) => p.pool_name === '旧池')!;
  assert.equal(old.end_at, '2026-11-24T18:00:00+08:00', '结束时间按下一期开池近似');
  assert.equal(old.status, '已结束', '补齐后应判定为已结束');
  assert.match(String(old.note), /下一期开池时间近似/);

  const noStart = resolvePools([
    candidate({ game_key: 'wutheringwaves', pool_name: '唤取池', characters: ['莉莉'], start_at: null, end_at: '2026-12-03T09:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK }).pools[0];
  assert.equal(noStart.status, '进行中', '缺起点但结束时间在未来 → 进行中');
});

test('同名跨源合并：一方缺时间、一方缺角色 → 合成一个池（鸣潮官网 + B 站）', () => {
  const { pools } = resolvePools([
    candidate({ game_key: 'wutheringwaves', pool_name: '盛放于昨日梦土的花朵', characters: ['莉莉'], start_at: null, end_at: null, source: { id: 'kuro-site', tier: 'L0' } }),
    candidate({ game_key: 'wutheringwaves', pool_name: '盛放于昨日梦土的花朵', characters: [], start_at: null, end_at: '2026-12-03T09:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 1, '同名候选应合并成一个池');
  assert.deepEqual(pools[0].characters, ['莉莉']);
  assert.equal(pools[0].end_at, '2026-12-03T09:59:00+08:00');
});

test('合并规则④：无时间的角色候选（绝区零 B 站）并入同时段的日历池，置信度升为 high', () => {
  const { pools } = resolvePools([
    // Akasha 日历：有池名 + 时段 + 角色（L2 社区源）
    candidate({ game_key: 'zzz', pool_name: '代理人调频', characters: ['赛维里安', '诺姆'], start_at: '2026-11-11T12:00:00+08:00', end_at: '2026-12-01T14:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
    // B 站版本动态：只有角色、没有时间（L0 官方）
    candidate({ game_key: 'zzz', pool_name: '代理人调频', characters: ['赛维里安', '诺姆'], start_at: null, end_at: null, source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK });
  assert.equal(pools.length, 1, '无时间候选应并入时段池，而不是独立成空卡');
  const pool = pools[0];
  assert.deepEqual(pool.characters, ['赛维里安', '诺姆']);
  assert.equal(pool.start_at, '2026-11-11T12:00:00+08:00');
  assert.equal(pool.confidence, 'high', '有 L0 参与即 high');
  assert.deepEqual(pool.sources.map((s) => s.id).sort(), ['akasha', 'bili-dynamics']);
});

test('mergeCharBook：自动扩写只补空字段，不覆盖人工维护的 cn', () => {
  const base = { games: { yh: [{ cn: '真红', en: null, jp: null }] } };
  const { book, added, updated } = mergeCharBook(base, [
    { game_key: 'yh', cn: '真红', en: 'Zhenhong' } as any,
    { game_key: 'yh', cn: '卡厄斯', en: 'Chaos' } as any,
  ]);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(book.games.yh.length, 2);
  assert.equal(book.games.yh.find((e) => e.cn === '真红')!.en, 'Zhenhong');
  assert.equal(book.games.yh.find((e) => e.cn === '卡厄斯')!.en, 'Chaos');
});

test('applyPoolsToFeed：版本日期缺失时用卡池排期补「下个节点」', () => {
  const resolved = resolvePools([
    candidate({ game_key: 'genshin', pool_name: '活动祈愿', characters: ['兹白'], start_at: '2026-11-24T18:00:00+08:00', end_at: '2026-12-15T14:59:00+08:00', source: { id: 'bili-dynamics', tier: 'L0' } }),
  ], { now: NOW, roster: BOOK }).pools;
  const feed = { data: { games: [{ key: 'genshin', stage: 'live', next_version: '暂未公布', days_to_next_version: null, up_banners: [], current_up_characters: [] }] } };
  const game = (applyPoolsToFeed(feed, resolved, { now: NOW }).feed.data!.games as any[])[0];
  assert.equal(game.next_node_at, '2026-12-15T14:59:00+08:00');
  assert.match(game.next_node_label, /本期卡池结束/);
  assert.equal(game.next_node_kind, 'pool_end');
  assert.equal(game.days_to_next_version, 19, '应补充距离下个节点的天数');
});

test('applyPoolsToFeed：已有版本日期时不覆盖 days_to_next_version', () => {
  const resolved = resolvePools([
    candidate({ game_key: 'zzz', pool_name: '代理人调频', characters: ['赛维里安'], start_at: '2026-11-11T12:00:00+08:00', end_at: '2026-12-01T14:59:00+08:00', source: { id: 'akasha', tier: 'L2' } }),
  ], { now: NOW, roster: BOOK }).pools;
  const feed = { data: { games: [{ key: 'zzz', stage: 'live', next_version: '3.4版本', days_to_next_version: 6, up_banners: [], current_up_characters: [] }] } };
  const game = (applyPoolsToFeed(feed, resolved, { now: NOW }).feed.data!.games as any[])[0];
  assert.equal(game.days_to_next_version, 6, '版本日期优先，不被卡池日期覆盖');
  assert.equal(game.next_node_at, '2026-12-01T14:59:00+08:00', '仍记录卡池排期节点，供前端 tooltip 使用');
});
