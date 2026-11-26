// nteguide 历史卡池适配器（id: nte-history）的离线回归测试。
// 断言口径：只出 pact 池 / 池名=中文名 / period=「版本 阶段」/ 东八区 00:00–23:59 / 只取最近 6 条 / roster 覆盖全部版本。
// 数据全部来自 data/fixtures/sources/nte-history-banners.json（https://nteguide.com/zh/banners/ 真实响应的裁剪快照：
// 只保留历史卡池卡片那一段 <section>，9 张卡片的文本结构与线上一致）。
// 不联网（ctx.offline=true 时 withSourceCache 只读缓存），不读进程时区（时间全部由 datetime 的显式 +08:00 构造）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nteHistoryAdapter,
  parseNteHistoryHtml,
  parseNteHistoryEntries,
  pickRecentEntries,
  NTE_HISTORY_CACHE_ID,
} from '../apps/crawler/src/sources/nte/history.ts';
import { withSourceCache } from '../apps/crawler/src/sources/http.ts';
import type { CharacterBookEntry, PoolCandidate, SourceContext } from '../apps/crawler/src/pools/types.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../data/fixtures/sources', import.meta.url));
const NOW = Date.parse('2026-11-26T14:00:00+08:00');

function makeCtx(cacheDir = FIXTURE_DIR): { ctx: SourceContext; logs: string[] } {
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

const cstOk = (iso: string | null) => iso === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(iso);
const byName = (list: PoolCandidate[], name: string) => list.filter((c) => c.pool_name === name);

// —————————————————— 缓存 id / 快照 ——————————————————

test('缓存 id 形如 <id>-*.json，且离线快照就放在 data/fixtures/sources 下', () => {
  assert.equal(nteHistoryAdapter.id, 'nte-history');
  assert.match(NTE_HISTORY_CACHE_ID, /^nte-history-.*$/);
  assert.ok(!NTE_HISTORY_CACHE_ID.includes('/'), '缓存 id 不能带路径分隔符');
  const fixture = path.join(FIXTURE_DIR, `${NTE_HISTORY_CACHE_ID}.json`);
  assert.ok(fs.existsSync(fixture), '快照文件名必须等于 <cache-id>.json: ' + fixture);
  const raw = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.equal(typeof raw.data, 'string', 'withSourceCache 落盘格式为 { cached_at, data }');
  assert.match(raw.data, /历史记录/);
});

// —————————————————— 适配器形状 ——————————————————

test('是合法 SourceAdapter：id/tier/label/games/collect/roster', () => {
  assert.equal(nteHistoryAdapter.tier, 'L3');
  assert.equal(typeof nteHistoryAdapter.label, 'string');
  assert.ok(nteHistoryAdapter.label.length > 0);
  assert.deepEqual(nteHistoryAdapter.games, ['yh']);
  assert.equal(typeof nteHistoryAdapter.collect, 'function');
  assert.equal(typeof nteHistoryAdapter.roster, 'function');
});

// —————————————————— collect：pact 候选池 ——————————————————

test('collect：离线快照产出 6 条 pact 池（只取最近 6 条，避免历史池刷屏）', async () => {
  const { ctx } = makeCtx();
  const all = await nteHistoryAdapter.collect(ctx);
  assert.equal(all.length, 6, '历史记录共 9 条，只能取最近 6 条');
  for (const c of all) {
    assert.equal(c.game_key, 'yh');
    assert.equal(c.pool_type, 'pact', '异环历史记录统一按协定池处理');
    assert.equal(c.source.id, 'nte-history');
    assert.equal(c.source.tier, 'L3');
    assert.equal(c.source.url, 'https://nteguide.com/zh/banners/');
    assert.equal(c.source.fetched_at, '2026-11-26T14:00:00+08:00', 'fetched_at 用 ctx.nowCst');
    assert.match(String(c.note), /nteguide 历史卡池（非当期）/, 'note 必须声明非当期');
    assert.equal(c.characters.length, 1, '每条只有一个 UP 角色');
    assert.deepEqual(c.characters, [c.pool_name], 'characters 就是英文名括号外的中文名');
    assert.ok(c.evidence && c.evidence.includes(c.pool_name), 'evidence 保留原文片段');
    assert.ok(cstOk(c.start_at) && cstOk(c.end_at), '时间必须 +08:00 或 null: ' + c.pool_name);
    assert.match(String(c.start_at), /T00:00:00\+08:00$/, '起点 00:00');
    assert.match(String(c.end_at), /T23:59:00\+08:00$/, '终点 23:59');
    assert.ok(!('published_at' in c), 'PoolCandidate 没有 published_at，留空即不设置');
  }
});

test('collect：最新一条是 1.3 下半「链子」，时间与 period 精确对齐', async () => {
  const { ctx } = makeCtx();
  const all = await nteHistoryAdapter.collect(ctx);
  const linko = byName(all, '链子');
  assert.equal(linko.length, 1);
  const p = linko[0];
  assert.equal(p.period, '1.3 下半');
  assert.equal(p.version, '1.3');
  assert.equal(p.start_at, '2026-09-09T00:00:00+08:00');
  assert.equal(p.end_at, '2026-09-30T23:59:00+08:00');
  assert.equal(all[0].pool_name, '链子', '按开始时间倒序，第一条是最新的 1.3 下半');
  assert.match(String(p.evidence), /历史记录|1\.3 下半/);
});

test('collect：「赞空 (Zankou)」的中文名 / 英文名 / 起止日期解析正确', async () => {
  const { ctx } = makeCtx();
  const all = await nteHistoryAdapter.collect(ctx);
  const zankou = byName(all, '赞空');
  assert.equal(zankou.length, 1);
  const p = zankou[0];
  assert.equal(p.period, '1.3 上半');
  assert.deepEqual(p.characters, ['赞空']);
  assert.equal(p.start_at, '2026-08-19T00:00:00+08:00');
  assert.equal(p.end_at, '2026-09-09T23:59:00+08:00', '终点取当日 23:59，不跨界到次日');
  assert.equal(p.note, 'nteguide 历史卡池（非当期）');
});

test('collect：早期版本（1.0 上半 娜娜莉）被 6 条上限挡掉，但同版本 1.1 仍在', async () => {
  const { ctx } = makeCtx();
  const all = await nteHistoryAdapter.collect(ctx);
  const names = all.map((c) => c.pool_name);
  assert.ok(!names.includes('娜娜莉'), '1.0 上半（2026-04-29）是最早的一条，不该进来: ' + names.join(','));
  assert.ok(!names.includes('穗鸟'), '1.0 下半也不该进来');
  assert.ok(names.includes('卡厄斯'), '1.1 下半（2026-06-11）仍属于最近 6 条');
  assert.deepEqual(names, ['链子', '赞空', '伊洛伊', '真红', 'Iroi', '卡厄斯'], '按开始时间倒序，输出稳定');
});

test('collect：页面把英文写在括号外时（Iroi (Illica)）不编造中文名，note 标注', async () => {
  const { ctx } = makeCtx();
  const all = await nteHistoryAdapter.collect(ctx);
  const iroi = byName(all, 'Iroi');
  assert.equal(iroi.length, 1, '页面这一条只有英文名');
  assert.equal(iroi[0].period, '1.2 上半');
  assert.deepEqual(iroi[0].characters, ['Iroi']);
  assert.match(String(iroi[0].note), /页面未给中文名/);
  // 同一角色的中文条目（伊洛伊 (Iroi)）必须各自独立，不能被合并掉
  const yiroi = byName(all, '伊洛伊');
  assert.equal(yiroi.length, 1);
  assert.equal(yiroi[0].period, '1.2 下半');
  assert.equal(yiroi[0].start_at, '2026-07-29T00:00:00+08:00');
});

// —————————————————— 解析器（不依赖网络） ——————————————————

test('parseNteHistoryHtml：快照里 9 条全部解析出来（6 条上限只作用在 collect）', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${NTE_HISTORY_CACHE_ID}.json`), 'utf8'));
  const entries = parseNteHistoryHtml(fixture.data);
  assert.equal(entries.length, 9);
  assert.deepEqual(
    entries.map((e) => [e.version, e.stage, e.cn, e.en]),
    [
      ['1.3', '上半', '赞空', 'Zankou'],
      ['1.3', '下半', '链子', 'Linko'],
      ['1.2', '上半', 'Iroi', 'Illica'],
      ['1.2', '下半', '真红', 'Zhenhong'],
      ['1.2', '下半', '伊洛伊', 'Iroi'],
      ['1.1', '上半', '安魂曲', 'Lacrimosa'],
      ['1.1', '下半', '卡厄斯', 'Chaos'],
      ['1.0', '上半', '娜娜莉', 'Nanally'],
      ['1.0', '下半', '穗鸟', 'Hotori'],
    ],
  );
});

test('parseNteHistoryEntries：全角括号 / 阶段缺失 / 无日期噪声块 / script 干扰', () => {
  const html = [
    '<html><body>',
    // stripHtml 必须丢掉 script —— 里面的假条目绝不能进结果
    '<script type="application/ld+json">{"t":"历史记录 9.9 上半 假人 (Fake) 2026.01.01 - 2026.01.02"}</script>',
    // 噪声：提到「历史记录」但没有起止日期
    '<p>站内历史记录 1.0 上半 赞空 (Zankou) 仅供回顾。</p>',
    // 全角括号 + 正常条目
    '<div>历史记录 1.4 上半 甲（Alpha）</div><div>2026.12.01 - 2026.12.15</div>',
    // 缺阶段：period 退化为版本号
    '<div>历史记录 1.4 乙 (Beta)</div><div>2026.12.15 - 2026.12.29</div>',
    '</body></html>',
  ].join('');
  const entries = parseNteHistoryHtml(html);
  assert.deepEqual(entries.map((e) => [e.version, e.stage, e.cn, e.en]), [
    ['1.4', '上半', '甲', 'Alpha'],
    ['1.4', null, '乙', 'Beta'],
  ]);
  assert.ok(!entries.some((e) => e.cn === '假人'), 'script 内容必须被 stripHtml 丢掉');
  assert.ok(!entries.some((e) => e.cn === '赞空'), '没有起止日期的块不算卡池条目');
});

test('parseNteHistoryEntries：描述句被括号串成「名字」时不产出（不把正文当角色名）', () => {
  const html = '<div>历史记录 1.5 上半 这是一个描述句子，不是角色名 (NotAName)</div><div>2026.10.01 - 2026.10.15</div>';
  assert.deepEqual(parseNteHistoryHtml(html), []);
});

test('parseNteHistoryEntries：非法日期不做进位兜底，返回 null', () => {
  const html = '<div>历史记录 2.0 上半 丙 (Gamma)</div><div>2026.02.30 - 2026.03.10</div>';
  const entries = parseNteHistoryHtml(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].start_at, null, '2026-02-30 不存在 → null（不猜测、不进位成 3/2）');
  assert.equal(entries[0].end_at, '2026-03-10T23:59:00+08:00');
});

test('parseNteHistoryEntries：空文本 / 无关 HTML 返回 []', () => {
  assert.deepEqual(parseNteHistoryEntries(''), []);
  assert.deepEqual(parseNteHistoryHtml('<html><body><p>没有历史记录</p></body></html>'), []);
});

test('pickRecentEntries：按开始时间倒序，缺时间的排最后', () => {
  const entries = parseNteHistoryHtml(
    [
      '<div>历史记录 1.0 上半 甲 (A)</div><div>2026.01.01 - 2026.01.10</div>',
      '<div>历史记录 2.0 上半 乙 (B)</div><div>2026.05.01 - 2026.05.10</div>',
      '<div>历史记录 3.0 上半 丙 (C)</div><div>时间待定</div>',
    ].join(''),
  );
  // 「时间待定」没有起止日期 → 整条被跳过，因此这里只有 2 条
  assert.equal(entries.length, 2);
  assert.deepEqual(pickRecentEntries(entries, 1).map((e) => e.cn), ['乙']);
  assert.deepEqual(pickRecentEntries(entries, 10).map((e) => e.cn), ['乙', '甲']);
});

// —————————————————— roster ——————————————————

test('roster：覆盖全部版本的 中文名/英文名，供 resolver 做 yh 角色名校验', async () => {
  const { ctx } = makeCtx();
  const roster = (await nteHistoryAdapter.roster!(ctx)) as CharacterBookEntry[];
  assert.ok(roster.length >= 9, 'roster 不受 6 条上限影响: ' + roster.length);
  for (const r of roster) assert.equal(r.game_key, 'yh');
  const pick = (cn: string) => roster.filter((r) => r.cn === cn);
  assert.deepEqual(pick('赞空').map((r) => [r.cn, r.en]), [['赞空', 'Zankou']]);
  assert.deepEqual(pick('链子').map((r) => [r.cn, r.en]), [['链子', 'Linko']]);
  // 1.0 的角色也要在名单里（collect 里已被 6 条上限挡掉）
  assert.deepEqual(pick('娜娜莉').map((r) => [r.cn, r.en]), [['娜娜莉', 'Nanally']]);
  assert.deepEqual(pick('穗鸟').map((r) => [r.cn, r.en]), [['穗鸟', 'Hotori']]);
  // 同名不重复
  const cns = roster.map((r) => r.cn);
  assert.equal(new Set(cns).size, cns.length, 'roster 不能有重复中文名');
});

// —————————————————— 离线 / 失败语义 ——————————————————

test('离线且无缓存：collect / roster 都返回 [] 并打日志（绝不编造）', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nte-history-empty-'));
  try {
    const { ctx, logs } = makeCtx(empty);
    assert.deepEqual(await nteHistoryAdapter.collect(ctx), []);
    assert.ok(logs.some((l) => l.includes('nte-history')), '必须 ctx.log 记录原因: ' + logs.join('|'));
    const { ctx: ctx2, logs: logs2 } = makeCtx(empty);
    assert.deepEqual(await nteHistoryAdapter.roster!(ctx2), []);
    assert.ok(logs2.length > 0);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('withSourceCache：offline=true 时只读缓存，绝不发起网络请求', async () => {
  const { ctx } = makeCtx();
  let called = false;
  const data = await withSourceCache<string>(ctx, NTE_HISTORY_CACHE_ID, async () => {
    called = true;
    throw new Error('offline 下不应走到 fetcher');
  });
  assert.equal(called, false, 'offline=true 时不得发起网络请求');
  assert.equal(typeof data, 'string');
  assert.match(String(data), /历史记录/);
});
