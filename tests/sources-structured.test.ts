// 结构化 JSON 类信源的离线回归测试：鹰角 CMS（终末地 / 明日方舟）、PRTS SMW、Akasha 日历。
// 断言口径：池名 / 类型 / 角色 / 东八区时间；数据全部来自 data/source-cache/*.json 的真实响应裁剪快照。
// 不联网、不读进程时区（TZ=UTC / TZ=America/New_York 结果必须一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hypergryphCmsAdapter, endfieldPoolSpecs, parseNoticeRange } from '../apps/crawler/src/sources/hypergryph/cms.ts';
import { prtsSmwAdapter, parsePrtsAsk, parsePrtsWikitext } from '../apps/crawler/src/sources/prts/smw.ts';
import { akashaAdapter, classifyAkashaPool, utcToCstIso } from '../apps/crawler/src/sources/akasha/calendar.ts';
import type { PoolCandidate, SourceContext } from '../apps/crawler/src/pools/types.ts';
import { withSourceCache } from '../apps/crawler/src/sources/http.ts';

const CACHE_DIR = fileURLToPath(new URL('../data/source-cache', import.meta.url));
const NOW = Date.parse('2026-11-26T14:00:00+08:00');

function makeCtx(cacheDir = CACHE_DIR): { ctx: SourceContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: SourceContext = {
    now: NOW,
    nowCst: '2026-11-26T14:00:00+08:00',
    cacheDir,
    offline: true,
    dataDir: path.dirname(cacheDir),
    log: (...args: any[]) => logs.push(args.map(String).join(' ')),
  };
  return { ctx, logs };
}

const byKey = (list: PoolCandidate[], gameKey: string) => list.filter((c) => c.game_key === gameKey);
const findByPool = (list: PoolCandidate[], gameKey: string, name: string) => {
  const hit = byKey(list, gameKey).filter((c) => c.pool_name.includes(name));
  return hit;
};
const cstOk = (iso: string | null) => iso === null || /\+08:00$/.test(iso);

// —————————————————— 鹰角 CMS ——————————————————

test('hypergryph-cms：8535 特许寻访解析出池名/类型/UP/时间，且「明河」不进 UP 名单', async () => {
  const { ctx } = makeCtx();
  const all = await hypergryphCmsAdapter.collect(ctx);
  const hit = byKey(all, 'endfield').filter((c) => c.pool_name === '锻砧、行囊与蜜糖');
  assert.equal(hit.length, 1, '8535 应产出唯一的「锻砧、行囊与蜜糖」候选');
  const pool = hit[0];
  assert.equal(pool.pool_type, 'limited_character', '特许寻访 = 限定角色池');
  assert.deepEqual(pool.characters, ['小刻']);
  // 正文「全部可能出现的6星干员包括：小刻/明河/…」是常驻名单，绝不能当 UP
  assert.ok(!pool.characters.includes('明河'), '明河只出现在「全部可能出现」名单里，不得进 UP');
  assert.equal(pool.start_at, '2026-11-25T06:00:00+08:00', '起点由同版本「更新维护时间」锚定');
  assert.equal(pool.end_at, '2026-12-23T11:59:00+08:00', '终点是公告写死的 2026/12/23 11:59（服务器时间）');
  assert.equal(pool.source.id, 'hypergryph-cms');
  assert.equal(pool.source.tier, 'L0');
  assert.match(String(pool.source.url), /^https:\/\/endfield\.hypergryph\.com\/news\/8535$/);
  assert.ok(pool.evidence && pool.evidence.includes('锻砧'), 'evidence 应保留正文片段');
});

test('hypergryph-cms：7201 一个公告里的重构寻访 + 重构申领拆成两个候选（角色池 / 武器池）', async () => {
  const { ctx } = makeCtx();
  const all = await hypergryphCmsAdapter.collect(ctx);
  const rerun = byKey(all, 'endfield').filter((c) => c.pool_name === '致每一个飘游之愿');
  const weapon = byKey(all, 'endfield').filter((c) => c.pool_name === '飘行申领');
  assert.equal(rerun.length, 1);
  assert.equal(weapon.length, 1);
  assert.equal(rerun[0].pool_type, 'rerun_character', '「重构寻访N」= 复刻角色池');
  assert.equal(rerun[0].period, '重构寻访1');
  assert.deepEqual(rerun[0].characters, ['洁尔佩塔']);
  assert.equal(rerun[0].start_at, '2026-11-25T06:00:00+08:00');
  assert.equal(rerun[0].end_at, '2026-12-16T11:59:00+08:00');
  assert.equal(weapon[0].pool_type, 'weapon', '「申领」= 武器池');
  assert.deepEqual(weapon[0].characters, [], '武器池不列角色（契约 §3）');
  assert.match(String(weapon[0].note), /使命必达/, '武器名只能进 note');
  assert.equal(weapon[0].start_at, rerun[0].start_at, '两池共用公告里的开放时间');
});

test('hypergryph-cms：7204 绝对起点 + 「版本更新维护前」终点用锚点补全', async () => {
  const { ctx } = makeCtx();
  const all = await hypergryphCmsAdapter.collect(ctx);
  const pool = byKey(all, 'endfield').filter((c) => c.pool_name === '烟火邀星河')[0];
  assert.ok(pool, '应解析出「烟火邀星河」');
  assert.deepEqual(pool.characters, ['明河'], '这一期 UP 才是明河');
  assert.equal(pool.start_at, '2026-11-05T12:00:00+08:00');
  assert.equal(pool.end_at, '2026-11-25T06:00:00+08:00', '「版本更新维护前」按下一次维护开始锚定');
});

test('hypergryph-cms：明日方舟限定寻访（将雪投火）类型与 UP 行解析', async () => {
  const { ctx } = makeCtx();
  const all = await hypergryphCmsAdapter.collect(ctx);
  const hits = findByPool(all, 'arknights', '将雪投火');
  assert.equal(hits.length, 1);
  const pool = hits[0];
  assert.equal(pool.pool_type, 'fes', '[限定寻访·庆典] = 庆典');
  assert.equal(pool.period, '限定寻访·庆典');
  assert.deepEqual(pool.characters, ['塔露拉', '冻河'], '只取「占6★出率」那行，5 倍权值行进 note');
  assert.match(String(pool.note), /凛御银灰/);
  assert.ok(!pool.characters.includes('奥尔佳'), '5★ 行不是 6★ UP');
  assert.ok(!pool.characters.includes('维什戴尔'), '「寻访数据契约交换所」清单不是 UP');
  assert.equal(pool.start_at, '2026-11-01T12:00:00+08:00', '无年份用公告发布时间补年份');
  assert.equal(pool.end_at, '2026-11-15T03:59:00+08:00');
  assert.match(String(pool.source.url), /^https:\/\/ak\.hypergryph\.com\/news\/4916$/);
});

test('hypergryph-cms：标题句式（特许寻访 / 重构寻访 / 申领）分类正确', () => {
  assert.deepEqual(
    endfieldPoolSpecs('「锻砧、行囊与蜜糖」特许寻访说明').map((s) => [s.name, s.type]),
    [['锻砧、行囊与蜜糖', 'limited_character']],
  );
  assert.deepEqual(
    endfieldPoolSpecs('「致每一个飘游之愿」重构寻访1与「飘行申领」重构申领1开放').map((s) => [s.name, s.type, s.period]),
    [
      ['致每一个飘游之愿', 'rerun_character', '重构寻访1'],
      ['飘行申领', 'weapon', '重构申领1'],
    ],
  );
  assert.deepEqual(
    endfieldPoolSpecs('「月映申领」限时特卖说明').map((s) => [s.name, s.type]),
    [['月映', 'weapon']],
  );
});

test('hypergryph-cms：相对表述锚不到维护公告时 start_at=null（不猜）', () => {
  const range = parseNoticeRange('开放时间：「不存在的版本」版本更新后 - 2026/12/23 11:59（服务器时间）', Date.parse('2026-11-24T04:00:00+08:00'), []);
  assert.equal(range.start_at, null);
  assert.equal(range.end_at, '2026-12-23T11:59:00+08:00');
});

// —————————————————— PRTS ——————————————————

test('prts-smw：wikitext 表格解析常驻轮换（6★ 与 5★ 分开）', async () => {
  const { ctx } = makeCtx();
  const all = await prtsSmwAdapter.collect(ctx);
  const standard = all.filter((c) => c.pool_type === 'standard_character');
  assert.equal(standard.length, 7, '快照里 7 期常驻轮换应全部解析出来');
  const period197 = standard.find((c) => c.start_at === '2026-11-05T04:00:00+08:00');
  assert.ok(period197, '应含 11/05 那期');
  assert.deepEqual(period197!.characters, ['薇薇安娜', '隐德来希'], '只取 6★ 名单（5★ 放 note）');
  assert.equal(period197!.end_at, '2026-11-19T03:59:00+08:00');
  assert.equal(period197!.pool_name, '常驻标准寻访');
  assert.match(String(period197!.note), /深律/, '5★ 出率提升放 note 备查');
  assert.equal(period197!.source.id, 'prts-smw');
  assert.equal(period197!.source.tier, 'L2');
  for (const c of standard) {
    assert.ok(cstOk(c.start_at) && cstOk(c.end_at), '时间必须是东八区 ISO: ' + c.start_at);
    assert.ok(c.characters.length <= 2, '6★ 名单不超过 2 人：' + c.characters.join(','));
  }
});

test('prts-smw：SMW ask 的 {timestamp} 结构与「出率提升干员」→ standard_character', async () => {
  const { ctx } = makeCtx();
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'prts-smw-ask.json'), 'utf8')).data;
  const parsed = parsePrtsAsk(raw, ctx);
  assert.ok(parsed.length >= 3, 'ask 快照应产出多期轮换');
  for (const c of parsed) {
    assert.equal(c.game_key, 'arknights');
    assert.equal(c.pool_type, 'standard_character');
    assert.ok(c.characters.length === 5, 'ask 的「出率提升干员」是 2 个 6★ + 3 个 5★');
    assert.ok(cstOk(c.start_at) && cstOk(c.end_at));
    assert.match(String(c.start_at), /^2026-/);
  }
  const first = parsed[0];
  assert.deepEqual(first.characters, ['霍尔海雅', '娜仁图亚', '小满', '裁度', '乌啾']);
  assert.equal(first.start_at, '2026-11-19T04:00:00+08:00', 'timestamp(秒) 需按 UTC→+08:00 换算');
  assert.equal(first.end_at, '2026-12-03T03:59:00+08:00');
  assert.match(String(first.note), /商店兑换/);
});

test('prts-smw：两条路径同键合并，以 wikitext（6★ 精确）为主', async () => {
  const { ctx } = makeCtx();
  const all = await prtsSmwAdapter.collect(ctx);
  assert.equal(all.length, 7, '两条路径覆盖同一批期次，合并后仍是 7 条');
  const key197 = all.find((c) => c.start_at === '2026-11-05T04:00:00+08:00')!;
  assert.deepEqual(key197.characters, ['薇薇安娜', '隐德来希'], '同键合并后不再是 ask 的 5 人名单');
  const urls = new Set(all.map((c) => c.source.url));
  assert.ok(urls.size >= 1);
});

test('prts-smw：wikitext 缺模板/表格时不产出（不编造）', () => {
  const { ctx } = makeCtx();
  assert.deepEqual(parsePrtsWikitext('', ctx), []);
  assert.deepEqual(parsePrtsWikitext('{{寻访信息|寻访名=常驻标准寻访}}', ctx), [], '没有时间与角色就不产出');
});

// —————————————————— Akasha ——————————————————

test('akasha：绝区零 代理人调频 = 角色池、音擎调频 = 武器池，时间 UTC→+08:00', async () => {
  const { ctx } = makeCtx();
  const all = await akashaAdapter.collect(ctx);
  const zzz = byKey(all, 'zzz');
  assert.equal(zzz.length, 4, '快照里 4 个卡池（其余 kind 必须被过滤）');
  assert.ok(all.every((c) => c.start_at === null || /\+08:00$/.test(String(c.start_at))));

  const agent = zzz.filter((c) => c.start_at === '2026-11-11T12:00:00+08:00' && c.pool_type === 'limited_character');
  assert.equal(agent.length, 1);
  assert.equal(agent[0].pool_name, '代理人调频');
  assert.deepEqual(agent[0].characters, ['赛维里安', '诺姆']);
  assert.equal(agent[0].end_at, '2026-12-01T14:59:00+08:00', '2026-12-01T06:59Z → +08:00');
  assert.equal(agent[0].version, '3.3');

  const wengines = zzz.filter((c) => c.pool_type === 'weapon');
  assert.equal(wengines.length, 2, '两期音擎调频都是武器池');
  for (const w of wengines) {
    assert.deepEqual(w.characters, [], '武器池不列角色');
    assert.equal(w.pool_name, '音擎调频');
    assert.match(String(w.note), /音擎：/);
  }
});

test('akasha：原神只有池名 → characters=[] 且 note=池名待映射角色；神铸赋形按武器池', async () => {
  const { ctx } = makeCtx();
  const all = await akashaAdapter.collect(ctx);
  const ys = byKey(all, 'genshin');
  assert.equal(ys.length, 10);
  const shuisong = ys.find((c) => c.pool_name === '众水的颂诗')!;
  assert.ok(shuisong, '应解析出「众水的颂诗」');
  assert.deepEqual(shuisong.characters, []);
  assert.equal(shuisong.note, '池名待映射角色');
  assert.equal(shuisong.pool_type, 'limited_character');
  assert.equal(shuisong.start_at, '2026-11-04T11:00:00+08:00', '2026-11-04T03:00Z → +08:00');
  assert.equal(shuisong.end_at, '2026-11-24T17:59:00+08:00');
  assert.equal(shuisong.version, '7.2');
  const weapon = ys.filter((c) => c.pool_name === '神铸赋形');
  assert.ok(weapon.length >= 2, '神铸赋形每期一条');
  assert.ok(weapon.every((c) => c.pool_type === 'weapon'));
});

test('akasha：星铁「活动跃迁：」拆角色与池名，描述性池名不会混进角色', async () => {
  const { ctx } = makeCtx();
  const all = await akashaAdapter.collect(ctx);
  const hsr = byKey(all, 'hsr');
  assert.equal(hsr.length, 4);

  const big = hsr.find((c) => c.start_at === '2026-11-11T11:00:00+08:00' && c.pool_name.includes('欢迎来到银河城'));
  assert.ok(big, '应解析出 4.7 那期');
  assert.deepEqual(big!.characters, ['银狼LV.999', '火花', '爻光']);
  assert.equal(big!.pool_name, '欢迎来到银河城、花花世界迷人眼、当她决定看见');
  assert.equal(big!.note, null);

  const aha = hsr.find((c) => c.pool_name.includes('阿哈') && c.pool_type === 'limited_character' && c.characters.length > 0);
  assert.ok(aha, '应解析出阿哈那期');
  assert.deepEqual(aha!.characters, ['星神★阿哈']);
  assert.equal(aha!.pool_name, '当第一声『阿哈』响起');
});

test('akasha：标题映射的边界（无「：」/只给池名）不产生角色', () => {
  assert.deepEqual(classifyAkashaPool('genshin', '莓色香颂'), {
    pool_name: '莓色香颂',
    pool_type: 'limited_character',
    characters: [],
    note: '池名待映射角色',
  });
  assert.equal(classifyAkashaPool('genshin', '神铸赋形')?.pool_type, 'weapon');
  assert.equal(classifyAkashaPool('zzz', '代理人调频：菲欧妮、维琳娜')?.characters.join(','), '菲欧妮,维琳娜');
  assert.equal(utcToCstIso('2026-11-11T03:00:00Z'), '2026-11-11T11:00:00+08:00');
  assert.equal(utcToCstIso('not-a-date'), null);
});

// —————————————————— 离线 / 失败语义 ——————————————————

test('三个适配器都是 SourceAdapter 且声明了 games/tier', () => {
  for (const adapter of [hypergryphCmsAdapter, prtsSmwAdapter, akashaAdapter]) {
    assert.equal(typeof adapter.collect, 'function');
    assert.ok(adapter.id && adapter.label);
    assert.ok(Array.isArray(adapter.games) && adapter.games.length > 0);
    assert.match(adapter.tier, /^L[0-4]$/);
  }
  assert.deepEqual(hypergryphCmsAdapter.games, ['endfield', 'arknights']);
  assert.deepEqual(prtsSmwAdapter.games, ['arknights']);
  assert.deepEqual(akashaAdapter.games, ['genshin', 'hsr', 'zzz']);
});

test('离线且无缓存时返回 [] 并打日志（绝不编造数据）', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cache-empty-'));
  try {
    for (const adapter of [hypergryphCmsAdapter, prtsSmwAdapter, akashaAdapter]) {
      const { ctx, logs } = makeCtx(empty);
      const out = await adapter.collect(ctx);
      assert.deepEqual(out, [], adapter.id + ' 无缓存必须返回 []');
      assert.ok(logs.length > 0, adapter.id + ' 必须 ctx.log 记录原因');
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('withSourceCache：离线只读缓存，不回落到网络', async () => {
  const { ctx } = makeCtx();
  let called = false;
  const data = await withSourceCache(ctx, 'akasha-zzz', async () => {
    called = true;
    return { total: 0, items: [] };
  });
  assert.equal(called, false, 'offline=true 时不得发起网络请求');
  assert.ok(data && (data as any).items.length > 0);
});

test('所有产出的时间字段都是 +08:00 结尾或 null', async () => {
  const { ctx } = makeCtx();
  const all = [
    ...(await hypergryphCmsAdapter.collect(ctx)),
    ...(await prtsSmwAdapter.collect(ctx)),
    ...(await akashaAdapter.collect(ctx)),
  ];
  assert.ok(all.length > 20);
  for (const c of all) {
    assert.ok(cstOk(c.start_at), c.pool_name + ' start_at 非东八区: ' + c.start_at);
    assert.ok(cstOk(c.end_at), c.pool_name + ' end_at 非东八区: ' + c.end_at);
    assert.ok(c.pool_name && c.pool_name.length > 0);
    assert.ok(['limited_character', 'rerun_character', 'standard_character', 'fes', 'weapon', 'other'].includes(c.pool_type));
    assert.equal(c.source.tier, c.game_key === 'endfield' || c.game_key === 'arknights' ? c.source.tier : c.source.tier);
  }
});
