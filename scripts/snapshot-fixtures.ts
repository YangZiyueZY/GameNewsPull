import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BiliClient } from '../apps/crawler/src/sources/bilibili/client.ts';
import { GAMES } from '../apps/crawler/config/games.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'data/fixtures');
const FIRST_SCREEN_MAX_BYTES = 300 * 1024;   // 首屏单文件 300KB 硬上限
const DEEP_MAX_BYTES = Math.floor(1.5 * 1024 * 1024); // 深度快照上限 1.5MB
const RETRIES = 1;            // 失败重试 1 次（共最多 2 次尝试）
const INTERVAL_MS = 800;      // 每次请求间隔（含翻页）800ms
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 读取 --pages N / --pages=N 等命令行参数 */
function argValue(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' + name) return argv[i + 1] ?? null;
    if (a.startsWith('--' + name + '=')) return a.slice(name.length + 3);
  }
  return null;
}

const parsedPages = Number(argValue('pages') ?? '1');
const PAGES = Number.isInteger(parsedPages) && parsedPages > 0 ? parsedPages : 1;
const ONLY_GAME = argValue('game');
const OUT_NAME = argValue('out');
const MAX_BYTES = PAGES > 1 ? DEEP_MAX_BYTES : FIRST_SCREEN_MAX_BYTES;
const GAMES_TO_SNAPSHOT = ONLY_GAME ? GAMES.filter((g) => g.key === ONLY_GAME) : GAMES;
if (!GAMES_TO_SNAPSHOT.length) {
  console.error('[fixtures] 未知游戏 key: ' + ONLY_GAME);
  process.exitCode = 1;
}

interface CroppedItem {
  id_str: string;
  type: string;
  modules?: {
    module_author?: unknown;
    module_dynamic?: unknown;
  };
  orig?: unknown;
}

/** 仅保留 items 所需字段，剔除作者头像/视频封面等大体积内容以控体积 */
function cropItem(raw: any): CroppedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id_str ?? raw.id ?? '');
  if (!id) return null;
  const m = raw.modules ?? {};
  const item: CroppedItem = {
    id_str: id,
    type: String(raw.type ?? ''),
  };
  if (m.module_author !== undefined) {
    item.modules = item.modules ?? {};
    item.modules.module_author = m.module_author;
  }
  if (m.module_dynamic !== undefined) {
    item.modules = item.modules ?? {};
    item.modules.module_dynamic = m.module_dynamic;
  }
  if (raw.orig !== undefined) item.orig = raw.orig;
  return item;
}

/** 逐条剔除最后一个 item，直到序列化体积低于上限（保头保顺序） */
function fitToLimit(payload: { captured_at: string; mid: string; items: CroppedItem[] }): string {
  let text = JSON.stringify(payload);
  while (Buffer.byteLength(text, 'utf8') > MAX_BYTES && payload.items.length > 0) {
    payload.items.pop();
    text = JSON.stringify(payload);
  }
  return text;
}

/** 单页请求，失败重试 1 次；offset 为空表示首屏 */
async function fetchFeedWithRetry(client: BiliClient, mid: string, offset: string, label: string) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await client.getDynamicFeed(mid, offset);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        console.warn('[fixtures] ' + label + ' 拉取失败，重试 ' + (attempt + 1) + '/' + RETRIES + ': ' + (err as Error).message);
        await sleep(INTERVAL_MS);
      }
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const client = new BiliClient();
  let firstRequest = true;

  for (const game of GAMES_TO_SNAPSHOT) {
    const seen = new Set<string>();
    const items: CroppedItem[] = [];
    let offset = '';
    let pagesFetched = 0;

    for (let p = 0; p < PAGES; p++) {
      if (!firstRequest) await sleep(INTERVAL_MS); // 每次请求间隔 800ms（含翻页与换游戏）
      firstRequest = false;
      const label = game.name + '(' + game.key + ') 第' + (p + 1) + '页';
      const feed = await fetchFeedWithRetry(client, game.mid, offset, label);
      pagesFetched++;
      for (const raw of feed.items as any[]) {
        const id = String(raw?.id_str ?? raw?.id ?? '');
        if (id && seen.has(id)) continue; // 翻页边界去重
        if (id) seen.add(id);
        const cropped = cropItem(raw);
        if (cropped) items.push(cropped);
      }
      if (!feed.hasMore || !feed.offset || feed.offset === offset) break;
      offset = feed.offset;
    }

    const payload = {
      captured_at: new Date().toISOString(),
      mid: game.mid,
      items,
    };
    const totalItems = items.length;
    const text = fitToLimit(payload);
    const dropped = totalItems - payload.items.length;
    const fileName = OUT_NAME ?? (PAGES > 1 ? game.key + '-banners.json' : game.key + '.json');
    const target = resolve(OUT_DIR, fileName);
    await writeFile(target, text, 'utf8');

    const size = Buffer.byteLength(text, 'utf8');
    console.log(
      '[fixtures] ' + fileName.padEnd(18) +
      ' mid=' + game.mid.padEnd(18) +
      ' pages=' + pagesFetched +
      ' items=' + String(payload.items.length).padStart(3) + ' (裁剪前 ' + totalItems + (dropped ? ', 丢弃 ' + dropped : '') + ')' +
      ' size=' + (size / 1024).toFixed(1) + 'KB -> ' + target
    );
    if (size >= MAX_BYTES) {
      console.warn('[fixtures] 警告：' + fileName + ' 体积 ' + (size / 1024).toFixed(1) + 'KB 已接近上限');
    }
  }
  console.log('[fixtures] 完成，共 ' + GAMES_TO_SNAPSHOT.length + ' 个文件 -> ' + OUT_DIR);
}

if (GAMES_TO_SNAPSHOT.length) {
  main().catch((err) => {
    console.error('[fixtures] 失败:', err);
    process.exitCode = 1;
  });
}
