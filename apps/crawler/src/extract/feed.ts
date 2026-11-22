import type { NewsItem } from './normalize.ts';
import { classifyMedia } from './normalize.ts';
import { GAMES } from '../../config/games.ts';
import type { GameConfig } from '../../config/games.ts';
import { BANNERS } from '../../config/banners.ts';
import type { BannerPeriod } from '../../config/banners.ts';

const MEDIA_CATS: Record<string, string> = {
  version_pv: '版本 PV',
  character_pv: '角色 PV',
  preview_program: '版本前瞻',
  short_film: '动画短片',
  promotional_pv: '宣传影像',
};

const NOISE_RE = /抽奖|中奖|恭喜@|已私信|开奖|兑换码|转发抽/;
const UPCOMING_RE = /即将|将于|预约|前瞻|揭幕|敬请期待|上线预告|开启预告/;
const LIVE_RE = /现已|已开启|已上线|更新说明|更新公告|正式上线|版本内容说明|维护更新/;

interface VersionCandidate { key: string; label: string; posts: NewsItem[]; live: number; upcoming: number; firstAt: number }

export function collectVersions(items: NewsItem[]): VersionCandidate[] {
  const map = new Map<string, VersionCandidate>();
  for (const it of items) {
    const text = `${it.title}\n${it.summary}`;
    const found = new Set<string>();
    for (const m of text.matchAll(/(\d+(?:\.\d+)+)\s*版本\s*[「『]([^」』]{1,30})[」』]/g)) {
      found.add(`${m[1]}版本「${m[2]}」|${m[2]}`);
    }
    for (const m of text.matchAll(/[「『]([^」』]{3,24})[」』]\s*版本(?:PV|更新|前瞻)?/g)) {
      if (!/^\d/.test(m[1])) found.add(`「${m[1]}」版本|${m[1]}`);
    }
    for (const key of found) {
      const label = key.split('|')[0];
      const name = key.split('|')[1];
      let c = map.get(name);
      if (!c) { c = { key: name, label, posts: [], live: 0, upcoming: 0, firstAt: Number.POSITIVE_INFINITY }; map.set(name, c); }
      c.label = label;
      c.posts.push(it);
      if (LIVE_RE.test(text)) c.live++;
      if (UPCOMING_RE.test(text)) c.upcoming++;
      c.firstAt = Math.min(c.firstAt, new Date(it.published_at).getTime());
    }
  }
  return [...map.values()];
}

interface ReleaseStatement { name: string; label: string; at: number; numeric: boolean }

// 从「「X」版本将于 M月D日上线」这类句子直接解析版本与上线时间
const ACTIVITY_RE = /活动|关卡|合约|测试|联动|预售|周边|手办|音乐会|展览|问卷|兑换码|福利|签到|抽奖|直播预约/;

export function findReleaseStatements(items: NewsItem[]): ReleaseStatement[] {
  const versionNum = new Map<string, string>();
  for (const it of items) {
    const text = `${it.title}\n${it.summary}`;
    for (const m of text.matchAll(/(\d+\.\d+)\s*版本[^。\n]{0,10}?[「『]([^」』]{2,30})[」』]/g)) versionNum.set(m[2], m[1]);
    for (const m of text.matchAll(/[「『]([^」』]{2,30})[」』][^。\n]{0,6}?(\d+\.\d+)\s*版本/g)) if (!versionNum.has(m[1])) versionNum.set(m[1], m[2]);
  }

  const out: ReleaseStatement[] = [];
  const seen = new Set<string>();
  const RE = /[「『]([^」』]{2,30})[」』][^。\n]{0,24}?((?:\d{4}年)?\d{1,2}月\d{1,2}日)[^。\n]{0,18}?(正式上线|正式开启|上线|开启|更新|登场)/g;

  for (const it of items) {
    const text = `${it.title}\n${it.summary}`;
    for (const m of text.matchAll(RE)) {
      const name = m[1];
      const num = versionNum.get(name);
      if (!num && ACTIVITY_RE.test(name)) continue;      // 活动/联动类不算版本
      const ym = m[2].match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
      if (!ym) continue;
      let year = ym[1] ? +ym[1] : new Date().getFullYear();
      let d = new Date(year, +ym[2] - 1, +ym[3], 12, 0, 0);
      if (!ym[1]) {
        const nowMs = Date.now();
        if (d.getTime() - nowMs > 200 * 86400000) d = new Date(year - 1, +ym[2] - 1, +ym[3], 12, 0, 0);
        else if (nowMs - d.getTime() > 200 * 86400000) d = new Date(year + 1, +ym[2] - 1, +ym[3], 12, 0, 0);
      }
      const label = num ? `${num}版本「${name}」` : `「${name}」版本`;
      const key = `${label}|${d.toISOString().slice(0, 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: num ?? name, label, at: d.getTime(), numeric: !!num });
    }
  }
  return out;
}

export function extractVersion(items: NewsItem[]) {
  const statements = findReleaseStatements(items);
  const now = Date.now();
  const past = statements.filter(s => s.at <= now).sort((a, b) => Number(b.numeric) - Number(a.numeric) || b.at - a.at);
  const future = statements.filter(s => s.at > now).sort((a, b) => Number(b.numeric) - Number(a.numeric) || a.at - b.at);

  if (past.length || future.length) {
    const cur = past[0] || null;
    let nxt = future.find(f => f.label !== cur?.label) || null;
    // 没有带日期的下版本时，退而求其次：找「X.Y版本」+ 即将/将于 的提及
    if (!nxt) {
      const curNum = cur ? Number(cur.label.match(/^(\d+\.\d+)/)?.[1] ?? NaN) : NaN;
      const cutoff = Date.now() - 45 * 86400000;
      const recent = items.filter(i => new Date(i.published_at).getTime() >= cutoff);
      const all = recent.map(i => `${i.title}\n${i.summary}`).join('\n');
      let best = -1;
      for (const m of all.matchAll(/(\d+\.\d+)\s*版本[^。\n]{0,20}?(?:即将|将于|敬请期待)/g)) {
        const v = Number(m[1]);
        if (!Number.isFinite(curNum) || v <= curNum) continue;
        if (v > best) best = v;
      }
      for (const m of all.matchAll(/(?:即将|将于|预计)[^。\n]{0,24}?(\d+\.\d+)\s*版本/g)) {
        const v = Number(m[1]);
        if (!Number.isFinite(curNum) || v <= curNum) continue;
        if (v > best) best = v;
      }
      if (best > 0) nxt = { name: String(best), label: `${best}版本`, at: Number.POSITIVE_INFINITY, numeric: true } as any;
    }
    const chars2 = new Set<string>();
    for (const it of items) {
      for (const m of `${it.title}\n${it.summary}`.matchAll(/[「『]([^」』]{2,10})[」』]/g)) {
        const s = m[1];
        if (cur && s === cur.name) continue;
        if (nxt && s === nxt.name) continue;
        if (/角色|代理人|干员|共鸣者|旅人|限定|调频|寻访|祈愿|招募|返场/.test(s)) chars2.add(s);
      }
    }
    return {
      current: cur ? { key: cur.name, label: cur.label, posts: [], live: 1, upcoming: 0, firstAt: cur.at } : null,
      next: nxt ? { key: nxt.name, label: nxt.label, posts: [], live: 0, upcoming: 1, firstAt: nxt.at } : null,
      nextRelease: nxt && Number.isFinite(nxt.at) ? nxt.at : null,
      characters: [...chars2].slice(0, 6),
    };
  }

  const cands = collectVersions(items);
  // 当前版本：偏向「已上线」信号，其次帖子最多
  const byLive = [...cands].sort((a, b) => (b.live - a.live) || (b.posts.length - a.posts.length));
  const current = byLive[0] || null;
  // 下个版本：明显偏「即将」且不是当前版本
  const nextPool = cands.filter(c =>
    c.key !== current?.key &&
    c.upcoming > 0 &&
    c.live <= c.upcoming &&
    (!current || c.firstAt > current.firstAt)
  );
  const next = nextPool.sort((a, b) => (b.upcoming - b.live) - (a.upcoming - a.live) || a.firstAt - b.firstAt)[0] || null;

  const chars = new Set<string>();
  for (const it of items) {
    for (const m of `${it.title}\n${it.summary}`.matchAll(/[「『]([^」』]{2,10})[」』]/g)) {
      const s = m[1];
      if (current && s === current.key) continue;
      if (/角色|代理人|干员|共鸣者|旅人|干员|限定|调频|寻访|祈愿|招募|返场/.test(s)) chars.add(s);
    }
  }
  // 从「将于 11 月 25 日上线」这类文本里解析下个版本日期
  let nextRelease: number | null = null;
  if (next) {
    for (const p of next.posts) {
      const text = `${p.title}\n${p.summary}`;
      const m = text.match(/(?:将于|即将于|预计)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,12}(?:上线|开启|更新|登场)/);
      if (m) {
        const now = new Date();
        let y = now.getFullYear();
        let d = new Date(y, +m[1] - 1, +m[2], 12, 0, 0);
        if (d.getTime() < now.getTime() - 20 * 86400000) d = new Date(y + 1, +m[1] - 1, +m[2], 12, 0, 0);
        nextRelease = d.getTime();
        break;
      }
    }
  }
  return { current, next, nextRelease, characters: [...chars].slice(0, 6) };
}

export function buildBanners(gameKey: string, items: NewsItem[]) {
  const now = Date.now();
  const DAY = 86_400_000;
  const configured: BannerPeriod[] = BANNERS[gameKey] ?? [];

  const decorate = (p: BannerPeriod) => {
    const startAt = p.start ? new Date(p.start).getTime() : null;
    const endAt = p.end ? new Date(p.end).getTime() : null;
    let status: '进行中' | '未开始' | '已结束' = '进行中';
    if (startAt !== null && now < startAt) status = '未开始';
    else if (endAt !== null && now > endAt) status = '已结束';
    const daysRemaining = status === '进行中' && endAt !== null ? Math.max(0, Math.ceil((endAt - now) / DAY)) : null;
    return {
      label: p.label,
      phase: null,
      characters: p.characters,
      start_at: p.start,
      end_at: p.end,
      status,
      days_remaining: daysRemaining,
      note: p.note ?? null,
      source: 'config',
    };
  };

  if (configured.length) return configured.map(decorate);

  // 未配置时：从官方最近的卡池类动态里兜底抽取角色名
  const cutoff = now - 60 * DAY;
  const names = new Set<string>();
  for (const it of items) {
    if (new Date(it.published_at).getTime() < cutoff) continue;
    const text = `${it.title}\n${it.summary}`;
    if (!/祈愿|调频|寻访|跃迁|招募|卡池/.test(text)) continue;
    for (const m of text.matchAll(/限定(?:5星|S级|五星)?[^「]{0,6}[「『]([^」』]{2,18})[」』]/g)) {
      names.add(m[1].replace(/\([^)]*\)$/, ''));
    }
    for (const m of text.matchAll(/[「『]([^」』]{2,18})\([^)]{1,3}\)[」』]/g)) names.add(m[1]);
  }
  if (!names.size) return [];
  return [{
    label: '当前卡池',
    phase: null,
    characters: [...names].slice(0, 6),
    start_at: null,
    end_at: null,
    status: '进行中' as const,
    days_remaining: null,
    note: '时段官方未公布',
    source: 'bilibili_auto',
  }];
}

export function buildFeed(allItems: NewsItem[], gameConfigs: GameConfig[] = GAMES, icons: Record<string, string> = {}) {
  const generatedAt = new Date().toISOString();
  const games: any[] = [];
  const mediaItems: any[] = [];

  for (const game of gameConfigs) {
    const items = allItems.filter(i => i.game_key === game.key);
    const { current, next, nextRelease, characters } = extractVersion(items);
    const videos = items.filter(i => i.type === 'video');
    const contentItems = items.filter(i => !NOISE_RE.test(i.title) && !NOISE_RE.test(i.summary));
    const preview = videos.find(v => classifyMedia(v) === 'preview_program');
    const versionStart = current && Number.isFinite(current.firstAt) ? current.firstAt : null;
    const nextStart = nextRelease ?? null;

    games.push({
      game_name: game.name,
      key: game.key,
      icon_url: icons[game.key] || game.icon,
      current_version: current ? current.label : '暂未获取',
      current_content: contentItems.slice(0, 4).map(i => (i.title.replace(/^《[^》]+》/, '').trim() || i.title)),
      current_version_days: versionStart ? Math.max(0, Math.floor((Date.now() - versionStart) / 86400000)) : 0,
      next_version: next ? next.label : '暂未公布',
      next_content: next ? next.posts.slice(0, 3).map(p => p.title) : [],
      days_to_next_version: nextStart ? Math.max(0, Math.ceil((nextStart - Date.now()) / 86400000)) : null,
      preview_status: preview ? '已发布' : '尚未发布',
      preview_title: preview?.title || null,
      preview_start_at: preview?.published_at || null,
      preview_replay_url: preview?.url || null,
      preview_images: preview?.cover ? [preview.cover] : [],
      up_banners: buildBanners(game.key, items),
      current_up_characters: (buildBanners(game.key, items)[0]?.characters ?? characters),
      sources: items.slice(0, 6).map(i => ({ title: i.title, url: i.url, type: 'official_community', claims: [], checked_at: generatedAt })),
      facts_checked_at: generatedAt,
    });

    for (const v of videos) {
      const category = classifyMedia(v);
      if (!category) continue;
      mediaItems.push({
        id: `${game.key}:${v.bvid || v.id}`,
        game_name: game.name,
        game_key: game.key,
        category,
        category_label: MEDIA_CATS[category],
        title: v.title,
        description: v.summary,
        version: null,
        bvid: v.bvid,
        published_at: v.published_at,
        duration: v.duration || '',
        url: v.url,
        player_url: v.bvid ? `https://player.bilibili.com/player.html?bvid=${v.bvid}` : v.url,
        poster_url: v.cover || null,
        source: { platform: 'bilibili', official_mid: game.mid, dynamic_url: v.url },
      });
    }
  }

  mediaItems.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  return {
    schema_version: 2,
    generated_at: generatedAt,
    ui: {
      page: { title: '二游资讯', subtitle: '基于 B 站官方账号的资讯聚合', max_width: '7xl', density: 'compact' },
      sections: [{
        id: 'game-status',
        component: 'game_status_grid',
        source: 'data.games',
        title: '版本状态',
        props: {
          columns: { base: 1, md: 2, xl: 2 },
          show_preview: true, show_up: true, show_sources: true,
          embedded_media: {
            source: 'media.items', position: 'after_preview',
            categories: Object.keys(MEDIA_CATS), limit_per_game: 4,
            layout: 'featured_compact', show_category: true, show_duration: true,
            show_player: true, empty_behavior: 'hide',
          },
        },
      }],
      components: { media_card: { primary_action: { label: '在 Bilibili 观看' }, player_field: 'player_url' } },
    },
    data: { games },
    media: { categories: Object.entries(MEDIA_CATS).map(([id, label]) => ({ id, label })), items: mediaItems },
    news: allItems.filter(i => !NOISE_RE.test(i.title) && !NOISE_RE.test(i.summary)).slice(0, 500),
  };
}

export function buildRss(items: NewsItem[], gameConfigs: GameConfig[] = GAMES): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sorted = [...items].sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()).slice(0, 100);
  const itemsXml = sorted.map(i => `    <item>
      <title>${esc(`[${i.game_name}] ${i.title}`)}</title>
      <link>${esc(i.url)}</link>
      <guid isPermaLink="false">${esc(i.id)}</guid>
      <pubDate>${new Date(i.published_at).toUTCString()}</pubDate>
      <description>${esc(i.summary.slice(0, 300))}</description>
      <category>${esc(i.game_name)}</category>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>二游资讯 · B站官方动态</title>
    <link>http://localhost:5173/</link>
    <description>原神、绝区零、终末地、星穹铁道、异环官方 B 站资讯聚合</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`;
}
