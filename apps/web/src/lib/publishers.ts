import type { Feed, Game, PublisherView } from '../types';

/**
 * 厂商兜底表：仅在 feed 缺少 publishers[] / publisher_key（旧 feed）时使用。
 * 数据齐全时以 feed 为准。
 */
export const PUBLISHER_META: Record<string, { name: string; color: string; order: number }> = {
  mihoyo: { name: '米哈游', color: '#ffb454', order: 1 },
  hypergryph: { name: '鹰角网络', color: '#dfe6ee', order: 2 },
  kuro: { name: '库洛游戏', color: '#8fb8ff', order: 3 },
  yostar: { name: '悠星网络', color: '#86d4ff', order: 4 },
  manjuu: { name: '蛮啾网络', color: '#ffd479', order: 5 },
  happyelements: { name: '乐元素', color: '#ff9fc6', order: 6 },
  perfectworld: { name: '完美世界', color: '#a9a6ff', order: 7 },
  other: { name: '其他', color: '#a89e9f', order: 99 },
};

/** 契约 §3 的游戏 → 厂商映射（旧 feed 无 publisher_key 时兜底） */
export const GAME_PUBLISHER: Record<string, string> = {
  genshin: 'mihoyo',
  zzz: 'mihoyo',
  hsr: 'mihoyo',
  nexusanima: 'mihoyo',
  arknights: 'hypergryph',
  endfield: 'hypergryph',
  wutheringwaves: 'kuro',
  bluearchive: 'yostar',
  azurpromilia: 'manjuu',
  silverpalace: 'happyelements',
  yh: 'perfectworld',
};

export function publisherKeyOf(game: Game): string {
  return game.publisher_key || GAME_PUBLISHER[game.key] || 'other';
}

export function publisherOf(game: Game): PublisherView {
  const key = publisherKeyOf(game);
  const meta = PUBLISHER_META[key] || PUBLISHER_META.other;
  return {
    key,
    name: game.publisher_name || meta.name,
    color: game.publisher_color || meta.color,
    order: meta.order,
  };
}

/**
 * 厂商列表：优先 feed.publishers，缺失（或为空）时按 game.publisher_key 聚合。
 * 结果按 order 升序，名称 / 颜色缺失逐项兜底。
 */
export function buildPublishers(feed: Feed | null): PublisherView[] {
  const list = feed?.publishers;
  const out: PublisherView[] = [];
  if (Array.isArray(list) && list.length) {
    for (const p of list) {
      const meta = PUBLISHER_META[p.key] || PUBLISHER_META.other;
      out.push({
        key: p.key,
        name: p.name || meta.name,
        color: p.color || meta.color,
        order: typeof p.order === 'number' ? p.order : meta.order,
      });
    }
  } else {
    const seen = new Set<string>();
    for (const g of feed?.data?.games || []) {
      const key = publisherKeyOf(g);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(publisherOf(g));
    }
  }
  return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}
