// 离线兜底重建：用 data/store.json + 配置重新生成 feed.json / feed.rss。
//
// 用途：集成阶段 / 无网络环境 / 抓取失败但库存完好时，快速按最新配置（厂商、活动、生日、
// 预约档期）重建站点数据。**不联网、不下载图片**：通过 data/image-cache.json 把远程
// 图片地址映射回 apps/web/public/img 与 docs/img 中已提交的本地文件。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeDynamic } from './extract/normalize.ts';
import type { NewsItem } from './extract/normalize.ts';
import { buildFeed, buildRss } from './extract/feed.ts';
import { learnBirthdays, mergeBirthdayBook } from './extract/calendar.ts';
import type { BirthdayBook } from './extract/calendar.ts';
import { GAMES } from '../config/games.ts';
import { runBannerPipeline } from './pipeline/banners.ts';
import { SOURCE_ADAPTERS } from './sources/registry.ts';
import type { SourceContext } from './pools/types.ts';
import { applyCdn } from './utils/cdnize.ts';
import { buildApiBundle, writeApiBundle } from './extract/api.ts';
import { nowCstIso } from './utils/datetime.ts';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const WEB_PUBLIC = path.resolve('apps/web/public');
const BUILD_ROOT = path.resolve('docs');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const BIRTHDAY_FILE = path.join(DATA_DIR, 'birthdays.json');

function log(...args: any[]) { console.log('[rebuild]', ...args); }

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function main(): Promise<void> {
  const store = readJson(STORE_FILE);
  if (!store?.dynamics) {
    console.error('[rebuild] 找不到 data/store.json，无法离线重建');
    process.exitCode = 1;
    return;
  }

  const allItems: NewsItem[] = [];
  for (const row of store.dynamics as any[]) {
    try {
      const game = GAMES.find(g => g.key === row.game_key) || GAMES.find(g => g.mid === row.mid);
      if (!game) continue;
      const item = normalizeDynamic(JSON.parse(row.raw), game);
      if (item) allItems.push(item);
    } catch (e: any) {
      console.warn('[rebuild] WARN 跳过无法解析的库存条目', row.id, e.message);
    }
  }

  // 图标：沿用抓取时缓存的官方头像（store.state.face:<mid>），不联网
  const icons: Record<string, string> = {};
  for (const game of GAMES) {
    const face = store.state?.['face:' + game.mid];
    if (face) icons[game.key] = face;
  }

  // 生日簿：沿用已落盘数据 + 用库存动态重新学习后合并
  const previous: BirthdayBook = readJson(BIRTHDAY_FILE)?.games ?? {};
  const learned: BirthdayBook = {};
  for (const game of GAMES) {
    try {
      const records = learnBirthdays(game, allItems.filter(i => i.game_key === game.key));
      if (records.length) learned[game.key] = records;
    } catch (e: any) {
      console.warn('[rebuild] WARN ' + game.name + ' 生日学习失败:', e.message);
    }
  }
  const birthdays = mergeBirthdayBook(previous, learned);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BIRTHDAY_FILE, JSON.stringify({ generated_at: nowCstIso(), games: birthdays }, null, 2));

  let feed = buildFeed(allItems, GAMES, icons, { birthdays });

  // —— 多信源卡池：离线模式只读 data/source-cache，不联网（q1–q6）——
  const sourceCtx: SourceContext = {
    now: Date.now(),
    nowCst: nowCstIso(),
    cacheDir: path.join(DATA_DIR, 'source-cache'),
    offline: true,
    dataDir: DATA_DIR,
    log,
  };
  try {
    const bannerResult = await runBannerPipeline(sourceCtx, SOURCE_ADAPTERS, feed);
    feed = bannerResult.feed;
    log('[banners] 离线合并 ' + bannerResult.pools.length + ' 个卡池；信源 ' +
      bannerResult.sourceStats.map(s => s.id + '=' + s.candidates).join(' '));
    if (bannerResult.warnings.length) {
      for (const w of bannerResult.warnings) log('[banners] WARN ' + w);
    }
  } catch (e: any) {
    log('[banners] 卡池引擎失败，保留原有卡池字段:', e?.message ?? e);
  }

  // 离线把远程图片地址映射回已提交到 public/img / docs/img 的本地文件。
  // image-cache.json 由抓取阶段的 localizeImages() 维护，键是原始 URL，值是 img/<sha1>.<ext>。
  const imageCache: Record<string, string> = readJson(path.join(DATA_DIR, 'image-cache.json')) || {};
  const localize = (url: string | null | undefined): string | null | undefined =>
    (url && imageCache[url]) ? imageCache[url] : url;
  for (const g of feed.data.games) {
    g.icon_url = localize(g.icon_url);
    g.preview_images = (g.preview_images ?? []).map((u: string) => localize(u) as string);
  }
  for (const m of feed.media.items) m.poster_url = localize(m.poster_url);
  for (const n of feed.news ?? []) {
    n.images = (n.images ?? []).map((u: string) => localize(u) as string);
    n.cover = localize(n.cover);
  }

  // CDN 三件套（q13）
  feed = applyCdn(feed);

  const rss = buildRss(feed.news ?? allItems, GAMES);
  const feedJson = JSON.stringify(feed, null, 2);
  for (const dir of [WEB_PUBLIC, BUILD_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feed.json'), feedJson);
    fs.writeFileSync(path.join(dir, 'feed.rss'), rss);
  }

  // 嵌入用静态 API（q11/q12）
  try {
    const apiBundle = buildApiBundle(feed);
    const apiDoc = path.resolve('plans/api-v1-embedding.md');
    for (const dir of [path.join(BUILD_ROOT, 'api', 'v1'), path.join(WEB_PUBLIC, 'api', 'v1')]) {
      writeApiBundle(dir, apiBundle);
      if (fs.existsSync(apiDoc)) fs.copyFileSync(apiDoc, path.join(path.dirname(dir), 'README.md'));
    }
    log('[api] 写出 ' + apiBundle.files.length + ' 个端点到 docs/api/v1');
  } catch (e: any) { log('[api] 生成失败:', e?.message ?? e); }

  log('完成：games=' + feed.data.games.length + ' news=' + feed.news.length + ' media=' + feed.media.items.length);
  for (const g of feed.data.games) {
    log('  ' + g.key + ' stage=' + g.stage + ' events=' + g.events.length + ' birthdays=' + g.birthdays.length + ' current=' + g.current_version);
  }
}

main().catch((e) => { console.error('[rebuild] 失败:', e); process.exitCode = 1; });
