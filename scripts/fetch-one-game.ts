// 单游戏补抓：给「刚纳入 / mid 刚确认」的游戏补库存，不必跑全量 crawl。
// 用法：npx tsx scripts/fetch-one-game.ts azurlane [页数]
import 'dotenv/config';
import path from 'node:path';
import { BiliClient } from '../apps/crawler/src/sources/bilibili/client.ts';
import { Store } from '../apps/crawler/src/store/json.ts';
import { normalizeDynamic } from '../apps/crawler/src/extract/normalize.ts';
import { nowCstIso } from '../apps/crawler/src/utils/datetime.ts';
import { GAMES } from '../apps/crawler/config/games.ts';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const key = process.argv[2] || '';
const maxPages = Number(process.argv[3] || 3);

async function main(): Promise<void> {
  const game: any = GAMES.find((g: any) => g.key === key);
  if (!game) throw new Error('未知游戏 key: ' + key + '（可选项：' + GAMES.map((g: any) => g.key).join(', ') + '）');
  if (!game.mid) throw new Error(game.name + ' 没有配置 B 站 mid');

  const client = new BiliClient();
  const store = new Store(DATA_DIR);
  let inserted = 0, fetched = 0, offset = '';

  for (let page = 0; page < maxPages; page++) {
    const feed = await client.getDynamicFeed(game.mid, offset);
    console.log('[fetch-one]', game.name, 'page', page, 'items', feed.items.length, 'hasMore', feed.hasMore);
    for (const raw of feed.items) {
      fetched++;
      const item = normalizeDynamic(raw, game);
      if (!item) continue;
      const ok = store.insertDynamic({
        id: item.id, game_key: game.key, mid: game.mid, type: item.type,
        published_at: item.published_at, raw: JSON.stringify(raw), url: item.url, fetched_at: nowCstIso(),
      });
      if (ok) inserted++;
    }
    if (!feed.hasMore || !feed.offset) break;
    offset = feed.offset;
    await new Promise((r) => setTimeout(r, 900));
  }

  try {
    const info = await client.getOfficialInfo(game.mid);
    if (info?.face) {
      store.setState('face:' + game.mid, String(info.face).replace(/^http:/, 'https:'));
      store.setState('face_ts:' + game.mid, String(Date.now()));
      console.log('[fetch-one] 官方号', info.name, 'verified=', info.verified, 'fans=', info.fans);
    }
  } catch (e: any) { console.log('[fetch-one] 头像获取失败（不影响数据）:', e.message); }

  store.flush();
  console.log('[fetch-one] fetched=' + fetched + ' inserted=' + inserted + ' store_count=' + store.count());
}

main().catch((e) => { console.error('[fetch-one] 失败:', e.message); process.exitCode = 1; });