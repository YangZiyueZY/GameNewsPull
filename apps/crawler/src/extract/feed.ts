import type { NewsItem } from './normalize.ts';
import { classifyMedia } from './normalize.ts';
import { GAMES } from '../../config/games.ts';
import type { GameConfig } from '../../config/games.ts';
import { buildBanners, parseBannerAnnouncements } from './banners.ts';
import type { BannerOutput } from './banners.ts';

// 卡池抽取已迁到 extract/banners.ts，这里保持既有 import 兼容
export { buildBanners } from './banners.ts';

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
const ACTIVITY_RE = /活动|关卡|合约|测试|联动|预售|周边|手办|音乐会|展览|问卷|兑换码|福利|签到|抽奖|直播预约|特别节目|千星|嘉年华|巡礼|预约|前瞻|节日|声优|访谈|短片|表情包/;

// 卡池/祈愿公告不是「版本上线」
const GACHA_STATEMENT_RE = /祈愿|卡池|寻访|跃迁|调频|招募|集录/;

// 话题标签里的版本号：#原神7.2版本# → 7.2（官方自己打的标签最权威）
const TOPIC_VERSION_RE = /#([^#\n]{1,24})#/g;
const VERSION_IN_TAG_RE = /(\d+\.\d+)\s*版本/;

interface TopicVersion { version: string; num: number; at: number; upcoming: boolean }

function collectTopicVersions(items: NewsItem[]): TopicVersion[] {
  const out: TopicVersion[] = [];
  for (const it of items) {
    const text = `${it.title}\n${it.summary}`;
    const at = new Date(it.published_at).getTime();
    const safeAt = Number.isFinite(at) ? at : 0;
    // 「前瞻/即将上线」类话题不算当前版本
    const upcoming = UPCOMING_RE.test(text) && !LIVE_RE.test(text);
    for (const tag of text.matchAll(TOPIC_VERSION_RE)) {
      const hit = tag[1].match(VERSION_IN_TAG_RE);
      if (!hit) continue;
      out.push({ version: hit[1], num: Number(hit[1]), at: safeAt, upcoming });
    }
  }
  return out.filter(t => Number.isFinite(t.num));
}

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
      // 祈愿/卡池公告里的「华黍由仪」「呀吼吼博物志」是卡池名，不是版本名
      if (!num && GACHA_STATEMENT_RE.test(m[0])) continue;
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

export type NextVersionKind = 'version' | 'phase' | null;

export interface VersionState {
  current: VersionCandidate | null;
  next: VersionCandidate | null;
  nextRelease: number | null;
  characters: string[];
  nextKind: NextVersionKind;
}

// 未来语境：这些词出现时，更强的 X.Y版本 才可能是「下个版本」
const FUTURE_CONTEXT_RE = /即将|将于|预计|更新后|敬请期待|后续版本|下个版本|新版本/;

/**
 * 在近 45 天、带未来语境的动态里找「下一个」X.Y 版本号：
 * 比当前更高，取其中**最小**的一个（不是取最大——「4.8版本更新后到5.0版本结束前」的下一版本是 4.8）。
 * 返回原始字符串以保留小数位（5.0 不能变成 5）。
 */
function findNextVersionMention(items: NewsItem[], curNum: number, now: number): string | null {
  if (!Number.isFinite(curNum)) return null;
  const cutoff = now - 45 * 86400000;
  let bestNum = Number.POSITIVE_INFINITY;
  let bestVersion: string | null = null;
  for (const item of items) {
    if (new Date(item.published_at).getTime() < cutoff) continue;
    const text = `${item.title}\n${item.summary}`;
    if (!FUTURE_CONTEXT_RE.test(text)) continue;
    for (const m of text.matchAll(/(\d+\.\d+)\s*版本/g)) {
      const version = Number(m[1]);
      if (!Number.isFinite(version) || version <= curNum) continue;
      if (version < bestNum) { bestNum = version; bestVersion = m[1]; }
    }
  }
  return bestVersion;
}

export function extractVersion(items: NewsItem[], gameKey?: string): VersionState {
  const now = Date.now();
  const statements = findReleaseStatements(items);
  const topics = collectTopicVersions(items);
  const officialBanners = parseBannerAnnouncements(items);

  const msOf = (iso: string | null): number | null => {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  const poolStarts = (version: string | null): number[] => officialBanners
    .filter(b => (!version || b.version === version) && b.start)
    .map(b => msOf(b.start))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  // ① 当前版本：话题标签 #原神7.2版本# 最权威，「前瞻/即将」不算当前版本
  const liveTopic = topics.filter(t => !t.upcoming).sort((a, b) => b.num - a.num || b.at - a.at)[0] ?? null;
  const upcomingTopic = liveTopic
    ? topics.filter(t => t.num > liveTopic.num).sort((a, b) => a.num - b.num || a.at - b.at)[0] ?? null
    : null;

  let current: VersionCandidate | null = null;
  let next: VersionCandidate | null = null;
  let nextRelease: number | null = null;
  let nextKind: NextVersionKind = null;

  if (liveTopic) {
    // 版本开始时间锚点：官方「X版本将于…上线」语句 → 卡池公告开池时间 → 话题首次出现
    const stmt = statements.filter(s => s.numeric && s.name === liveTopic.version).sort((a, b) => a.at - b.at)[0];
    const firstMention = topics
      .filter(t => t.version === liveTopic.version && !t.upcoming)
      .reduce((min, t) => Math.min(min, t.at), Number.POSITIVE_INFINITY);
    const poolStart = poolStarts(liveTopic.version)[0];
    current = {
      key: liveTopic.version,
      label: `${liveTopic.version}版本`,
      posts: [],
      live: 1,
      upcoming: 0,
      firstAt: stmt ? stmt.at : Math.min(poolStart ?? Number.POSITIVE_INFINITY, firstMention),
    };
  }

  if (!current) {
    // 没有话题标签时回退到「X版本将于…上线」语句
    const past = statements.filter(s => s.at <= now).sort((a, b) => Number(b.numeric) - Number(a.numeric) || b.at - a.at);
    if (past[0]) current = { key: past[0].name, label: past[0].label, posts: [], live: 1, upcoming: 0, firstAt: past[0].at };
  }

  const curNum = current ? Number(String(current.label).match(/(\d+\.\d+)/)?.[1] ?? NaN) : NaN;

  // ② 下个版本（高版本号）：话题标签 → 未来的「X版本将于…上线」语句 → 未来语境里更高的 X.Y版本
  if (upcomingTopic) {
    const stmt = statements
      .filter(s => s.numeric && s.name === upcomingTopic.version && s.at > now)
      .sort((a, b) => a.at - b.at)[0];
    const poolStart = poolStarts(upcomingTopic.version)[0];
    next = {
      key: upcomingTopic.version,
      label: `${upcomingTopic.version}版本`,
      posts: [],
      live: 0,
      upcoming: 1,
      firstAt: stmt?.at ?? poolStart ?? Number.POSITIVE_INFINITY,
    };
    nextRelease = stmt?.at ?? poolStart ?? null;
    nextKind = 'version';
  } else {
    const future = statements.filter(s => s.at > now).sort((a, b) => Number(b.numeric) - Number(a.numeric) || a.at - b.at);
    const guess = future.find(s => s.label !== current?.label) ?? null;
    if (guess) {
      next = { key: guess.name, label: guess.label, posts: [], live: 0, upcoming: 1, firstAt: guess.at };
      nextRelease = guess.at;
      nextKind = 'version';
    } else {
      const higher = findNextVersionMention(items, curNum, now);
      if (higher) {
        next = { key: higher, label: `${higher}版本`, posts: [], live: 0, upcoming: 1, firstAt: Number.POSITIVE_INFINITY };
        nextKind = 'version';
      }
    }
  }

  // ③ 没有更高版本时：退化为「未开始的卡池期次」（label 形如「7.2 第 2 期」）
  if (!next) {
    const banners: BannerOutput[] = gameKey ? buildBanners(gameKey, items) : [];
    const upcoming = banners
      .filter(b => b.status === '未开始' && b.start_at)
      .map(b => ({ banner: b, at: msOf(b.start_at) }))
      .filter((x): x is { banner: BannerOutput; at: number } => x.at !== null)
      .sort((a, b) => a.at - b.at)[0];
    if (upcoming) {
      const versionNum = current ? String(current.label).match(/(\d+\.\d+)/)?.[1] ?? null : null;
      next = {
        key: upcoming.banner.label,
        label: versionNum ? `${versionNum} ${upcoming.banner.label}` : upcoming.banner.label,
        posts: [],
        live: 0,
        upcoming: 1,
        firstAt: upcoming.at,
      };
      nextRelease = upcoming.at;
      nextKind = 'phase';
    }
  }

  // ④ 版本开始时间锚点：官方卡池公告的开池时间（仅当已判定是「版本」，避免把同版本上下半当成新版本）
  if (next && nextKind === 'version' && nextRelease === null) {
    const candidates = officialBanners
      .filter(b => b.start && (b.version === next!.key || (!b.version || Number(b.version) > curNum)))
      .map(b => msOf(b.start))
      .filter((ms): ms is number => ms !== null && ms > now - 86400000)
      .sort((a, b) => a - b);
    if (candidates.length) nextRelease = candidates[0];
  }

  // ⑤ 卡池角色：只取官方公告（进行中/即将开始的期次）。
  // 旧实现「从所有「」里挑含角色/祈愿字样的词」会把「星神★阿哈」「随机角色周边」当成角色，已移除。
  const activeBanners = officialBanners
    .filter(b => b.characters.length)
    .map(b => ({ banner: b, start: msOf(b.start) ?? Number.POSITIVE_INFINITY, end: msOf(b.end) }))
    .filter(x => x.end === null || x.end >= now)
    .sort((a, b) => a.start - b.start);
  const characters: string[] = activeBanners.length ? [...activeBanners[0].banner.characters] : [];

  return { current, next, nextRelease, characters, nextKind };
}

export function buildFeed(allItems: NewsItem[], gameConfigs: GameConfig[] = GAMES, icons: Record<string, string> = {}) {
  const generatedAt = new Date().toISOString();
  const games: any[] = [];
  const mediaItems: any[] = [];

  for (const game of gameConfigs) {
    const items = allItems.filter(i => i.game_key === game.key);
    const banners = buildBanners(game.key, items);
    const { current, next, nextRelease, characters, nextKind } = extractVersion(items, game.key);
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
      next_version_kind: nextKind,
      next_content: next ? next.posts.slice(0, 3).map(p => p.title) : [],
      days_to_next_version: nextStart ? Math.max(0, Math.ceil((nextStart - Date.now()) / 86400000)) : null,
      preview_status: preview ? '已发布' : '尚未发布',
      preview_title: preview?.title || null,
      preview_start_at: preview?.published_at || null,
      preview_replay_url: preview?.url || null,
      preview_images: preview?.cover ? [preview.cover] : [],
      up_banners: banners,
      current_up_characters: (banners.find(b => b.status === '进行中')?.characters ?? banners[0]?.characters ?? characters),
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