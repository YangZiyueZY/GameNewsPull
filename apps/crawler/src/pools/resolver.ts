// 卡池合并 / 校验引擎（纯函数，不含网络）。
//
// 契约：plans/multi-source-banner-contract.md §3；类型：./types.ts。
// 为什么做成纯函数：抓取（网络 + 缓存）在 sources/ 各适配器里，合并规则必须能离线复现、单测覆盖；
// 时间只读 utils/datetime.ts（唯一时间源），这里不写任何时区数学。
//
// 合并口径（q3）：
// 1) 同键 = game_key + 归一化池名 + 起止（小时粒度）；config（L4）与无池名候选只作「时段骨架」，按时间归并；
// 2) 同键取 tier 最高源的角色与时间；角色多源取交集，交集为空则取最高 tier 源并降置信度；
// 3) 守卫不满足 → 整条候选丢弃并计入 warnings（不猜、不回填，q4）；
// 4) confidence：含 L0 或 ≥2 源完全一致 → high，否则 low；没有角色一律 low。

import type {
  CharacterBook,
  CharacterBookEntry,
  PoolCandidate,
  PoolType,
  ResolvedPool,
  SourceRef,
  SourceTier,
} from './types.ts';
import { CHARACTER_POOL_TYPES, POOL_TYPE_LABEL, TIER_RANK } from './types.ts';
import { buildRosterIndex, flattenCharBook, sanitizeCharacterNames } from './roster.ts';
import type { RosterIndex } from './roster.ts';
import { cstDayDiff, toCstIso } from '../utils/datetime.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** 卡池时长的合法区间（契约 §3）：短于 1 小时或长于 90 天基本可判定为解析错位 */
const MIN_DURATION_MS = HOUR_MS;
const MAX_DURATION_MS = 90 * DAY_MS;

/** UP 角色人数上限（契约 §3）；超出基本是公告噪声被当成了角色名 */
export const UP_LIMITS: Record<string, number> = {
  genshin: 2,
  hsr: 3,   // 星铁同期可有 3 名 UP（4.7 池1：银狼LV.999 / 火花 / 爻光）
  zzz: 2,
  endfield: 2,
  arknights: 2,
  bluearchive: 1,
  azurpromilia: 2,
  azurlane: 2,
  wutheringwaves: 2,
};

/** 未登记的游戏按 2 人（最常见档位）；宁可事后补表，也不让新游戏整池消失 */
export const DEFAULT_UP_LIMIT = 2;

const POOL_TYPES: PoolType[] = ['limited_character', 'rerun_character', 'standard_character', 'fes', 'pact', 'weapon', 'other'];
const SOURCE_TIERS: SourceTier[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface ResolveOptions {
  /** 统一「当前时间」（epoch ms）：离线重建 / 测试注入，保证 status 可复现 */
  now?: number;
  /** 角色字典：data/char-names.json 内容或条目数组；不传则只做归一化 + 噪声过滤 */
  roster?: CharacterBook | CharacterBookEntry[] | null;
  /** 已建好的索引（批量调用时复用） */
  index?: RosterIndex | null;
  /** index 的别名：pipeline 侧叫 rosterIndex，两种都收，避免上下游命名不一致 */
  rosterIndex?: RosterIndex | null;
  /** 收集守卫告警（会 push 进同一个数组，便于汇总到 health.banner_warnings） */
  warnings?: string[];
}

export interface ResolveResult {
  pools: ResolvedPool[];
  warnings: string[];
}

/** 池类型兜底：未知值一律 other，避免下游 POOL_TYPE_LABEL 取到 undefined */
export function normalizePoolType(value: unknown): PoolType {
  return POOL_TYPES.includes(value as PoolType) ? (value as PoolType) : 'other';
}

/** tier 兜底：缺失/非法按 L3（二手聚合）处理——绝不把未知来源当官方一手 */
export function normalizeTier(value: unknown): SourceTier {
  return SOURCE_TIERS.includes(value as SourceTier) ? (value as SourceTier) : 'L3';
}

/** 时间解析：失败返回 null（调用方记录告警，按待定处理，绝不猜） */
function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** 合并键的时间精度：1 小时（契约要求；各源公告常差几分钟，不按分钟硬切） */
function hourBucket(ms: number | null): string {
  return ms === null ? 'x' : String(Math.floor(ms / HOUR_MS));
}

/** 池名归一化（只用于合并键，不用于展示）：去空格/标点/大小写差异 */
export function poolNameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000·・:：;；,，。.、!！?？"\\/|()（）\[\]【】「」『』《》<>—–_~+]+/g, '');
}

/** FNV-1a 32bit → base36：够短、稳定、无外部依赖（id 只用于去重，不做安全用途） */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/** 稳定 id：<game_key>:<hash(pool_name + start_at)>（契约 §3，RSS/API 去重依赖它） */
export function stablePoolId(gameKey: string, poolName: string | null, startAt: string | null): string {
  return gameKey + ':' + shortHash([gameKey, poolName ?? '', startAt ?? ''].join('|'));
}

/** 多集合交集（保持首个集合的顺序） */
function intersectAll(sets: string[][]): string[] {
  if (!sets.length) return [];
  return sets.reduce((acc, cur) => acc.filter((name) => cur.includes(name)));
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((name) => b.includes(name));
}

function formatDuration(ms: number): string {
  const days = ms / DAY_MS;
  if (Math.abs(days) >= 2) return days.toFixed(1) + ' 天';
  const hours = ms / HOUR_MS;
  return hours.toFixed(1) + ' 小时';
}

// 角色字典覆盖下限：低于该值说明我们并没有该游戏的可靠名单，此时校验降级为「只过滤噪声」，
// 否则会把真实角色全部误杀（例如新上线的《蓝色星原》/《碧蓝航线》字典几乎为空）。
export const MIN_ROSTER_COVERAGE = Number(process.env.MIN_ROSTER_COVERAGE || 8);

interface Prepared {
  candidate: PoolCandidate;
  /** 该游戏字典覆盖不足，角色名未经名单校验（置信度需降级） */
  rosterWeak: boolean;
  tier: SourceTier;
  poolType: PoolType;
  poolName: string | null;
  characters: string[];
  startMs: number | null;
  endMs: number | null;
  /** 时段骨架：人工配置（L4）或没有池名——只按时间归并，不参与池名身份 */
  skeleton: boolean;
}

interface PoolGroup {
  key: string;
  members: Prepared[];
}

/**
 * 单条候选的清洗 + 守卫。返回 null 表示该候选被丢弃（原因已写入 warnings）。
 * 顺序很关键：先洗角色名（噪声串不能进人数统计），再判人数/时长。
 */
function prepareCandidate(candidate: PoolCandidate, index: RosterIndex | null, warnings: string[]): Prepared | null {
  if (!candidate) return null;
  const gameKey = String(candidate.game_key ?? '').trim();
  if (!gameKey) {
    warnings.push('[pools] 丢弃缺少 game_key 的候选: ' + String(candidate.pool_name ?? ''));
    return null;
  }
  const tier = normalizeTier(candidate.source?.tier);
  const poolType = normalizePoolType(candidate.pool_type);
  const rawName = candidate.pool_name == null ? '' : String(candidate.pool_name).trim();
  const poolName = rawName || null;
  const label = poolName ?? POOL_TYPE_LABEL[poolType];

  // ① 角色：武器池不列角色（契约 §3）；其余候选必须过字典 + 噪声守卫
  let characters: string[] = [];
  let rosterWeak = false;
  if (poolType === 'weapon') {
    characters = [];
  } else {
    const roster = index ? index.names.get(gameKey) : undefined;
    const coverage = roster?.size ?? 0;
    // 字典覆盖不足时把 index 置空：sanitize 会退化为「归一化 + 噪声过滤」，不误杀真实角色
    const weak = coverage < MIN_ROSTER_COVERAGE;
    // 官方一手/官方挖掘（L0/L1）从公告里点名道姓的角色，本身就是最权威来源：
    // 字典缺条目（新角色、新游）时不应把整池角色丢掉，只做噪声过滤即可；
    // L2/L3 社区源仍必须过名单校验（它们最容易把池名/活动名当角色）。
    const trustworthy = tier === 'L0' || tier === 'L1';
    const { valid, invalid } = sanitizeCharacterNames(candidate.characters ?? [], weak ? null : index, roster, gameKey);
    if (invalid.length) {
      if (trustworthy) {
        // 官方源点名道姓的角色：字典没收录也保留（只过噪声过滤），并记 info 便于人工补字典；
        // 否则新角色/新游会整池被丢掉（碧蓝航线的英文舰名、异环的 Exe 都踩过这个坑）。
        const extra = sanitizeCharacterNames(invalid, null, null, gameKey).valid
          .filter((name) => !valid.some((v) => v.toLowerCase() === name.toLowerCase()));
        if (extra.length) {
          valid.push(...extra);
          warnings.push('[' + gameKey + '] 「' + label + '」字典未收录（官方源，已保留）: ' + extra.join('、'));
        }
      } else {
        warnings.push('[' + gameKey + '] 「' + label + '」角色名未通过校验已丢弃: ' + invalid.join('、'));
      }
    }
    if (weak && (candidate.characters ?? []).length) {
      const note = '[' + gameKey + '] 角色字典覆盖不足(' + coverage + ' 条)，已跳过名单校验并降级置信度';
      if (!warnings.includes(note)) warnings.push(note);
    }
    characters = valid;
    rosterWeak = weak;
  }

  // ② UP 人数上限：超限视为解析异常，整条丢弃（截断会「猜」掉谁是真 UP）
  const limit = UP_LIMITS[gameKey] ?? DEFAULT_UP_LIMIT;
  if (characters.length > limit) {
    warnings.push('[' + gameKey + '] 丢弃候选「' + label + '」: UP 角色 ' + characters.length + ' 人超过上限 ' + limit);
    return null;
  }

  // ③ 时间：解析不到一律 null，不猜也不回填
  const startMs = parseMs(candidate.start_at);
  const endMs = parseMs(candidate.end_at);
  if (candidate.start_at && startMs === null) {
    warnings.push('[' + gameKey + '] 「' + label + '」开始时间无法解析，按待定处理: ' + candidate.start_at);
  }
  if (candidate.end_at && endMs === null) {
    warnings.push('[' + gameKey + '] 「' + label + '」结束时间无法解析，按待定处理: ' + candidate.end_at);
  }

  // ④ 时长 1 小时 – 90 天（起止都有才校验；只有单边时无法判断时长）
  if (startMs !== null && endMs !== null) {
    const duration = endMs - startMs;
    if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
      warnings.push('[' + gameKey + '] 丢弃候选「' + label + '」: 时长 ' + formatDuration(duration) + ' 不在 1 小时–90 天范围内');
      return null;
    }
  }

  return { candidate, rosterWeak, tier, poolType, poolName, characters, startMs, endMs, skeleton: tier === 'L4' || poolName === null };
}

/** 角色名归一化（合并判断用）：忽略空白与全角/半角分隔符 */
function charKeyOf(name: string): string {
  return String(name ?? '').replace(/[\s·•・\-—_]/g, '').toLowerCase();
}

/**
 * 两条候选是否同一期：
 * ① 同起止小时桶 + 池名互相包含（'限定寻访' vs '限定寻访·锻砧'）——最严格，用于同期双池；
 * ② 同结束时间桶 + 角色有交集 + 一方缺开始时间——B 站公告常把起点写成「版本更新后」，
 *    导致同一池在 Akasha（有绝对起点）与 B 站（起点为空）各出现一次，必须在合并期解决，
 *    否则页面上会出现「同一个角色两张卡」。
 */
function groupsCompatible(a: PoolGroup, b: PoolGroup): boolean {
  // 组内任意一对成员兼容即视为同一期。
  // 必要性：合并后成员顺序会变（后来并入的无时间候选可能排在首位），只看 members[0] 会漏判，
  // 典型是绝区零「上半」先被无时间候选错过、之后再也合并不上。
  const left = a.members.slice(0, 8);
  const right = b.members.slice(0, 8);
  for (const x of left) for (const y of right) if (membersCompatible(x, y)) return true;
  return false;
}

function membersCompatible(x: Prepared, y: Prepared): boolean {
  if (x.candidate.game_key !== y.candidate.game_key) return false;
  // ⓪ 池名完全相同 + 时间不冲突（一方缺字段就算不冲突）→ 同一期。
  //    典型：鸣潮官网公告只给池名不给时间，B 站公告给结束时间不给角色，两条必须并成一个池。
  // 「完全没有时间」的候选不参与同名合并：它必须靠角色交集并入具体某一期（规则④），
  // 否则绝区零上下半会被同一个同名无时间候选拉到错误的一期。
  const xNoTime = x.startMs === null && x.endMs === null;
  const yNoTime = y.startMs === null && y.endMs === null;
  // 两条都没有时间时，只能靠角色交集认定同一期（否则绝区零上下半的无时间候选会按同名互相粘起来）
  if (xNoTime && yNoTime) {
    const xs = new Set(x.characters.map(charKeyOf));
    return y.characters.some((name) => xs.has(charKeyOf(name)));
  }
  const sameName = !xNoTime && !yNoTime
    && poolNameKey(x.poolName) && poolNameKey(x.poolName) === poolNameKey(y.poolName);
  if (sameName) {
    const startOk = x.startMs === null || y.startMs === null || hourBucket(x.startMs) === hourBucket(y.startMs);
    const endOk = x.endMs === null || y.endMs === null || hourBucket(x.endMs) === hourBucket(y.endMs);
    if (startOk && endOk) return true;
    // 同名但两源给出不同时段：仅在**来自不同信源**且开池时间相差 ≤30 天时视为同一期（官方改期 / 旧公告滞后），
    // 由 buildPool 按「后发布的公告为准」取值。
    // 反面案例：绝区零「代理人调频」上下半同名同源（akasha），必须保持为两期，不能合并。
    const differentSource = (x.candidate.source?.id ?? '') !== (y.candidate.source?.id ?? '');
    if (differentSource && x.startMs !== null && y.startMs !== null && Math.abs(x.startMs - y.startMs) <= 30 * DAY_MS) return true;
  }
  if (hourBucket(x.startMs) === hourBucket(y.startMs) && hourBucket(x.endMs) === hourBucket(y.endMs)) {
    const nx = poolNameKey(x.poolName);
    const ny = poolNameKey(y.poolName);
    if (nx && ny) {
      if (nx === ny) return true;
      if ((nx.length >= 2 && ny.includes(nx)) || (ny.length >= 2 && nx.includes(ny))) return true;
    }
  }
  // ③ 起止时间完全同桶 + 角色有交集 → 同一期（两源池名不同，如 Akasha「灼尽炼狱的新骸」vs B 站「千冶•刃」）
  if (hourBucket(x.startMs) !== 'x' && hourBucket(x.startMs) === hourBucket(y.startMs)) {
    const xEnds = hourBucket(x.endMs);
    if (xEnds !== 'x' && xEnds === hourBucket(y.endMs)) {
      const xNames = new Set(x.characters.map(charKeyOf));
      if (y.characters.some((name) => xNames.has(charKeyOf(name)))) return true;
    }
  }
  // ④ 一方完全没有时间（如绝区零版本公告只写「限定S级代理人」）→ 按角色交集并入已有时段的同类型池，
  //    这样 B 站角色信息能给到 Akasha 的日历池，置信度从 low 升到 high，且不会把上下半张冠李戴
  //    （上下半角色不同，交集为空就不会合并）。
  const xTimeless = x.startMs === null && x.endMs === null;
  const yTimeless = y.startMs === null && y.endMs === null;
  if (xTimeless !== yTimeless && x.poolType === y.poolType) {
    const timed = xTimeless ? y : x;
    const sketch = xTimeless ? x : y;
    if (timed.startMs !== null || timed.endMs !== null) {
      const timedChars = new Set(timed.characters.map(charKeyOf));
      const intersects = sketch.characters.some((name) => timedChars.has(charKeyOf(name)));
      // 同名时允许「一方没有角色」的互补合并（鸣潮官网只给池名、B 站只给时间）；
      // 不同名时必须有角色交集，避免把不相干的池子粘在一起。
      const sameTitle = !!poolNameKey(timed.poolName) && poolNameKey(timed.poolName) === poolNameKey(sketch.poolName);
      if (intersects) return true;
      if (sameTitle && (!timed.characters.length || !sketch.characters.length)) return true;
    }
  }
  // ② 结束时间一致 + 角色有交集 + 恰好一方没有开始时间
  const xEnd = hourBucket(x.endMs);
  const yEnd = hourBucket(y.endMs);
  const oneSideNoStart = (x.startMs === null) !== (y.startMs === null);
  if (xEnd !== 'x' && xEnd === yEnd && oneSideNoStart) {
    const xs = new Set(x.characters.map(charKeyOf));
    const overlap = y.characters.some((name) => xs.has(charKeyOf(name)));
    if (overlap) return true;
  }
  return false;
}

/** 骨架候选能否并入某个正式候选：同游戏 + 同开始小时桶（没有开始时间时用结束时间兜底） */
function isSameSkeletonWindow(member: Prepared, skeleton: Prepared): boolean {
  if (member.candidate.game_key !== skeleton.candidate.game_key) return false;
  if (member.startMs !== null && skeleton.startMs !== null) return hourBucket(member.startMs) === hourBucket(skeleton.startMs);
  if (member.startMs === null && skeleton.startMs === null) {
    return member.endMs !== null && skeleton.endMs !== null && hourBucket(member.endMs) === hourBucket(skeleton.endMs);
  }
  return false;
}

function groupCandidates(prepared: Prepared[], warnings: string[]): PoolGroup[] {
  const groups: PoolGroup[] = [];

  // ① 正式候选：game_key + 池名 + 起止（小时粒度）
  for (const item of prepared) {
    if (item.skeleton) continue;
    // 无时间的候选（如绝区零版本动态只给角色）必须把「角色集合」并进分组键，
    // 否则同一 pool_name 下不同期的角色会被揉成一组，再按交集并到错误的那一期（上下半张冠李戴）。
    const timeless = item.startMs === null && item.endMs === null;
    const charSig = timeless ? [...item.characters].map(charKeyOf).sort().join('+') : '';
    const key = [item.candidate.game_key, poolNameKey(item.poolName), hourBucket(item.startMs), hourBucket(item.endMs), charSig].join('|');
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.members.push(item);
    else groups.push({ key, members: [item] });
  }

  // ② 池名漂移合流（各源的官方池名写法常常只差后缀）
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!groupsCompatible(groups[i], groups[j])) continue;
      groups[i].members.push(...groups[j].members);
      groups.splice(j, 1);
      j -= 1;
    }
  }

  // ③ 时段骨架：config 只提供时段（q5），按时间归并；找不到同期的正式候选就独立成池（保留时段信息）
  for (const item of prepared) {
    if (!item.skeleton) continue;
    const matches = groups.filter((g) => g.members.some((m) => isSameSkeletonWindow(m, item)));
    if (matches.length === 1) {
      matches[0].members.push(item);
      continue;
    }
    if (matches.length > 1) {
      warnings.push('[' + item.candidate.game_key + '] 时段骨架「' + (item.poolName ?? '未命名') + '」对应多个同期卡池，已并入首个');
      matches[0].members.push(item);
      continue;
    }
    groups.push({
      key: [item.candidate.game_key, '#skeleton', hourBucket(item.startMs), hourBucket(item.endMs)].join('|'),
      members: [item],
    });
  }

  return groups;
}

/** 时间按 tier 取：最高 tier 源优先；该源缺这个字段时用次高 tier 补齐（并标注来源，绝不静默回填） */
function pickTime(members: Prepared[], field: 'startMs' | 'endMs', gameKey: string, label: string, warnings: string[]): number | null {
  // 同 tier 时优先「公告发布更晚」的那条（官方改期/旧公告滞后）；发布时间缺失的排后面
  members = [...members].sort((a, b) => {
    const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tierDiff !== 0) return tierDiff;
    const pa = a.candidate.published_at ? Date.parse(a.candidate.published_at) : NaN;
    const pb = b.candidate.published_at ? Date.parse(b.candidate.published_at) : NaN;
    if (Number.isFinite(pa) && Number.isFinite(pb)) return pb - pa;
    if (Number.isFinite(pa)) return -1;
    if (Number.isFinite(pb)) return 1;
    return 0;
  });
  for (let i = 0; i < members.length; i++) {
    const value = members[i][field];
    if (value === null) continue;
    if (i > 0) {
      warnings.push('[' + gameKey + '] 「' + label + '」' + (field === 'startMs' ? '开始' : '结束') + '时间由 ' + (members[i].candidate.source?.id ?? '未知源') + '(' + members[i].tier + ')补齐');
    }
    return value;
  }
  return null;
}

function firstNonEmpty<T>(members: Prepared[], read: (m: Prepared) => T | null | undefined): T | null {
  for (const member of members) {
    const value = read(member);
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function computeStatus(now: number, startMs: number | null, endMs: number | null): ResolvedPool['status'] {
  if (startMs === null) {
    // 没有开池时间就无法判断是否开始：只把「结束时间已过」当成确定结论
    if (endMs !== null && now > endMs) return '已结束';
    return '时间待定';
  }
  if (now < startMs) return '未开始';
  if (endMs !== null && now > endMs) return '已结束';
  return '进行中';
}

function buildLabel(poolType: PoolType, poolName: string | null, version: string | null): string {
  if (version && poolName) return version + ' ' + poolName;
  if (poolName) return poolName;
  if (version) return version + ' ' + POOL_TYPE_LABEL[poolType];
  return POOL_TYPE_LABEL[poolType];
}

function buildPool(group: PoolGroup, now: number, warnings: string[]): ResolvedPool | null {
  const members = [...group.members].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  const head = members[0];
  const gameKey = head.candidate.game_key;
  const poolType = head.poolType;
  const poolName = firstNonEmpty(members, (m) => m.poolName);
  const version = firstNonEmpty(members, (m) => m.candidate.version);
  const period = firstNonEmpty(members, (m) => m.candidate.period);
  const label = period ?? buildLabel(poolType, poolName, version);

  // 时间：最高 tier 源优先，缺字段时由次高 tier 补齐
  const startMs = pickTime(members, 'startMs', gameKey, label, warnings);
  const endMs = pickTime(members, 'endMs', gameKey, label, warnings);
  if (startMs !== null && endMs !== null) {
    const duration = endMs - startMs;
    // 合并后（尤其补齐后）再校验一次时长
    if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
      warnings.push('[' + gameKey + '] 丢弃卡池「' + label + '」: 合并后时长 ' + formatDuration(duration) + ' 不在 1 小时–90 天范围内');
      return null;
    }
  }
  const startAt = startMs === null ? null : toCstIso(startMs);
  const endAt = endMs === null ? null : toCstIso(endMs);

  // 角色：最高 tier 源为准；同一 tier 多源取交集；无官方源时全部源取交集，交集为空则退回最高 tier 源
  const withChars = members.filter((m) => m.characters.length > 0);
  let characters: string[] = [];
  let conflict = false;
  if (withChars.length) {
    const charTier = withChars[0].tier;
    const topChars = withChars.filter((m) => m.tier === charTier);
    const withinTop = intersectAll(topChars.map((m) => m.characters));
    const acrossAll = intersectAll(withChars.map((m) => m.characters));
    if (charTier === 'L0' || charTier === 'L1') {
      // 官方一手/官方挖掘说谁是 UP 就是谁：低 tier 只用于校验与来源记录，不用来裁掉官方角色
      const base = withinTop.length ? withinTop : topChars[0].characters;
      // 但 B 站公告常只写部分 UP（如星铁「其一」只写 1 人、Akasha 结构化列出 3 人），
      // 因此把 L2/L3 结构化源里多出来的角色并进来；config（L4）永远不参与。
      const extra: string[] = [];
      for (const member of withChars) {
        if (member.tier === 'L4' || TIER_RANK[member.tier] <= TIER_RANK[charTier]) continue;
        for (const name of member.characters) {
          const key = charKeyOf(name);
          if (base.some((b) => charKeyOf(b) === key) || extra.some((e) => charKeyOf(e) === key)) continue;
          extra.push(name);
        }
      }
      const limit = UP_LIMITS[gameKey] ?? DEFAULT_UP_LIMIT;
      const merged = [...base, ...extra];
      if (merged.length > limit) {
        warnings.push('[' + gameKey + '] 「' + label + '」合并后 UP ' + merged.length + ' 人超过上限 ' + limit + '，已截断: ' + extra.slice(merged.length - limit).join('、'));
        characters = merged.slice(0, limit);
      } else {
        characters = merged;
        if (extra.length) warnings.push('[' + gameKey + '] 「' + label + '」以 ' + charTier + ' 源为基础，合并结构化源补充角色: ' + extra.join('、'));
      }
      conflict = false;
    } else if (acrossAll.length) {
      characters = acrossAll;
    } else {
      // 多源互相矛盾：取最高 tier 源（不猜），并降置信度
      characters = withinTop;
      conflict = true;
    }
    if (conflict) {
      warnings.push('[' + gameKey + '] 「' + label + '」多源角色不一致，已以 ' + charTier + ' 源为准: ' + characters.join('、'));
    }
  }

  const charSets = withChars.map((m) => m.characters);
  const agreed = charSets.length >= 2 && charSets.every((set) => sameSet(set, charSets[0]));
  const hasOfficial = members.some((m) => m.tier === 'L0');
  let confidence: ResolvedPool['confidence'] = hasOfficial || agreed ? 'high' : 'low';
  if (!characters.length) confidence = 'low';
  // 角色名未经名单校验（字典覆盖不足）时不可能是 high
  if (members.some((m) => m.rosterWeak)) confidence = 'low';
  if (conflict && !hasOfficial) confidence = 'low';

  const status = computeStatus(now, startMs, endMs);
  // 天数按东八区日历日（契约 §1），只给「进行中」算剩余
  const daysRemaining = status === '进行中' && endMs !== null ? Math.max(0, cstDayDiff(now, endMs)) : null;

  const sources: SourceRef[] = [];
  const seenSources = new Set<string>();
  for (const member of members) {
    const ref = member.candidate.source;
    if (!ref || !ref.id || seenSources.has(ref.id)) continue;
    seenSources.add(ref.id);
    sources.push({ ...ref, tier: member.tier });
  }

  return {
    id: stablePoolId(gameKey, poolName, startAt),
    game_key: gameKey,
    label,
    pool_name: poolName,
    pool_type: poolType,
    pool_type_label: POOL_TYPE_LABEL[poolType],
    characters,
    start_at: startAt,
    end_at: endAt,
    version: version ?? null,
    status,
    days_remaining: daysRemaining,
    confidence,
    sources,
    note: firstNonEmpty(members, (m) => m.candidate.note),
    source: head.candidate.source?.id ?? 'unknown',
  };
}

function startOf(pool: ResolvedPool): number {
  const ms = pool.start_at ? Date.parse(pool.start_at) : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** 主入口：候选池 → 合并校验后的卡池列表 */
export function resolvePools(candidates: PoolCandidate[], opts: ResolveOptions = {}): ResolveResult {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const warnings: string[] = opts.warnings ?? [];
  const index: RosterIndex | null = opts.index
    ?? opts.rosterIndex
    ?? (opts.roster ? buildRosterIndex(Array.isArray(opts.roster) ? opts.roster : flattenCharBook(opts.roster)) : null);

  const prepared: Prepared[] = [];
  for (const candidate of candidates ?? []) {
    const item = prepareCandidate(candidate, index, warnings);
    if (item) prepared.push(item);
  }

  const pools: ResolvedPool[] = [];
  for (const group of groupCandidates(prepared, warnings)) {
    const pool = buildPool(group, now, warnings);
    if (pool) pools.push(pool);
  }

  // 极端情况下不同分组可能撞到同一 id（池名与开池时间都相同）：保留置信度更高的
  const byId = new Map<string, ResolvedPool>();
  for (const pool of pools) {
    const existing = byId.get(pool.id);
    if (!existing) {
      byId.set(pool.id, pool);
      continue;
    }
    warnings.push('[' + pool.game_key + '] 卡池 id 冲突已去重: ' + pool.id);
    if (existing.confidence === 'low' && pool.confidence === 'high') byId.set(pool.id, pool);
  }

  const refined = refinePools([...byId.values()], now, warnings);
  const merged = refined.sort((a, b) => {
    if (a.game_key !== b.game_key) return a.game_key < b.game_key ? -1 : 1;
    const diff = startOf(a) - startOf(b);
    return diff !== 0 ? diff : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return { pools: merged, warnings };
}

/**
 * 合并后的统一后处理（避免「已结束的旧池 / 缺结束时间的池」把页面搞乱）：
 * 1) 缺 end_at 且有「下一期」时，用下一期开池时间近似补齐（间隔 ≤60 天才补，避免跨版本误补）；
 * 2) 补齐后重算 status / days_remaining；
 * 3) start 缺但 end 在未来的池视为「进行中」（公告已发布且尚未结束，说明它已经开了）。
 */
function refinePools(pools: ResolvedPool[], now: number, warnings: string[]): ResolvedPool[] {
  const byGame = new Map<string, ResolvedPool[]>();
  for (const pool of pools) {
    const list = byGame.get(pool.game_key);
    if (list) list.push(pool); else byGame.set(pool.game_key, [pool]);
  }

  const out: ResolvedPool[] = [];
  for (const [gameKey, list] of byGame) {
    const starts = [...new Set(list
      .map((p) => (p.start_at ? Date.parse(p.start_at) : NaN))
      .filter((ms) => Number.isFinite(ms)))] as number[];
    starts.sort((a, b) => a - b);
    // 异环「限定棋盘」是轮换位：只按棋盘池自己的开池时间排序
    const pactStarts = [...new Set(list
      .filter((p) => p.pool_type === 'pact')
      .map((p) => (p.start_at ? Date.parse(p.start_at) : NaN))
      .filter((ms) => Number.isFinite(ms)))] as number[];
    pactStarts.sort((a, b) => a - b);

    for (const pool of list) {
      let endAt = pool.end_at;
      let note = pool.note;
      if (!endAt && pool.start_at) {
        const startMs = Date.parse(pool.start_at);
        const next = starts.find((ms) => ms > startMs);
        if (Number.isFinite(startMs) && next !== undefined && next - startMs <= 60 * DAY_MS) {
          endAt = toCstIso(next);
          note = [note, '结束时间按下一期开池时间近似'].filter(Boolean).join('；');
        }
      }

      const startMs = pool.start_at ? Date.parse(pool.start_at) : null;

      // 轮换位截断（异环棋盘）：官方 1.5 公告写「11-11 版本更新后 ~ 12-02」，
      // 但 11-26 新棋盘上线后旧棋盘实际在 11-26 结束；否则页面会把已下架的棋盘当成「进行中」。
      if (pool.pool_type === 'pact' && endAt && startMs !== null) {
        const declaredEnd = Date.parse(endAt);
        const nextStart = pactStarts.find((ms) => ms > startMs && ms < declaredEnd);
        if (nextStart !== undefined) {
          endAt = toCstIso(nextStart);
          note = [note, '结束时间按下一期棋盘开池时间截断'].filter(Boolean).join('；');
        }
      }

      const endMs = endAt ? Date.parse(endAt) : null;
      let status = pool.status;
      if (startMs !== null && endMs !== null) status = now < startMs ? '未开始' : now > endMs ? '已结束' : '进行中';
      else if (startMs === null && endMs !== null) status = now > endMs ? '已结束' : '进行中';
      const daysRemaining = status === '进行中' && endMs !== null ? Math.max(0, cstDayDiff(now, endMs)) : null;

      if (!endAt && status === '进行中' && startMs === null) {
        warnings.push('[' + gameKey + '] 「' + pool.label + '」缺起止时间，已按「进行中」处理（无结束时间）');
      }
      out.push({ ...pool, end_at: endAt, status, days_remaining: daysRemaining, note });
    }
  }
  return out;
}

// ————————————————————————— 写入 feed —————————————————————————
// 兼容旧消费方：保留 label/characters/start_at/end_at/status/days_remaining/source，
// 新增 pool_name/pool_type/pool_type_label/confidence/sources（契约 §3）。

export interface FeedGameLike {
  key?: string;
  game_key?: string;
  stage?: string;
  up_banners?: unknown[];
  current_up_characters?: string[];
  [field: string]: unknown;
}

export interface FeedLike {
  data?: { games?: FeedGameLike[]; [field: string]: unknown };
  games?: FeedGameLike[];
  [field: string]: unknown;
}

export interface ApplyPoolsResult {
  feed: FeedLike;
  warnings: string[];
}

function bannerFromPool(pool: ResolvedPool) {
  return {
    label: pool.label,
    phase: null,
    pool_name: pool.pool_name,
    pool_type: pool.pool_type,
    pool_type_label: pool.pool_type_label,
    characters: [...pool.characters],
    start_at: pool.start_at,
    end_at: pool.end_at,
    status: pool.status,
    days_remaining: pool.days_remaining,
    confidence: pool.confidence,
    sources: pool.sources.map((ref) => ({ ...ref })),
    version: pool.version,
    note: pool.note,
    source: pool.source,
  };
}

function statusRank(status: ResolvedPool['status']): number {
  if (status === '进行中') return 0;
  if (status === '未开始') return 1;
  return 2;
}

/** 角色名去重键：忽略空白、全角/半角分隔符与大小写（「千冶•刃」与「千冶·刃」视为同一人） */
function characterKey(name: string): string {
  return String(name ?? '').replace(/[\s·•・\-—_]/g, '').toLowerCase();
}

/**
 * current_up_characters：只输出「当前这批」限定/协定角色池的 UP。
 * 规则（对应 2026-11-26 反馈）：
 * 1) 只认 status === '进行中' 的角色池（已结束 / 时间待定一律不进，避免旧版本或缺结束时间的池子混入）；
 * 2) 只取开始时间最晚的那一批（24h 内），同一版本内并行的双池都算「当前」；
 * 3) 名称归一化后去重，避免 A 源写「千冶•刃」、B 源写「千冶·刃」被当成两个人。
 * 开始时间全部缺失时（如 B 站公告只给「版本更新后」）退化为「所有进行中角色池」。
 */
export function currentUpCharacters(pools: ResolvedPool[]): string[] {
  const ongoing = pools.filter((pool) =>
    CHARACTER_POOL_TYPES.includes(pool.pool_type) && pool.characters.length > 0 && pool.status === '进行中');
  if (!ongoing.length) return [];

  const withStart = ongoing.filter((pool) => pool.start_at && Number.isFinite(Date.parse(pool.start_at)));
  let chosen = ongoing;
  if (withStart.length) {
    const latest = Math.max(...withStart.map((pool) => Date.parse(pool.start_at as string)));
    chosen = withStart.filter((pool) => latest - Date.parse(pool.start_at as string) <= DAY_MS);
  }
  chosen = chosen.slice().sort((a, b) => startOf(a) - startOf(b));

  const seen = new Set<string>();
  const names: string[] = [];
  for (const pool of chosen) {
    for (const name of pool.characters) {
      const key = characterKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * 把合并结果写回 feed 的 games[].up_banners。
 * 解析不到的游戏写 up_banners: []（q4：隐藏卡池块 + 写 health 告警，绝不回填 config 角色名）。
 * 返回新对象、不修改入参——重建流程里同一份 feed 会被多处引用，原地改容易串味。
 */
/**
 * 展示过滤（2026-11-26 反馈后固化，避免同类问题复发）：
 * 1) 武器池直接不展示（无武器名 = 半成品）；
 * 2) 角色池 / 协定池没有 UP 名字 → 丢弃（Akasha 之类只给池名的源会把卡片塞成空壳）；
 * 3) 起止时间全空的 → 丢弃（解析残片，页面只会显示「时间待公布」）；
 * 4) 已结束的池子每条游戏最多保留 2 条（最近的），避免历史期次刷屏。
 */
export function visiblePools(pools: ResolvedPool[], warnings: string[] = [], gameKey = ''): ResolvedPool[] {
  const kept = pools.filter((pool) => {
    if (pool.pool_type === 'weapon') return false;
    if (!pool.characters.length) {
      warnings.push('[' + gameKey + '] 丢弃无 UP 角色的卡池: ' + pool.label);
      return false;
    }
    if (!pool.start_at && !pool.end_at) {
      warnings.push('[' + gameKey + '] 丢弃无起止时间的卡池: ' + pool.label);
      return false;
    }
    return true;
  });

  const ended = kept
    .filter((pool) => pool.status === '已结束')
    .slice()
    .sort((a, b) => recencyOf(b) - recencyOf(a));
  const keepEnded = new Set(ended.slice(0, MAX_ENDED_POOLS).map((pool) => pool.id));
  return kept.filter((pool) => pool.status !== '已结束' || keepEnded.has(pool.id));
}

/** 已结束期次最多保留条数（2026-11-26 明确要求：只保留最近的 2 条） */
export const MAX_ENDED_POOLS = 2;

/** 最近程度：优先按结束时间，其次开始时间 */
function recencyOf(pool: ResolvedPool): number {
  const end = pool.end_at ? Date.parse(pool.end_at) : NaN;
  if (Number.isFinite(end)) return end;
  const start = pool.start_at ? Date.parse(pool.start_at) : NaN;
  return Number.isFinite(start) ? start : 0;
}
/**
 * 从卡池排期推导「下个节点」：
 * ① 有未开始的池 → 最近一次开池日；
 * ② 否则取进行中池里最晚的结束日（= 本期轮换结束 / 下一期开池日）。
 * 版本号往往要等官方前瞻才公布，而卡池/轮换日期每天都拿得到，用它兜住「暂未公布」。
 */
export function nextNodeFromPools(
  pools: ResolvedPool[],
  now: number,
): { at: string; kind: 'pool_start' | 'pool_end'; label: string; pool: ResolvedPool } | null {
  const upcoming = pools
    .filter((pool) => pool.status === '未开始' && pool.start_at)
    .slice()
    .sort((a, b) => Date.parse(a.start_at as string) - Date.parse(b.start_at as string));
  if (upcoming.length) {
    const pool = upcoming[0];
    const name = pool.pool_name ?? pool.label;
    return { at: pool.start_at as string, kind: 'pool_start', label: name + ' 开启', pool };
  }
  const ongoing = pools
    .filter((pool) => pool.status === '进行中' && pool.end_at)
    .slice()
    .sort((a, b) => Date.parse(b.end_at as string) - Date.parse(a.end_at as string));
  if (ongoing.length) {
    const pool = ongoing[0];
    const name = pool.pool_name ?? pool.label;
    return { at: pool.end_at as string, kind: 'pool_end', label: '本期卡池结束（' + name + '）', pool };
  }
  return null;
}
export function applyPoolsToFeed(feed: FeedLike, resolved: ResolvedPool[], opts: { now?: number } = {}): ApplyPoolsResult {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const warnings: string[] = [];
  const games = (feed?.data?.games ?? feed?.games) as FeedGameLike[] | undefined;
  if (!Array.isArray(games)) {
    warnings.push('[pools] feed 中没有 games 数组，跳过卡池写入');
    return { feed, warnings };
  }

  const byGame = new Map<string, ResolvedPool[]>();
  for (const pool of resolved ?? []) {
    const list = byGame.get(pool.game_key);
    if (list) list.push(pool);
    else byGame.set(pool.game_key, [pool]);
  }

  const seenGames = new Set<string>();
  const nextGames = games.map((game) => {
    const key = String(game.key ?? game.game_key ?? '');
    seenGames.add(key);
    const all = (byGame.get(key) ?? []).slice().sort((a, b) => startOf(a) - startOf(b));
    // 决策（2026-11-26）：武器池不再输出半成品（没有武器名）→ 直接不展示；
    // 协定卡池（异环「协定」）单独一个字段，避免和角色限定池混在一起。
    const pools = visiblePools(all, warnings, key);
    const characterPools = pools.filter((pool) => pool.pool_type !== 'pact');
    const pactPools = pools.filter((pool) => pool.pool_type === 'pact');
    if (!pools.length) {
      if (game.stage !== 'prelaunch') warnings.push('[' + key + '] 未解析到卡池，up_banners 置空');
      return { ...game, up_banners: [], pact_banners: [], current_up_characters: [] };
    }

    // 下个节点：版本日期拿不到时，用卡池排期兜底（版本前瞻公布前也能给出具体日期）
    const node = nextNodeFromPools(pools, now);
    const nodeDays = node ? Math.max(0, cstDayDiff(now, Date.parse(node.at))) : null;
    const hasVersionDays = typeof (game as any).days_to_next_version === 'number';

    return {
      ...game,
      up_banners: characterPools.map(bannerFromPool),
      pact_banners: pactPools.map(bannerFromPool),
      current_up_characters: currentUpCharacters(all),
      next_node_at: node?.at ?? null,
      next_node_label: node?.label ?? null,
      next_node_kind: node?.kind ?? null,
      next_node_source: node ? (node.pool.sources[0]?.id ?? node.pool.source) : null,
      // 只有版本日期缺失时才用卡池日期兜底，避免把「版本更新」误写成「卡池结束」
      days_to_next_version: hasVersionDays ? (game as any).days_to_next_version : nodeDays,
    };
  });

  for (const key of byGame.keys()) {
    if (!seenGames.has(key)) warnings.push('[' + key + '] 解析出的卡池在 feed 中找不到对应游戏，已忽略');
  }

  const nextFeed: FeedLike = feed?.data?.games
    ? { ...feed, data: { ...feed.data, games: nextGames } }
    : { ...feed, games: nextGames };
  return { feed: nextFeed, warnings };
}
