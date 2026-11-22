import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { BiliClient } from './sources/bilibili/client.ts';
import { Store } from './store/json.ts';
import { normalizeDynamic, type NewsItem } from './extract/normalize.ts';
import { buildFeed, buildRss } from './extract/feed.ts';
import { localizeImages } from './utils/media.ts';
import { GAMES } from '../config/games.ts';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const WEB_PUBLIC = path.resolve('apps/web/public');
const BUILD_ROOT = path.resolve('docs');
const RUN_ONCE = process.argv.includes('--once');

const client = new BiliClient();
const store = new Store(DATA_DIR);

function log(...args: any[]) { console.log('[crawler]', new Date().toISOString(), ...args); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function crawlGame(mid: string, gameKey: string): Promise<number> {
  let added = 0;
  // 无状态：只增量抓取首屏，靠 id 去重；不再依赖持久化 offset
  for (let page = 0; page < 3; page++) {
    const offset = page === 0 ? '' : store.getState(`offset:${mid}:${page}`) || '';
    const feed = await client.getDynamicFeed(mid, offset);
    for (const raw of feed.items) {
      const item = normalizeDynamic(raw, GAMES.find(g => g.mid === mid)!);
      if (!item) continue;
      if (store.insertDynamic({
        id: item.id, game_key: gameKey, mid, type: item.type,
        published_at: item.published_at, raw: JSON.stringify(raw),
        url: item.url, fetched_at: new Date().toISOString(),
      })) added++;
    }
    if (!feed.hasMore || !feed.offset || feed.offset === offset) break;
    store.setState(`offset:${mid}:${page + 1}`, feed.offset);
    await sleep(800);
  }
  return added;
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
  for (const game of GAMES) {
    try {
      const n = await crawlGame(game.mid, game.key);
      added += n;
      log(`${game.name} (mid=${game.mid}): 新增 ${n} 条`);
    } catch (e: any) { log(`${game.name} 抓取失败:`, e.message); }
    await sleep(1000 + Math.random() * 1500);
  }

  const allItems: NewsItem[] = store.getAllDynamics(2000).map(row => {
    const raw = JSON.parse(row.raw);
    const game = GAMES.find(g => g.key === row.game_key)!;
    return normalizeDynamic(raw, game)!;
  }).filter(Boolean);

  const icons = await resolveIcons();
  let feed = buildFeed(allItems, GAMES, icons);
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
