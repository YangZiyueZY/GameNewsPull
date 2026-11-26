// 多信源卡池引擎的公共类型（契约文件，改动需同步 plans/multi-source-banner-contract.md）。
// 设计要点：
// 1) 每个信源产出 PoolCandidate（带 tier 与来源），resolvePools() 负责合并/校验/置信度；
// 2) 解析失败的字段一律 null，绝不猜测（决策 q3/q4）；
// 3) 输出保留旧 UpBanner 字段，新增字段全部可选，前端与旧消费方可平滑兼容。

/** 信源分级：L0 官方一手 > L1 官方数据挖掘 > L2 社区结构化 > L3 二手聚合 > L4 人工配置 */
export type SourceTier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export const TIER_RANK: Record<SourceTier, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export const TIER_LABEL: Record<SourceTier, string> = {
  L0: '官方一手',
  L1: '官方数据挖掘',
  L2: '社区结构化',
  L3: '二手聚合',
  L4: '人工配置',
};

/** 卡池类型（官方措辞归一化后的枚举） */
export type PoolType =
  | 'limited_character'   // 限定角色池（特许寻访 / 限定寻访 / 限定建造 / 弦定观测 / 活动唤取 / 限定招募）
  | 'rerun_character'     // 复刻 / 重构寻访 / 复刻招募 / 返场
  | 'standard_character'  // 常驻 / 轮换（明日方舟常驻标准寻访、常驻建造）
  | 'fes'                 // 庆典 / FES / 周年
  | 'pact'                // 协定卡池（异环「协定」系统；独立字段 pact_banners）
  | 'weapon'              // 武器池（申领 / 音擎调频 / 武器唤取 / 武器祈愿）
  | 'other';

export const POOL_TYPE_LABEL: Record<PoolType, string> = {
  limited_character: '限定角色',
  rerun_character: '复刻角色',
  standard_character: '常驻角色',
  fes: '庆典',
  pact: '协定',
  weapon: '武器',
  other: '其他',
};

/** 只进角色卡池（用于 current_up_characters 计算，武器池不进） */
export const CHARACTER_POOL_TYPES: PoolType[] = ['limited_character', 'rerun_character', 'standard_character', 'fes', 'pact'];

export interface SourceRef {
  /** 信源 id：hypergryph-cms / prts-smw / akasha / kurogane-site / bluearchive-cargo / azurlane-jp / azurlane-en / nteguide / bili-dynamics / config … */
  id: string;
  tier: SourceTier;
  url?: string | null;
  /** 抓取时刻（东八区 ISO） */
  fetched_at?: string;
}

export interface PoolCandidate {
  game_key: string;
  /** 官方池名，如「锻砧、行囊与蜜糖」「众水的颂诗」 */
  pool_name: string;
  pool_type: PoolType;
  /** UP 角色（已完成角色名校验前的候选值） */
  characters: string[];
  /** 起止时间（东八区 ISO，如 2026-11-25T06:00:00+08:00）；未知一律 null */
  start_at: string | null;
  end_at: string | null;
  /** 版本号，如 4.7 / 7.2 / 3.8 */
  version?: string | null;
  /** 期次标签，如「第 2 期」「上半」「4.7 第 1 期」 */
  period?: string | null;
  /** 解析原文证据（截断），便于回溯到公告 */
  evidence?: string | null;
  note?: string | null;
  source: SourceRef;
}

export interface ResolvedPool {
  /** 稳定 id：<game_key>:<hash(pool_name+start_at)>，用于 RSS/API 去重 */
  id: string;
  game_key: string;
  /** 期次/阶段标签（前端主标题，兼容旧 UpBanner.label） */
  label: string;
  pool_name: string | null;
  pool_type: PoolType;
  pool_type_label: string;
  characters: string[];
  start_at: string | null;
  end_at: string | null;
  version: string | null;
  status: '进行中' | '未开始' | '已结束' | '时间待定';
  days_remaining: number | null;
  confidence: 'high' | 'low';
  sources: SourceRef[];
  note: string | null;
  /** 兼容旧字段：主源 id */
  source: string;
}

export interface SourceContext {
  /** 统一「当前时间」（epoch ms），测试可注入 */
  now: number;
  /** 东八区 ISO 的当前时间 */
  nowCst: string;
  /** 信源原始数据缓存目录（data/source-cache） */
  cacheDir: string;
  /** true 时只读缓存，不发网络请求（离线重建 / 测试） */
  offline: boolean;
  /** 站点可写目录（用于落盘缓存） */
  dataDir: string;
  log: (...args: any[]) => void;
}

export interface SourceAdapter {
  id: string;
  tier: SourceTier;
  /** 中文名，用于日志与 health */
  label: string;
  /** 覆盖的 game_key；'*' 表示全部 */
  games: string[] | ['*'];
  /** 抓取并解析出候选池；失败返回 []（不得编造数据） */
  collect(ctx: SourceContext): Promise<PoolCandidate[]>;
  /** 该源能提供的角色名单（用于角色名校验），可选 */
  roster?(ctx: SourceContext): Promise<CharacterBookEntry[]>;
}

/** data/char-names.json 的单条角色记录 */
export interface CharacterBookEntry {
  game_key: string;
  cn: string;
  en?: string | null;
  jp?: string | null;
  aliases?: string[];
}

export interface CharacterBook {
  generated_at?: string;
  games: Record<string, Array<Omit<CharacterBookEntry, 'game_key'>>>;
}
