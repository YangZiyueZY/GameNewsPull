import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { BiliClient } from './sources/bilibili/client.ts';
import { Store } from './store/json.ts';
import { normalizeDynamic, type NewsItem } from './extract/normalize.ts';
import { isOpusOnlyItem, readDynamicPubTime } from './extract/opus.ts';
import { buildFeed, buildRss } from './extract/feed.ts';
import { learnBirthdays, mergeBirthdayBook } from './extract/calendar.ts';
import type { BirthdayBook } from './extract/calendar.ts';
import { localizeImages } from './utils/media.ts';
import { GAMES } from '../config/games.ts';
import type { GameConfig } from '../config/games.ts';

// DATA_DIR 可能被 CI 指定为别的路径，健康状态与抓取缓存都写在 DATA_DIR 下
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const WEB_PUBLIC = path.resolve('apps/web/public');
const BUILD_ROOT = path.resolve('docs');
const RUN_ONCE = process.argv.includes('--once');

// 增量翻页参数：从 page 0 开始，命中「整页已入库」/ 超过页数 / 超出时间窗即停。
// 不再使用持久化 offset 游标（offset:<mid>:<page>），避免跨运行复用陈旧游标导致漏抓。
// 注意：不做「非首屏页命中已入库 id 即停」——卡池公告可能落在第 3~4 页，
// 提前停止会让「星穹铁道」这类发帖频繁的账号漏掉卡池信息。
const MAX_PAGES = 8;
const MAX_AGE_DAYS = 45;
const PARSE_FAIL_RATE_LIMIT = 0.05;        // 解析失败率警戒线 5%（仅告警）
const FIRST_SCREEN_COVERAGE_LIMIT = 1;    // 首屏覆盖率警戒线 100%（仅告警）
// 结构性回归阈值：超过则判为抓取逻辑失效，CI 直接红灯
const PARSE_FAIL_RATE_FATAL = 0.20;
const FIRST_SCREEN_COVERAGE_FATAL = 0.90;

const client = new BiliClient();
const store = new Store(DATA_DIR);

function log(...args: any[]) { console.log('[crawler]', new Date().toISOString(), ...args); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface CrawlStats {
  mid: string;
  pages: number;
  fetched: number;
  parsed: number;
  inserted: number;
  opusOnly: number;          // desc.text 为空但 opus 有内容的条数
  opusParsed: number;        // 其中成功解析的条数
  firstScreenTotal: number;
  firstScreenInStore: number;
}

interface HealthReport {
  status: 'ok' | 'degraded' | 'stale';
  checked_at: string;
  stale_since: string | null;
  reason: string | null;
  games: Array<{
    name: string; mid: string; pages: number; fetched: number; parsed: number;
    inserted: number; coverage: number; opus: string;
  }>;
  failed_games: string[];
  endpoint_check: Record<string, boolean>;
  store_count: number;
  feed_generated_at?: string | null;
}

function parseFailRate(stats: CrawlStats): number {
  return stats.fetched > 0 ? (stats.fetched - stats.parsed) / stats.fetched : 0;
}

function firstScreenCoverage(stats: CrawlStats): number {
  return stats.firstScreenTotal > 0 ? stats.firstScreenInStore / stats.firstScreenTotal : 1;
}

function readJsonFile(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const BIRTHDAY_FILE = path.join(DATA_DIR, 'birthdays.json');

/** 读取跨运行累积的生日簿（data/birthdays.json → { generated_at, games: { key: [...] } }） */
function readBirthdayBook(): BirthdayBook {
  const raw = readJsonFile(BIRTHDAY_FILE);
  const games = raw?.games;
  return games && typeof games === 'object' ? games as BirthdayBook : {};
}

function writeBirthdayBook(book: BirthdayBook): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BIRTHDAY_FILE, JSON.stringify({
      generated_at: new Date().toISOString(),
      games: book,
    }, null, 2));
  } catch (e: any) {
    log('写入 birthdays.json 失败:', e.message);
  }
}

function writeHealth(health: HealthReport): void {
  const file = path.join(DATA_DIR, 'health.json');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(health, null, 2));
  } catch (e: any) {
    log('写入 health.json 失败:', e.message);
  }
}

/** 上一次成功产出的 feed 时间（用于 stale_since） */
function lastFeedGeneratedAt(): string | null {
  const fromDocs = readJsonFile(path.join(BUILD_ROOT, 'feed.json'));
  if (fromDocs?.generated_at) return fromDocs.generated_at;
  const fromPublic = readJsonFile(path.join(WEB_PUBLIC, 'feed.json'));
  return fromPublic?.generated_at ?? null;
}

async function crawlGame(game: GameConfig): Promise<CrawlStats> {
  const stats: CrawlStats = {
    mid: game.mid, pages: 0, fetched: 0, parsed: 0, inserted: 0,
    opusOnly: 0, opusParsed: 0, firstScreenTotal: 0, firstScreenInStore: 0,
  };
  // 已在库 id 快照：用于首屏覆盖率统计与去重（不再作为提前停止条件）
  const knownIds = new Set(store.getDynamics(game.key, 5000).map(row => row.id));
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  // 首轮深度回填：老库第 1 页往往已全部入库，若据此早停，落在第 3~4 页的卡池公告永远抓不到。
  // 因此每个账号只做一次性深度回填（受 8 页 / 45 天约束），完成后写 backfill:<mid> 状态，此后按增量早停。
  const backfillKey = `backfill:${game.mid}`;
  const backfillDone = !!store.getState(backfillKey);
  if (!backfillDone) log(`[crawl] game=${game.name} 首次深度回填（最多 ${MAX_PAGES} 页 / ${MAX_AGE_DAYS} 天）`);
  let offset = '';
  let stopReason = '';
  let pages = 0;

  while (pages < MAX_PAGES) {
    const feed = await client.getDynamicFeed(game.mid, offset);
    pages++;
    stats.pages = pages;
    if (pages === 1) stats.firstScreenTotal = feed.items.length;

    let pageAllKnown = feed.items.length > 0;
    let oldest = Number.POSITIVE_INFINITY;

    for (const raw of feed.items) {
      stats.fetched++;
      const id = String(raw.id_str || raw.id);
      const opusOnly = isOpusOnlyItem(raw);
      if (opusOnly) stats.opusOnly++;
      if (!knownIds.has(id)) pageAllKnown = false;

      const pubMs = readDynamicPubTime(raw);
      if (pubMs !== null) oldest = Math.min(oldest, pubMs);

      const item = normalizeDynamic(raw, game);
      if (!item) continue;
      stats.parsed++;
      if (pages === 1) stats.firstScreenInStore++;   // 首屏成功解析（可入库）条数
      if (opusOnly) stats.opusParsed++;

      const inserted = store.insertDynamic({
        id: item.id, game_key: game.key, mid: game.mid, type: item.type,
        published_at: item.published_at, raw: JSON.stringify(raw),
        url: item.url, fetched_at: new Date().toISOString(),
      });
      if (inserted) stats.inserted++;
      knownIds.add(id);   // 本轮已处理过的都算「已入库」，避免重复插入
    }

    if (!feed.items.length) { stopReason = '本页无数据'; break; }
    // 整页都已在库：增量模式（回填已完成）下说明已经翻到历史区间；
    // 回填模式下继续往下翻，直到 8 页 / 45 天 / 无更多分页。
    if (pageAllKnown && backfillDone) { stopReason = `第 ${pages} 页全部已入库`; break; }
    if (Number.isFinite(oldest) && oldest < cutoff) { stopReason = `已翻到 ${MAX_AGE_DAYS} 天前`; break; }
    if (!feed.hasMore || !feed.offset || feed.offset === offset) { stopReason = '没有更多分页'; break; }

    offset = feed.offset;
    await sleep(800);
  }
  if (!stopReason) stopReason = `达到最大页数 ${MAX_PAGES}`;

  // 正常结束（未抛错）且确实抓到数据 → 标记回填完成，之后按增量早停
  if (!backfillDone && stats.fetched > 0) store.setState(backfillKey, new Date().toISOString());

  const coverage = Math.round(firstScreenCoverage(stats) * 100);
  log(`[crawl] game=${game.name} mid=${game.mid} pages=${stats.pages} fetched=${stats.fetched} parsed=${stats.parsed} opus=${stats.opusParsed}/${stats.opusOnly} coverage=${coverage}% inserted=${stats.inserted} 停止原因=${stopReason}`);
  return stats;
}

async function resolveIcons(): Promise<Record<string, string>> {
  const icons: Record<string, string> = {};
  for (const game of GAMES) {
    try {
      const cached = store.getState(`face:${game.mid}`);
      const ts = Number(store.getState(`face_ts:${game.mid}`) || 0);
      if (cached && Date.now() - ts < 86_400_000) { icons[game.key] = cached; continue; }
      const info = await client.getOfficialInfo(game.mid);
      const face = info?.face?.replace(/^http:/, 'https:');
      if (face) {
        store.setState(`face:${game.mid}`, face);
        store.setState(`face_ts:${game.mid}`, String(Date.now()));
        icons[game.key] = face;
      } else if (cached) icons[game.key] = cached;
    } catch (e: any) {
      log(`获取 ${game.name} 头像失败:`, e.message);
      const cached = store.getState(`face:${game.mid}`);
      if (cached) icons[game.key] = cached;
    }
    await sleep(400);
  }
  return icons;
}

async function runOnce() {
  log('开始抓取...');
  let added = 0;
  const statsList: CrawlStats[] = [];
  const failures: string[] = [];   // 结构性失败：CI 红灯
  const warnings: string[] = [];   // 轻度异常：仅告警
  const failedGames: string[] = [];
  const endpointCheck: Record<string, boolean> = {};

  for (const game of GAMES) {
    try {
      const stats = await crawlGame(game);
      statsList.push(stats);
      added += stats.inserted;

      const failRate = parseFailRate(stats);
      if (failRate > PARSE_FAIL_RATE_LIMIT) {
        const msg = `${game.name} 解析失败率 ${(failRate * 100).toFixed(1)}% 超过 ${PARSE_FAIL_RATE_LIMIT * 100}%（fetched=${stats.fetched} parsed=${stats.parsed}）`;
        if (failRate >= PARSE_FAIL_RATE_FATAL) { console.error(`[crawler] ERROR ${msg}`); failures.push(msg); }
        else { console.warn(`[crawler] WARN ${msg}`); warnings.push(msg); }
      }
      const coverage = firstScreenCoverage(stats);
      if (coverage < FIRST_SCREEN_COVERAGE_LIMIT) {
        const msg = `${game.name} 首屏覆盖率 ${(coverage * 100).toFixed(0)}% < 100%（${stats.firstScreenInStore}/${stats.firstScreenTotal} 条成功解析）`;
        if (coverage < FIRST_SCREEN_COVERAGE_FATAL) { console.error(`[crawler] ERROR ${msg}`); failures.push(msg); }
        else { console.warn(`[crawler] WARN ${msg}`); warnings.push(msg); }
      }
    } catch (e: any) {
      const msg = `${game.name} 抓取失败: ${e.message}`;
      console.error(`[crawler] ERROR ${msg}`);
      // 单游戏失败不阻断整条管线（其余游戏数据仍可发布），记 degraded + WARN；
      // 只有全部游戏失败才在下方 stale 分支红灯并保留旧 feed。
      warnings.push(msg);
      failedGames.push(game.name);
      // 端点级健康检查：投稿接口可达说明账号/网络正常，只是动态接口不可用
      try {
        const videos = await client.getSpaceVideos(game.mid, 5);
        endpointCheck[game.name] = videos.length > 0;
      } catch { endpointCheck[game.name] = false; }
      log(`${game.name} 端点健康检查（投稿接口）: ${endpointCheck[game.name] ? '可达' : '不可达'}`);
    }
    await sleep(1000 + Math.random() * 1500);
  }

  const totalFetched = statsList.reduce((n, s) => n + s.fetched, 0);
  const totalParsed = statsList.reduce((n, s) => n + s.parsed, 0);
  const totalOpus = statsList.reduce((n, s) => n + s.opusOnly, 0);
  const totalOpusParsed = statsList.reduce((n, s) => n + s.opusParsed, 0);
  log(`[crawl] 汇总 games=${statsList.length} fetched=${totalFetched} parsed=${totalParsed} opus=${totalOpusParsed}/${totalOpus} inserted=${added}`);

  const previousHealth = readJsonFile(path.join(DATA_DIR, 'health.json'));
  const gamesHealth = statsList.map(s => {
    const game = GAMES.find(g => g.mid === s.mid);
    return {
      name: game?.name ?? s.mid,
      mid: s.mid,
      pages: s.pages,
      fetched: s.fetched,
      parsed: s.parsed,
      inserted: s.inserted,
      coverage: Math.round(firstScreenCoverage(s) * 100),
      opus: `${s.opusParsed}/${s.opusOnly}`,
    };
  });

  // —— 全部游戏都没抓到：不覆盖 feed，保留上一次数据，写 health 并红灯 ——
  if (!statsList.length || totalFetched === 0) {
    const staleSince = previousHealth?.stale_since ?? previousHealth?.checked_at ?? lastFeedGeneratedAt() ?? new Date().toISOString();
    writeHealth({
      status: 'stale',
      checked_at: new Date().toISOString(),
      stale_since: staleSince,
      reason: failures.length ? failures.join('；') : '全部游戏抓取失败（fetched=0）',
      games: gamesHealth,
      failed_games: failedGames.length ? failedGames : GAMES.map(g => g.name),
      endpoint_check: endpointCheck,
      store_count: store.count(),
    });
    console.error('[crawler] ERROR 全部游戏抓取失败，保留上一次 feed.json/feed.rss 不覆盖（避免空数据顶掉线上），health.json 已记录 stale');
    store.flush();
    process.exitCode = 1;
    return;
  }

  const allItems: NewsItem[] = store.getAllDynamics(5000)
    .map(row => {
      try {
        const raw = JSON.parse(row.raw);
        const game = GAMES.find(g => g.key === row.game_key) || GAMES.find(g => g.mid === row.mid);
        return game ? normalizeDynamic(raw, game) : null;
      } catch (e: any) {
        // 单条数据损坏不能拖垮整站输出
        console.warn('[crawler] WARN 跳过无法解析的库存条目', row.id, e.message);
        return null;
      }
    })
    .filter((item): item is NewsItem => !!item);

  // 生日跨运行累积：先读旧簿，再用本次动态学习（只保留有官方根据的角色）
  const previousBirthdays = readBirthdayBook();
  const learnedBirthdays: BirthdayBook = {};
  for (const game of GAMES) {
    try {
      const records = learnBirthdays(game, allItems.filter(i => i.game_key === game.key));
      if (records.length) learnedBirthdays[game.key] = records;
    } catch (e: any) {
      log(`生日学习失败（${game.name}，不影响其他游戏）:`, e.message);
    }
  }
  const birthdays = mergeBirthdayBook(previousBirthdays, learnedBirthdays);
  writeBirthdayBook(birthdays);
  log(`生日簿：${Object.entries(birthdays).map(([k, v]) => k + '=' + v.length).join(' ') || '（暂无）'}`);

  const icons = await resolveIcons();
  let feed = buildFeed(allItems, GAMES, icons, { birthdays });
  const rss = buildRss(allItems);

  // 图片本地化：静态站没有服务端代理
  const cache: Record<string, string> = {};
  try {
    const cachedRaw = fs.existsSync(path.join(DATA_DIR, 'image-cache.json'))
      ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'image-cache.json'), 'utf8')) : {};
    const result = await localizeImages(feed, cachedRaw);
    feed = result.feed;
    fs.writeFileSync(path.join(DATA_DIR, 'image-cache.json'), JSON.stringify(result.cache));
  } catch (e: any) { log('图片本地化失败，保留原始链接:', e.message); }

  // 输出：源 public（供 dev）、docs（供 Pages 直接托管）
  const feedJson = JSON.stringify(feed, null, 2);
  for (const dir of [WEB_PUBLIC, BUILD_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feed.json'), feedJson);
    fs.writeFileSync(path.join(dir, 'feed.rss'), rss);
  }
  store.flush();
  log(`完成：库存 ${store.count()} 条，本次新增 ${added} 条`);

  writeHealth({
    status: failedGames.length ? 'degraded' : 'ok',
    checked_at: new Date().toISOString(),
    stale_since: null,
    reason: failedGames.length ? `部分游戏抓取失败：${failedGames.join('、')}` : null,
    games: gamesHealth,
    failed_games: failedGames,
    endpoint_check: endpointCheck,
    store_count: store.count(),
    feed_generated_at: feed.generated_at ?? null,
  });
  if (failedGames.length) {
    console.warn(`[crawler] WARN 部分游戏抓取失败（${failedGames.join('、')}），已用其余游戏数据输出，health.json 记为 degraded`);
  }

  if (warnings.length) {
    console.warn(`[crawler] WARN 数据质量告警 ${warnings.length} 项（已输出本次数据，建议排查）`);
  }
  // 结构性回归（解析失败率 ≥20% / 首屏覆盖率 <90% / 抓取异常）才让 CI 红灯，
  // 避免个别新动态类型导致整条数据管线停摆；输出已在上方写盘。
  if (failures.length && (RUN_ONCE || process.env.CI)) {
    console.error(`[crawler] ERROR 结构性校验未通过（${failures.length} 项），process.exitCode=1`);
    process.exitCode = 1;
  }
}

async function main() {
  log('初始化：核验官方账号...');
  for (const game of GAMES) {
    try {
      const info = await client.verifyOfficial(game.mid);
      const ok = info.verified && (info.name.includes(game.name.slice(0, 2)) || info.desc.includes(game.name.slice(0, 2)));
      log(`${game.name} mid=${game.mid}: ${info.name} | 蓝V=${info.verified} → ${ok ? '✓' : '⚠ 需人工复核'}`);
    } catch (e: any) { log(`${game.name} 校验失败:`, e.message); }
    await sleep(400);
  }

  if (RUN_ONCE || process.env.CI) {
    await runOnce();
    store.close();
    return;
  }

  const INTERVAL = Number(process.env.CRAWL_INTERVAL_MS || 1_800_000);
  if (process.env.CRAWL_ON_START !== 'false') await runOnce();
  log(`定时任务已启动，间隔 ${INTERVAL / 60000} 分钟`);
  const timer = setInterval(() => runOnce().catch(e => log('定时抓取异常:', e)), INTERVAL);
  process.on('SIGINT', () => { clearInterval(timer); store.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); store.close(); process.exit(0); });
}

main().catch(e => { console.error(e); store.close(); process.exit(1); });
