// 二游资讯 · feed.json 类型定义
// 字段以 plans/publisher-tabs-contract.md（v3）为准；v3 新增字段一律可选，
// 以保证旧 feed（schema_version 2）仍可正常渲染。

/** 厂商（feed.publishers[]） */
export interface Publisher {
  key: string;
  name: string;
  /** 只用于标签小圆点 / 激活下划线，不改变整体琥珀主色 */
  color: string;
  order: number;
}

/** 当前活动 / 预约预热里程碑 */
export interface EventItem {
  id: string;
  title: string;
  category: 'event' | 'prelaunch';
  status: '进行中' | '即将开始' | '已结束' | '时间待定';
  /** ISO 8601 */
  start_at: string | null;
  /** ISO 8601 */
  end_at: string | null;
  /** 仅进行中 */
  days_remaining: number | null;
  note: string | null;
  url: string | null;
  source: 'curated' | 'official';
}

/** 角色生日状态：今天 / 未来 / 刚过 / 较远 */
export type BirthdayState = 'today' | 'upcoming' | 'recent' | 'far';

/** 角色生日 */
export interface BirthdayItem {
  character: string;
  /** 'MM-DD' */
  month_day: string;
  /** 下一次生日 00:00 +08:00 */
  next_at: string;
  days_until: number;
  /** 官方生日贺图动态 */
  url: string | null;
  source: 'curated' | 'official';
  // —— data-core 追加字段（可选，未到达时按 days_until 兜底）——
  /** 最近一次生日过去的天数，0=今天；未来生日为 null */
  days_since?: number | null;
  state?: BirthdayState;
}

export interface MediaItem {
  id: string;
  game_name: string;
  game_key?: string | null;
  category: string;
  category_label: string;
  title: string;
  description?: string | null;
  version?: string | null;
  bvid?: string | null;
  published_at: string;
  duration?: string | null;
  url: string;
  player_url: string;
  poster_url?: string | null;
  poster_url_fallback?: string | null;
  poster_url_local?: string | null;
  source?: {
    platform?: string;
    official_mid?: string;
    dynamic_url?: string;
  } | null;
}

export interface NewsItem {
  id: string;
  game_key?: string | null;
  game_name: string;
  published_at: string;
  url: string;
  source_mid?: string | null;
  source_name?: string | null;
  images?: string[];
  images_fallback?: string[];
  images_local?: string[];
  cover_fallback?: string | null;
  cover_local?: string | null;
  /** 图片本地化状态（external / localized 等，旧 feed 缺失时忽略） */
  image_status?: string | null;
  type?: 'video' | 'forward' | 'dynamic' | string;
  title: string;
  summary?: string | null;
  bvid?: string | null;
  cover?: string | null;
  duration?: string | null;
}

/** 限定卡池 / 祈愿期 */
export interface UpBanner {
  label: string;
  phase?: string | null;
  characters: string[];
  start_at?: string | null;
  end_at?: string | null;
  status?: '进行中' | '未开始' | '已结束' | string;
  days_remaining?: number | null;
  note?: string | null;
  source?: string;
  // —— 多信源卡池（可选，旧 feed 缺失时照常渲染）——
  pool_name?: string | null;
  pool_type?: string | null;
  pool_type_label?: string | null;
  confidence?: 'high' | 'low' | string;
  sources?: BannerSourceRef[];
}

/** 卡池信源引用（前端只需要展示 id / 名称 / 链接） */
export interface BannerSourceRef {
  id?: string;
  title?: string;
  name?: string;
  label?: string;
  url?: string | null;
  tier?: string;
  [key: string]: unknown;
}

export interface SourceRef {
  title: string;
  url: string;
  type?: string;
  claims?: unknown[];
  checked_at?: string;
}

export interface OfficialAccount {
  mid: string;
  name: string;
  url: string;
}

export interface DownloadInfo {
  available: boolean;
  label: string;
  url: string | null;
}

export interface ReleaseInfo {
  label: string;
  date: string | null;
  days_until?: number | null;
}

export type GameStage = 'live' | 'prelaunch';

/** data.games[i]：旧字段全部保留，v3 字段可选 */
export interface Game {
  key: string;
  game_name: string;
  icon_url?: string | null;
  icon_url_fallback?: string | null;
  icon_url_local?: string | null;
  preview_images_fallback?: string[];
  preview_images_local?: string[];

  // ——— 旧字段（v2）———
  current_version?: string | null;
  current_content?: string[];
  current_version_days?: number | null;
  next_version?: string | null;
  next_version_kind?: string | null;
  /** 由卡池排期推导的下个节点（版本未公布时的兜底） */
  next_node_at?: string | null;
  next_node_label?: string | null;
  next_node_kind?: 'pool_start' | 'pool_end' | null;
  next_node_source?: string | null;
  next_content?: string[];
  days_to_next_version?: number | null;
  preview_status?: string | null;
  preview_title?: string | null;
  preview_start_at?: string | null;
  preview_replay_url?: string | null;
  preview_images?: string[];
  up_banners?: UpBanner[];
  /** 协定卡池（异环「限定棋盘」）：与角色限定池分开，避免混排 */
  pact_banners?: UpBanner[];
  current_up_characters?: string[];
  sources?: SourceRef[];
  facts_checked_at?: string | null;

  // ——— v3 新增 ———
  publisher_key?: string;
  publisher_name?: string;
  publisher_color?: string;
  stage?: GameStage;
  official_account?: OfficialAccount | null;
  download?: DownloadInfo | null;
  release?: ReleaseInfo | null;
  events?: EventItem[];
  /** 没有数据必须是 []，前端整块隐藏 */
  birthdays?: BirthdayItem[];
}

export interface FeedUi {
  page?: {
    title?: string;
    subtitle?: string;
    max_width?: string;
    density?: string;
  };
  sections?: unknown[];
}

export interface Feed {
  schema_version?: number;
  generated_at: string;
  generated_at_utc?: string;
  publishers?: Publisher[];
  ui?: FeedUi;
  data: { games: Game[] };
  media?: {
    categories?: { id: string; label: string }[];
    items?: MediaItem[];
  };
  news?: NewsItem[];
}

/** 厂商视图模型（缺颜色 / 名称时由本地兜底补全） */
export interface PublisherView extends Publisher {
  name: string;
  color: string;
}
