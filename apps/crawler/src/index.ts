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
import { applyCdn } from './utils/cdnize.ts';
import { buildApiBundle, writeApiBundle } from './extract/api.ts';
import { runBannerPipeline } from './pipeline/banners.ts';
import { SOURCE_ADAPTERS } from './sources/registry.ts';
import type { SourceContext } from './pools/types.ts';
import { nowCstIso } from './utils/datetime.ts';
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
// 碧蓝航线国服官号 mid 未确认（q8=B），只走日服/国际服 JSON，不参与 B 站抓取
const BILI_GAMES = GAMES.filter(g => g.bili !== false);

function log(...args: any[]) { console.log('[crawler]', nowCstIso(), ...args); }
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
  /** 与 checked_at 同一瞬间的 UTC 形式，供机器对齐 */
  checked_at_utc?: string | null;
  /** 卡池信源告警：解析失败 / 守卫丢弃 / 单源低置信 */
  banner_warnings?: string[];
  /** 每个信源贡献的候选池数量与健康状态 */
  banner_sources?: Array<{ id: string; candidates: number; ok: boolean; error?: string }>;
  /** 本轮角色字典自动扩写统计 */
  banner_dict?: { added: number; updated: number } | null;
  /** 仍缺少「下个节点」的 live 游戏（版本未公布且卡池排期也没推导出来） */
  next_node_missing?: string[];
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
      generated_at: nowCstIso(),
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
        url: item.url, fetched_at: nowCstIso(),
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
  if (!backfillDone && stats.fetched > 0) store.setState(backfillKey, nowCstIso());

  const coverage = Math.round(firstScreenCoverage(stats) * 100);
  log(`[crawl] game=${game.name} mid=${game.mid} pages=${stats.pages} fetched=${stats.fetched} parsed=${stats.parsed} opus=${stats.opusParsed}/${stats.opusOnly} coverage=${coverage}% inserted=${stats.inserted} 停止原因=${stopReason}`);
  return stats;
}

async function resolveIcons(): Promise<Record<string, string>> {
  const icons: Record<string, string> = {};
  for (const game of BILI_GAMES) {
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
  const bannerWarnings: string[] = [];
  let bannerSources: Array<{ id: string; candidates: number; ok: boolean; error?: string }> = [];
  let bannerDict: { added: number; updated: number } | null = null;
  const nextNodeMissing: string[] = [];

  for (const game of BILI_GAMES) {
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

  // —— B 站动态全部抓取失败 ——
  // 注意：B 站只是信源之一。只要库存还在，就用「库存 + 多信源（Akasha/鹰角 CMS/PRTS/库洛/…）」继续重建，
  // 否则一次 B 站风控就会让整站停更，与「多信源」的设计初衷相悖。
  const allCrawlFailed = !statsList.length || totalFetched === 0;
  let staleSinceValue: string | null = null;
  if (allCrawlFailed) {
    staleSinceValue = previousHealth?.stale_since ?? previousHealth?.checked_at ?? lastFeedGeneratedAt() ?? nowCstIso();
    if (store.count() === 0) {
      // 库存也为空：真的没有任何数据可发，保留旧 feed 并红灯
      writeHealth({
        status: 'stale',
        checked_at: nowCstIso(),
        checked_at_utc: new Date().toISOString(),
        stale_since: staleSinceValue,
        reason: failures.length ? failures.join('；') : '全部游戏抓取失败且库存为空',
        games: gamesHealth,
        failed_games: failedGames.length ? failedGames : GAMES.map(g => g.name),
        endpoint_check: endpointCheck,
        store_count: store.count(),
      });
      console.error('[crawler] ERROR 全部游戏抓取失败且库存为空，保留上一次 feed.json/feed.rss 不覆盖');
      store.flush();
      process.exitCode = 1;
      return;
    }
    console.warn('[crawler] WARN B 站动态全部抓取失败（fetched=0），改用「库存 + 多信源」重建，health 记为 stale 并红灯');
    bannerWarnings.push('B 站动态抓取失败，本次用库存 + 多信源重建');
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

  // ——— 多信源卡池（q1–q6）：适配器 → 合并校验 → 写回 up_banners ———
  const sourceCtx: SourceContext = {
    now: Date.now(),
    nowCst: nowCstIso(),
    cacheDir: path.join(DATA_DIR, 'source-cache'),
    offline: false,
    dataDir: DATA_DIR,
    log,
  };
  log(`[banners] 信源 ${SOURCE_ADAPTERS.length} 个: ${SOURCE_ADAPTERS.map((a) => a.id + '(' + a.tier + ')').join(', ')}`);
  try {
    const bannerResult = await runBannerPipeline(sourceCtx, SOURCE_ADAPTERS, feed);
    feed = bannerResult.feed;
    bannerWarnings.push(...bannerResult.warnings);
    bannerSources = bannerResult.sourceStats;
    bannerDict = { added: bannerResult.dictAdded, updated: bannerResult.dictUpdated };
    log(`[banners] 合并 ${bannerResult.pools.length} 个卡池，信源 ${bannerResult.sourceStats.map(s => s.id + '=' + s.candidates).join(' ')}`);
    log(`[banners] 角色字典：新增 ${bannerResult.dictAdded} 条、补齐 ${bannerResult.dictUpdated} 条`);

    // 下个节点覆盖自检：live 游戏既没有版本日期、也没从卡池排期推出节点 → 告警
    for (const g of (feed?.data?.games ?? []) as any[]) {
      if (g?.stage === 'prelaunch') continue;
      if (g?.next_node_at) continue;
      if (typeof g?.days_to_next_version === 'number') continue;
      const v = String(g?.next_version ?? '').trim();
      if (v && v !== '暂未公布' && v !== '待定档') continue;
      nextNodeMissing.push(String(g?.key ?? g?.game_name ?? '?'));
    }
    if (nextNodeMissing.length) {
      bannerWarnings.push('[节点告警] 以下游戏既无版本日期也无卡池排期，页面只能显示「暂未公布」: ' + nextNodeMissing.join('、'));
    }

    // 信源健康自检：与上一轮对比每个源的候选数，骤降/归零就告警（每日自动体检，无需人工盯）
    const prevSources = Array.isArray(previousHealth?.banner_sources) ? previousHealth.banner_sources : [];
    for (const cur of bannerResult.sourceStats) {
      const prev = prevSources.find((p: any) => p?.id === cur.id);
      if (!prev || typeof prev.candidates !== 'number') continue;
      if (prev.candidates > 0 && cur.candidates === 0) {
        bannerWarnings.push(`[信源告警] ${cur.id} 本轮 0 条（上轮 ${prev.candidates} 条），可能失效`);
      } else if (prev.candidates >= 5 && cur.candidates < prev.candidates * 0.3) {
        bannerWarnings.push(`[信源告警] ${cur.id} 候选骤降 ${prev.candidates} → ${cur.candidates}`);
      }
    }
  } catch (e: any) {
    // 卡池引擎整体失败不能拖垮站点：保留 feed 里原有的（config/公告）卡池，记告警
    bannerWarnings.push('卡池引擎失败: ' + (e?.message ?? e));
    log('卡池引擎失败，保留原有卡池字段:', e?.message ?? e);
  }

  // 图片本地化：静态站没有服务端代理（q13 配额：最新 N 条 × 每条 M 张）
  const cache: Record<string, string> = {};
  try {
    const cachedRaw = fs.existsSync(path.join(DATA_DIR, 'image-cache.json'))
      ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'image-cache.json'), 'utf8')) : {};
    const manifestFile = path.join(DATA_DIR, 'image-manifest.json');
    const prevManifest = fs.existsSync(manifestFile)
      ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
    const result = await localizeImages(feed, cachedRaw, { manifest: prevManifest });
    feed = result.feed;
    fs.writeFileSync(path.join(DATA_DIR, 'image-cache.json'), JSON.stringify(result.cache));
    fs.writeFileSync(manifestFile, JSON.stringify(result.manifest, null, 2));
    log(`[media] 本地化完成：下载 ${result.stats?.downloaded ?? '?'} 张，命中缓存 ${result.stats?.cached ?? '?'} 张`);
  } catch (e: any) { log('图片本地化失败，保留原始链接:', e.message); }

  // CDN 三件套（q13）：主字段 CDN、*_fallback GitHub Pages、*_local 站内相对路径
  feed = applyCdn(feed);

  // RSS 用 cdnize 之后的 news，才能带上图片与 CDN 地址
  const rss = buildRss(feed.news ?? allItems, GAMES);

  // 输出：源 public（供 dev）、docs（供 Pages 直接托管）
  const feedJson = JSON.stringify(feed, null, 2);
  for (const dir of [WEB_PUBLIC, BUILD_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feed.json'), feedJson);
    fs.writeFileSync(path.join(dir, 'feed.rss'), rss);
  }

  // 嵌入用静态 API（q11/q12）：docs/api/v1 为主，public/api/v1 供 dev
  try {
    const apiBundle = buildApiBundle(feed);
    // API 文档随产物写出（vite build 会清空 docs/，手写文件会丢）
    const apiDoc = path.resolve('plans/api-v1-embedding.md');
    for (const dir of [path.join(BUILD_ROOT, 'api', 'v1'), path.join(WEB_PUBLIC, 'api', 'v1')]) {
      const written = writeApiBundle(dir, apiBundle);
      if (fs.existsSync(apiDoc)) fs.copyFileSync(apiDoc, path.join(path.dirname(dir), 'README.md'));
      if (dir.startsWith(BUILD_ROOT)) log(`[api] 写出 ${written.length} 个端点到 docs/api/v1`);
    }
  } catch (e: any) { log('API 生成失败（不影响站点）:', e?.message ?? e); }
  store.flush();
  log(`完成：库存 ${store.count()} 条，本次新增 ${added} 条`);

  writeHealth({
    status: staleSinceValue ? 'stale' : failedGames.length ? 'degraded' : 'ok',
    checked_at: nowCstIso(),
    checked_at_utc: new Date().toISOString(),
    stale_since: staleSinceValue,
    reason: failedGames.length ? `部分游戏抓取失败：${failedGames.join('、')}` : null,
    games: gamesHealth,
    failed_games: failedGames,
    endpoint_check: endpointCheck,
    store_count: store.count(),
    feed_generated_at: feed.generated_at ?? null,
    banner_warnings: bannerWarnings.length ? bannerWarnings : undefined,
    banner_sources: bannerSources.length ? bannerSources : undefined,
    banner_dict: bannerDict,
    next_node_missing: nextNodeMissing.length ? nextNodeMissing : undefined,
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
  for (const game of BILI_GAMES) {
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
