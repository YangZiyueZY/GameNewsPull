// 离线回归测试：统一时间源（utils/datetime.ts）与 RSS 输出（extract/rss.ts）。
// 全部是纯计算：不联网、不读进程时区；TZ 独立性用子进程各跑一遍验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CST_OFFSET,
  toCstIso,
  nowCstIso,
  cstParts,
  cstDayKey,
  cstDayDiff,
  cstDayStart,
  fromCstParts,
  rfc822Cst,
  parseCnDateCst,
  cnDateToIso,
  tsToIso,
} from '../apps/crawler/src/utils/datetime.ts';
import { buildRss } from '../apps/crawler/src/extract/rss.ts';
import { buildRss as buildRssFromFeed } from '../apps/crawler/src/extract/feed.ts';
import { GAMES } from '../apps/crawler/config/games.ts';
import type { NewsItem } from '../apps/crawler/src/extract/normalize.ts';

// 2026-11-24T12:00:00+08:00（= 2026-11-24T04:00:00Z，周二）
const TS = 1795492800000;

function news(overrides: Partial<NewsItem> & { id: string; published_at: string }): NewsItem {
  return {
    game_key: 'genshin',
    game_name: '原神',
    type: 'dynamic',
    title: '测试动态',
    summary: '测试正文',
    url: 'https://www.bilibili.com/opus/' + overrides.id,
    images: [],
    source_mid: '',
    source_name: '原神',
    ...overrides,
  };
}

// ——————————————————————— 基础换算 ———————————————————————

test('CST_OFFSET 固定为 8 小时（东八区无夏令时）', () => {
  assert.equal(CST_OFFSET, 28_800_000);
});

test('toCstIso 输出 +08:00 秒级 ISO，且接受 ms / ISO / Date', () => {
  assert.equal(toCstIso(TS), '2026-11-24T12:00:00+08:00');
  assert.equal(toCstIso('2026-11-24T04:00:00Z'), '2026-11-24T12:00:00+08:00');
  assert.equal(toCstIso(new Date(TS)), '2026-11-24T12:00:00+08:00');
  // 毫秒被截断而不是进位
  assert.equal(toCstIso(TS + 999), '2026-11-24T12:00:00+08:00');
});

test('nowCstIso 默认取当前时间，且格式恒定', () => {
  assert.equal(nowCstIso(TS), '2026-11-24T12:00:00+08:00');
  assert.match(nowCstIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
});

test('cstParts 拆出东八区钟面字段（month 1-12、weekday 0=周日）', () => {
  assert.deepEqual(cstParts(TS), {
    year: 2026, month: 11, day: 24, hour: 12, minute: 0, second: 0, weekday: 2,
  });
  // UTC 还是 11-23，东八区已经是 11-24
  assert.equal(cstParts('2026-11-23T16:30:00Z').day, 24);
  assert.equal(cstParts('2026-11-23T16:30:00Z').hour, 0);
});

test('cstDayKey 按东八区日历日取键', () => {
  assert.equal(cstDayKey(TS), '2026-11-24');
  assert.equal(cstDayKey('2026-11-24T00:00:00+08:00'), '2026-11-24');
  assert.equal(cstDayKey('2026-11-24T23:59:59+08:00'), '2026-11-24');
  assert.equal(cstDayKey('2026-11-25T00:00:00+08:00'), '2026-11-25');
});

// ——————————————————————— 日历日差 ———————————————————————

test('cstDayDiff 同一天返回 0，即使跨了 24 小时内的两小时', () => {
  assert.equal(cstDayDiff('2026-11-24T00:00:00+08:00', '2026-11-24T23:59:59+08:00'), 0);
  assert.equal(cstDayDiff('2026-11-24T23:00:00+08:00', '2026-11-25T01:00:00+08:00'), 1);
  assert.equal(cstDayDiff('2026-11-25T01:00:00+08:00', '2026-11-24T23:00:00+08:00'), -1);
});

test('cstDayDiff 常规天数与跨年', () => {
  assert.equal(cstDayDiff('2026-11-24T12:00:00+08:00', '2026-11-27T01:00:00+08:00'), 3);
  assert.equal(cstDayDiff('2026-12-30T00:00:00+08:00', '2027-01-05T23:00:00+08:00'), 6);
  // 只差 90 秒，但已经跨年跨日
  assert.equal(cstDayDiff('2026-12-31T23:59:00+08:00', '2027-01-01T00:00:30+08:00'), 1);
  // 跨年同一天
  assert.equal(cstDayDiff('2026-12-31T00:00:00+08:00', '2026-12-31T23:00:00+08:00'), 0);
});

test('cstDayDiff 用东八区判日，UTC 判日会算错的一天', () => {
  // UTC 下两者都是 11-23，东八区下已经是 11-24 → 同日
  assert.equal(cstDayDiff('2026-11-24T00:30:00+08:00', '2026-11-24T08:30:00+08:00'), 0);
  // 东八区 11-24 00:30（UTC 11-23 16:30）→ 东八区 11-25 00:10 = 1 天
  assert.equal(cstDayDiff('2026-11-24T00:30:00+08:00', '2026-11-25T00:10:00+08:00'), 1);
});

// ——————————————————————— 日界 / 构造 ———————————————————————

test('cstDayStart 返回到东八区当日 00:00', () => {
  assert.equal(toCstIso(cstDayStart(TS)), '2026-11-24T00:00:00+08:00');
  assert.equal(toCstIso(cstDayStart('2026-11-24T23:59:59+08:00')), '2026-11-24T00:00:00+08:00');
  assert.equal(toCstIso(cstDayStart('2026-11-24T00:00:00+08:00')), '2026-11-24T00:00:00+08:00');
  // 同一东八区日内起点一致
  assert.equal(cstDayStart(TS), fromCstParts(2026, 11, 24));
});

test('fromCstParts 显式按 +08:00 构造，可与 cstParts 往返', () => {
  assert.equal(toCstIso(fromCstParts(2026, 11, 24, 12, 0)), '2026-11-24T12:00:00+08:00');
  const ms = fromCstParts(2027, 1, 3, 5, 7);
  assert.deepEqual(cstParts(ms), {
    year: 2027, month: 1, day: 3, hour: 5, minute: 7, second: 0, weekday: 0,
  });
});

// ——————————————————————— RFC 822 ———————————————————————

test('rfc822Cst 精确串：Tue, 24 Nov 2026 12:00:00 +0800', () => {
  assert.equal(rfc822Cst(TS), 'Tue, 24 Nov 2026 12:00:00 +0800');
  assert.ok(rfc822Cst(TS).endsWith('+0800'));
  assert.equal(rfc822Cst('2027-01-03T05:07:09+08:00'), 'Sun, 03 Jan 2027 05:07:09 +0800');
  // 个位数日/时补零
  assert.equal(rfc822Cst('2026-11-04T09:05:00+08:00'), 'Wed, 04 Nov 2026 09:05:00 +0800');
});

// ——————————————————————— 中文日期解析 ———————————————————————

test('parseCnDateCst 显式按 +08:00 构造（含时分）', () => {
  assert.equal(parseCnDateCst('2026年11月4日 12:00'), '2026-11-04T12:00:00+08:00');
  assert.equal(parseCnDateCst('活动于 2026年12月31日 23:30 结束'), '2026-12-31T23:30:00+08:00');
  assert.equal(parseCnDateCst('2026年11月4日'), '2026-11-04T00:00:00+08:00');
});

test('parseCnDateCst 缺年份时用参考年份（默认当前东八区年份）', () => {
  assert.equal(parseCnDateCst('11月4日', 2027), '2027-11-04T00:00:00+08:00');
  assert.equal(parseCnDateCst('11月4日 9:05', 2026), '2026-11-04T09:05:00+08:00');
  const currentYear = cstParts(Date.now()).year;
  assert.equal(parseCnDateCst('11月4日'), `${currentYear}-11-04T00:00:00+08:00`);
});

test('parseCnDateCst 拒绝非法日期，不静默进位', () => {
  assert.equal(parseCnDateCst('2月30日', 2026), null);
  assert.equal(parseCnDateCst('2026年13月4日'), null);
  assert.equal(parseCnDateCst('2026年11月4日 25:00'), null);
  assert.equal(parseCnDateCst('没有日期'), null);
  assert.equal(parseCnDateCst(''), null);
});

test('旧导出名 tsToIso / cnDateToIso 保持可用且输出 +08:00', () => {
  // B 站接口给秒级时间戳
  assert.equal(tsToIso(1795492800), '2026-11-24T12:00:00+08:00');
  assert.equal(tsToIso('1795492800'), '2026-11-24T12:00:00+08:00');
  assert.match(tsToIso('不是时间'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.equal(cnDateToIso('2026年11月4日'), '2026-11-04T00:00:00+08:00');
  assert.equal(cnDateToIso('无日期'), null);
});

// ——————————————————————— RSS ———————————————————————

const rssItems: NewsItem[] = [
  news({ id: 'a1', title: '有图动态 A & B <C> "D"', summary: '第一段', images: ['img/2026/a.jpg'], published_at: '2026-11-24T12:00:00+08:00' }),
  news({ id: 'a2', title: '只有封面', summary: '第二段', cover: 'https://i0.hdslb.com/bfs/x.jpg', published_at: '2026-11-24T09:30:00+08:00' }),
  news({ id: 'a3', title: '无图动态', summary: '第三段', published_at: '2026-11-23T08:00:00+08:00' }),
];

test('buildRss 的 lastBuildDate 为 +0800 形式', () => {
  const rss = buildRss(rssItems, GAMES, TS);
  assert.match(rss, /<lastBuildDate>Tue, 24 Nov 2026 12:00:00 \+0800<\/lastBuildDate>/);
  assert.ok(rss.includes('+0800</lastBuildDate>'), 'lastBuildDate 应以 +0800 结尾');
  assert.ok(!rss.includes('GMT'), '不再输出 GMT 形式的日期');
});

test('buildRss 声明 rss2.0 + atom + media 命名空间', () => {
  const rss = buildRss(rssItems, GAMES, TS);
  assert.match(rss, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(rss, /<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom" xmlns:media="http:\/\/search\.yahoo\.com\/mrss\/">/);
  assert.match(rss, /<atom:link href="[^"]+feed\.rss" rel="self" type="application\/rss\+xml"\/>/);
});

test('buildRss 有图条目带 enclosure + media:content + description 内 <img>，无图条目不带', () => {
  const rss = buildRss(rssItems, GAMES, TS);
  const enclosures = rss.match(/<enclosure /g) ?? [];
  assert.equal(enclosures.length, 2, '两张有图条目各一条 enclosure');
  // 站内相对路径 → CDN 绝对地址
  assert.match(rss, /<enclosure url="https:\/\/cdn\.jsdelivr\.net\/gh\/[^"]+\/img\/2026\/a\.jpg" type="image\/jpeg" length="0"\/>/);
  // 远程封面原样使用
  assert.ok(rss.includes('<enclosure url="https://i0.hdslb.com/bfs/x.jpg" type="image/jpeg" length="0"/>'));
  assert.equal((rss.match(/<media:content /g) ?? []).length, 2);
  assert.ok(rss.includes('<media:content url="https://i0.hdslb.com/bfs/x.jpg" medium="image"/>'));
  // 图在 description 的 CDATA 里
  assert.match(rss, /<description><!\[CDATA\[<p>第一段<\/p><img src="https:\/\/cdn\.jsdelivr\.net\/gh\/[^"]+" alt="有图动态 A &amp; B &lt;C&gt; &quot;D&quot;"\/>\]\]><\/description>/);
  // 无图条目：只有纯文本 description，没有 img
  assert.ok(rss.includes('<description>第三段</description>'));
  assert.ok(!/第三段<\/p>/.test(rss));
});

test('buildRss 每条 item 都有 +0800 的 pubDate，XML 转义完整', () => {
  const rss = buildRss(rssItems, GAMES, TS);
  const pubDates = rss.match(/<pubDate>[^<]+<\/pubDate>/g) ?? [];
  assert.equal(pubDates.length, 3);
  for (const pub of pubDates) assert.ok(pub.endsWith('+0800</pubDate>'), 'pubDate 应为 +0800：' + pub);
  assert.ok(rss.includes('<pubDate>Tue, 24 Nov 2026 12:00:00 +0800</pubDate>'));
  // 标题里的 & < > " 必须转义，标签不能被破坏
  assert.ok(rss.includes('<title>[原神] 有图动态 A &amp; B &lt;C&gt; &quot;D&quot;</title>'));
});

test('buildRss 的 CDATA 正文先转义，不会出现裸 ]]> 提前闭合', () => {
  const rss = buildRss([news({ id: 'x1', title: '注入', summary: '前缀 ]]> 后半段', images: ['img/x.jpg'], published_at: '2026-11-24T12:00:00+08:00' })], GAMES, TS);
  // 注意先取出 <item>：channel 自己也有一个 <description>
  const item = rss.match(/<item>[\s\S]*?<\/item>/)![0];
  const desc = item.match(/<description>[\s\S]*?<\/description>/)![0];
  assert.ok(desc.startsWith('<description><![CDATA['), '有图条目用 HTML CDATA');
  assert.ok(desc.endsWith(']]></description>'), 'CDATA 正常闭合');
  // 正文里的 > 已被转义，CDATA 内只剩收尾的那一个 ]]>（XML 不会被提前闭合）
  assert.ok(desc.includes('前缀 ]]&gt; 后半段'), '正文应转义后进入 CDATA');
  const inner = desc.slice('<description>'.length, -'</description>'.length);
  assert.equal((inner.match(/\]\]>/g) ?? []).length, 1, 'CDATA 内只应有收尾的 ]]>');
});

test('buildRss 按发布时间倒序并截断 100 条', () => {
  const many: NewsItem[] = Array.from({ length: 120 }, (_, i) => news({
    id: 'm' + i,
    title: '动态 ' + i,
    published_at: toCstIso(TS - (120 - i) * 3600_000),
  }));
  const rss = buildRss(many, GAMES, TS);
  const items = rss.match(/<item>/g) ?? [];
  assert.equal(items.length, 100);
  const firstTitle = rss.match(/<item>\s*<title>([^<]*)<\/title>/)![1];
  assert.ok(firstTitle.endsWith('动态 119'), '最新的一条排在最前：' + firstTitle);
});

test('buildRss 从 feed.ts 的兼容导出与 rss.ts 实现一致', () => {
  assert.equal(buildRssFromFeed, buildRss);
  assert.ok(buildRssFromFeed(rssItems, GAMES, TS).startsWith('<?xml'));
});

test('buildRss 兼容图片对象形态与坏发布时间', () => {
  // 未来 API 层可能把 images 换成 {url,fallback,local} 对象；RSS 不能因此丢图
  const objectImage = news({ id: 'o1', title: '对象图', published_at: '2026-11-24T12:00:00+08:00' });
  (objectImage as unknown as { images: unknown[] }).images = [{ local: 'img/obj.jpg' }];
  const brokenTime = news({ id: 'o2', title: '坏时间', published_at: '不是时间', images: ['img/b.jpg'] });
  const rss = buildRss([objectImage, brokenTime], GAMES, TS);
  assert.ok(rss.includes('<enclosure url="https://cdn.jsdelivr.net/gh/'), '对象形态首图也要出 enclosure');
  assert.ok(!rss.includes('Invalid Date'), '坏时间不要输出 Invalid Date');
  assert.equal((rss.match(/<pubDate>/g) ?? []).length, 1, '只有能解析的那条有 pubDate');
});

// ——————————————————————— 进程时区无关 ———————————————————————

test('TZ=UTC / TZ=America/New_York 下输出完全一致（不依赖进程时区）', () => {
  const modUrl = new URL('../apps/crawler/src/utils/datetime.ts', import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(modUrl)});
    const ts = ${TS};
    console.log(JSON.stringify([
      m.toCstIso(ts), m.cstDayKey(ts), m.rfc822Cst(ts),
      m.cstDayStart(ts),
      m.cstDayDiff('2026-11-24T23:00:00+08:00', '2026-11-25T01:00:00+08:00'),
      m.parseCnDateCst('2026年11月4日 12:00'),
    ]));
  `;
  const run = (tz: string): string[] => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').pop()!) as string[];
  };
  const utc = run('UTC');
  const ny = run('America/New_York');
  assert.deepEqual(utc, ny);
  assert.deepEqual(utc, [
    '2026-11-24T12:00:00+08:00',
    '2026-11-24',
    'Tue, 24 Nov 2026 12:00:00 +0800',
    cstDayStart(TS),
    1,
    '2026-11-04T12:00:00+08:00',
  ]);
});
