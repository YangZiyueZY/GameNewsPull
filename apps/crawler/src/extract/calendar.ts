// 活动日历 + 角色生日：纯函数实现（不联网、不读文件），便于离线测试与重建。
//
// 设计：
// - 活动 = 人工种子（config/curation.ts）∪ 官方动态自动识别；去重、排序、最多 3 条。
// - 生日 = 从官方「#角色# #生日快乐#」动态学习 MM-DD。发布日不一定等于角色生日：
//   绝区零等账号的「生日快乐」动态常是互动抽奖，同一角色会在不同日期重复出现，
//   因此只有在正文明确写了「X月X日」时才采纳；仅对「生日当天发布」的账号（白名单）
//   允许用发布日推断。同一角色学到多个不同 MM-DD 视为不可靠，整条丢弃。
// - 所有对外时间均为 ISO 8601；生日按 Asia/Shanghai（+08:00）计算下一次 00:00。
import type { NewsItem } from './normalize.ts';
import type { GameConfig } from '../../config/games.ts';
import { GAME_BY_KEY } from '../../config/games.ts';
import { curatedEventsFor } from '../../config/curation.ts';
import type { CuratedEvent } from '../../config/curation.ts';

export type EventStatus = '进行中' | '即将开始' | '已结束' | '时间待定';

export interface EventItem {
  id: string;
  title: string;
  category: 'event' | 'prelaunch';
  status: EventStatus;
  start_at: string | null;
  end_at: string | null;
  days_remaining: number | null;
  note: string | null;
  url: string | null;
  source: 'curated' | 'official';
}

export interface BirthdayRecord {
  character: string;
  month_day: string;          // 'MM-DD'
  url: string | null;
  source: 'curated' | 'official';
  learned_at?: string;
  /** 内部标记：MM-DD 来自正文明确日期（true）还是发布日推断（false）；不进入 feed */
  explicit?: boolean;
}

export type BirthdayBook = Record<string, BirthdayRecord[]>;

export type BirthdayState = 'today' | 'upcoming' | 'recent' | 'far';

export interface BirthdayItem {
  character: string;
  month_day: string;
  next_at: string;             // 下一次生日 00:00 +08:00
  days_until: number;
  /** 最近一次生日过去的天数（0 = 今天）；生日在未来时为 null */
  days_since: number | null;
  /** today 今天 / upcoming 30 天内 / recent 过去 30 天内 / far 其余 */
  state: BirthdayState;
  url: string | null;
  source: 'curated' | 'official';
}

const DAY_MS = 86_400_000;
const TZ_OFFSET = 8 * 3_600_000;      // Asia/Shanghai，无夏令时
const MAX_EVENTS = 3;
const MAX_BIRTHDAYS = 4;
const ENDED_KEEP_MS = 30 * DAY_MS;    // 已结束活动最多保留 30 天，避免老活动占位

// ——————————————————————————— 时间工具 ———————————————————————————

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 某一瞬间在 Asia/Shanghai 的「当天 00:00」对应的 epoch ms */
export function shanghaiDayStart(ms: number): number {
  const d = new Date(ms + TZ_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ_OFFSET;
}

/** epoch ms → 'YYYY-MM-DDTHH:mm:ss+08:00' */
export function toShanghaiIso(ms: number): string {
  const d = new Date(ms + TZ_OFFSET);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`;
}

/** 上海时间年月日时分 → epoch ms */
export function fromShanghaiParts(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ——————————————————————————— 活动状态 ———————————————————————————

export function eventStatus(
  start_at: string | null | undefined,
  end_at: string | null | undefined,
  now: number = Date.now(),
): EventStatus {
  const start = parseMs(start_at);
  const end = parseMs(end_at);
  if (start === null && end === null) return '时间待定';
  if (start !== null && start > now) return '即将开始';
  if (end !== null && end < now) return '已结束';
  return '进行中';
}

/** 距结束还剩几天（向上取整）；无结束时间返回 null */
export function daysRemaining(end_at: string | null | undefined, now: number = Date.now()): number | null {
  const end = parseMs(end_at);
  if (end === null) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

const STATUS_RANK: Record<EventStatus, number> = {
  进行中: 0,
  即将开始: 1,
  时间待定: 2,
  已结束: 3,
};

export function eventSortRank(status: EventStatus): number {
  return STATUS_RANK[status];
}

function sortEvents(a: EventItem, b: EventItem): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  const aStart = parseMs(a.start_at);
  const bStart = parseMs(b.start_at);
  const aEnd = parseMs(a.end_at);
  const bEnd = parseMs(b.end_at);
  if (a.status === '进行中') {
    // 进行中：先结束的排前面，没有结束时间的靠后
    return (aEnd ?? Number.POSITIVE_INFINITY) - (bEnd ?? Number.POSITIVE_INFINITY)
      || (aStart ?? Number.POSITIVE_INFINITY) - (bStart ?? Number.POSITIVE_INFINITY);
  }
  if (a.status === '即将开始') {
    return (aStart ?? Number.POSITIVE_INFINITY) - (bStart ?? Number.POSITIVE_INFINITY);
  }
  if (a.status === '已结束') {
    // 最近结束的排前面
    return (bEnd ?? 0) - (aEnd ?? 0);
  }
  // 时间待定：按 id 稳定排序
  return a.id.localeCompare(b.id);
}

function dayKey(iso: string | null): string | null {
  const ms = parseMs(iso);
  if (ms === null) return null;
  return new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);
}

function normalizeTitle(title: string): string {
  return title
    .replace(/[#＃]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』《》【】\[\]（）()·・，,。.！!？?：:；;、~～\-—|/\\]/g, '')
    .slice(0, 16);
}

function mergeEvents(list: EventItem[]): EventItem[] {
  const out: EventItem[] = [];
  const byKey = new Map<string, EventItem>();
  for (const ev of list) {
    // 同名活动（人工种子 vs 官方公告）只保留一条，人工种子优先
    const key = normalizeTitle(ev.title);
    const dup = byKey.get(key);
    if (dup) {
      if (dup.source === 'official' && ev.source === 'curated') {
        out[out.indexOf(dup)] = ev;
        byKey.set(key, ev);
      }
      continue;
    }
    byKey.set(key, ev);
    out.push(ev);
  }
  return out;
}

function fromCurated(ce: CuratedEvent, now: number): EventItem {
  const computed = eventStatus(ce.start_at, ce.end_at, now);
  // 人工声明状态的兜底：① 无起止时间 → 用声明状态（如「时间待定」）；
  // ② 一次性活动（只有开始时间、官方没给结束时间）声明为「已结束」时按声明处理，
  //    避免直播/节目这类一次事件长期显示「进行中」。
  let status = computed;
  if (ce.start_at === null && ce.end_at === null) status = ce.status;
  else if (computed === '进行中' && ce.end_at === null && ce.status === '已结束') status = '已结束';
  return {
    id: 'curated:' + ce.id,
    title: ce.title,
    category: ce.category,
    status,
    start_at: ce.start_at,
    end_at: ce.end_at,
    days_remaining: status === '进行中' ? daysRemaining(ce.end_at, now) : null,
    note: ce.note ?? null,
    url: ce.url ?? null,
    source: 'curated',
  };
}

// ——————————————————————————— 官方活动自动识别 ———————————————————————————

// 只认「活动词 + 明确起止日期」的公告，避免把卡池、版本更新、抽奖当成活动
const ACTIVITY_KEYWORD_RE = /活动|联动|签到|嘉年华|音乐会|巡礼|展览|线下|主题店|开放日|测试招募|预约|预售|直播|特别节目|庆典|周年/;
// 卡池/版本维护/纯商业周边与抽奖都不是「游戏内活动」，不自动收录
const GACHA_OR_UPDATE_RE = /祈愿|卡池|寻访|跃迁|调频|概率提升|版本更新|更新公告|维护|补丁|修复|手办|周边|预售|联名|招募|抽奖|开奖|兑换码|创作者激励|激励计划|音乐H5|专辑/;
const DATE_RANGE_SEP_RE = /^[\s~～\-—－至到|,，、]+$/;
const DATE_RANGE_HAS_SEP_RE = /[~～\-—－至到]/;

const DATE_RE = /(?:(\d{4})\s*[年\/.\-])?\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})[:：](\d{2}))?/g;

interface DateMatch { y: number | null; mo: number; d: number; h: number | null; mi: number | null; start: number; end: number }

function collectDates(text: string): DateMatch[] {
  const out: DateMatch[] = [];
  DATE_RE.lastIndex = 0;
  for (const m of text.matchAll(DATE_RE)) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) continue;
    out.push({
      y: m[1] ? Number(m[1]) : null,
      mo, d,
      h: m[4] !== undefined ? Number(m[4]) : null,
      mi: m[5] !== undefined ? Number(m[5]) : null,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

function resolveYear(mo: number, d: number, now: number, explicitYear: number | null): number {
  if (explicitYear !== null && Number.isFinite(explicitYear)) return explicitYear;
  const cur = new Date(now + TZ_OFFSET);
  const year = cur.getUTCFullYear();
  const cand = fromShanghaiParts(year, mo, d, 12, 0);
  if (cand > now + 300 * DAY_MS) return year - 1;
  if (cand < now - 300 * DAY_MS) return year + 1;
  return year;
}

/** 从一段公告文本里解析第一个「起 ~ 止」日期区间 */
export function parseDateRange(text: string, now: number = Date.now()): { start_at: string; end_at: string } | null {
  const dates = collectDates(text);
  for (let i = 0; i + 1 < dates.length; i++) {
    const a = dates[i];
    const b = dates[i + 1];
    const between = text.slice(a.end, b.start);
    if (!DATE_RANGE_SEP_RE.test(between) || !DATE_RANGE_HAS_SEP_RE.test(between)) continue;
    const sy = resolveYear(a.mo, a.d, now, a.y);
    const startMs = fromShanghaiParts(sy, a.mo, a.d, a.h ?? 0, a.mi ?? 0);
    let ey = resolveYear(b.mo, b.d, now, b.y);
    if (b.y === null && (b.mo < a.mo || (b.mo === a.mo && b.d < a.d))) ey = sy + 1;
    const endMs = fromShanghaiParts(ey, b.mo, b.d, b.h ?? 23, b.mi ?? 59);
    if (endMs < startMs) continue;
    return { start_at: toShanghaiIso(startMs), end_at: toShanghaiIso(endMs) };
  }
  return null;
}

const GENERIC_TITLE_RE = /^(?:互动抽奖|亲爱的.{0,6}|旅行者们?好|管理员|开拓者|老师|绳匠|博士|漂泊者|星临者)/;

function cleanOfficialTitle(item: NewsItem): string {
  let title = item.title
    .replace(/^《[^》]{1,24}》/, '')
    .replace(/[#＃][^#＃\n]{1,24}[#＃]/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || GENERIC_TITLE_RE.test(title)) {
    title = item.summary
      .split(/[\n。！!]/)
      .map(s => s.replace(/[#＃][^#＃\n]{1,24}[#＃]/g, '').trim())
      .find(s => s.length >= 4 && !GENERIC_TITLE_RE.test(s)) ?? '';
  }
  title = title.replace(/^[（(【\[]|[】\])）]+$/g, '').replace(/[：:，,、]+$/, '').trim();
  if (title.length < 4) return '';
  return title.slice(0, 40);
}

function detectOfficialEvents(game: GameConfig | undefined, items: NewsItem[], now: number): EventItem[] {
  const out: EventItem[] = [];
  for (const item of items) {
    const published = parseMs(item.published_at);
    // 只从近 120 天的动态里识别，避免历史活动被翻出来
    if (published !== null && published < now - 120 * DAY_MS) continue;
    const text = item.title + '\n' + item.summary;
    if (!ACTIVITY_KEYWORD_RE.test(text) || GACHA_OR_UPDATE_RE.test(text)) continue;
    const range = parseDateRange(text, now);
    if (!range) continue;
    const endMs = parseMs(range.end_at);
    if (endMs !== null && endMs < now - ENDED_KEEP_MS) continue;
    const title = cleanOfficialTitle(item);
    if (!title) continue;
    const status = eventStatus(range.start_at, range.end_at, now);
    out.push({
      id: 'official:' + item.id,
      title,
      category: 'event',
      status,
      start_at: range.start_at,
      end_at: range.end_at,
      days_remaining: status === '进行中' ? daysRemaining(range.end_at, now) : null,
      note: '官方动态自动识别',
      url: item.url,
      source: 'official',
    });
  }
  // 同一活动可能被多条动态重复提到（预告 + 开启），按标题去重
  return mergeEvents(out);
}

/**
 * 活动日历：人工种子 ∪ 官方动态自动识别。
 * 排序：进行中 → 即将开始 → 时间待定 → 最近结束；最多 3 条。
 */
export function buildEvents(
  game: string | GameConfig,
  items: NewsItem[] = [],
  now: number = Date.now(),
): EventItem[] {
  const cfg = typeof game === 'string' ? GAME_BY_KEY.get(game) : game;
  const key = cfg?.key ?? String(game);
  const curated = curatedEventsFor(key).map(ce => fromCurated(ce, now));
  // 人工种子已满 3 条时不再掺杂官方自动识别结果（避免脚本标题挤掉人工维护的活动）
  const curatedDays = new Set(curated.map(ev => dayKey(ev.start_at)).filter((d): d is string => !!d));
  const official = curated.length >= MAX_EVENTS
    ? []
    : detectOfficialEvents(cfg, items, now).filter(ev => {
        // 与人工种子同一天开始的活动视为重复（如人工已维护的同名联动）
        const day = dayKey(ev.start_at);
        return !(day && curatedDays.has(day));
      });
  const merged = mergeEvents([...curated, ...official]);
  return merged.sort(sortEvents).slice(0, MAX_EVENTS);
}

// ——————————————————————————— 生日 ———————————————————————————

// 「生日当天发布生日动态」的账号白名单：只有这些游戏允许用发布日（+08:00）推断 MM-DD。
// 绝区零等账号的 #生日快乐# 多为互动抽奖，同一角色会在不同日期重复出现，不能推断。
const POST_DATE_TRUSTED = new Set(['genshin']);

const BIRTHDAY_STOPWORD_RE = /生日快乐|生日|庆生|贺图|壁纸|活动|抽奖|转发|关注|官方|直播|周边|表情包|头像|投稿|征集|纪念|福利|更新|公告|版本|联动|互动|有奖|赠送|福利/;
const GAME_TAG_RE = /原神|绝区零|星穹铁道|崩铁|明日方舟|终末地|鸣潮|蔚蓝档案|蓝色星原|白银之城|因缘精灵|异环|米哈游|鹰角|库洛|悠星|蛮啾|乐元素|完美世界/;
// 清洗后仍是「游戏名 / 厂商名」的话题标签不是角色名
const GAME_NAME_SET = new Set<string>([
  '原神', '绝区零', '星穹铁道', '崩坏星穹铁道', '崩铁', '明日方舟', '终末地', '明日方舟终末地',
  '鸣潮', '蔚蓝档案', '碧蓝档案', '蓝色星原', '蓝色星原旅谣', '白银之城', '因缘精灵', '崩坏因缘精灵',
  '异环', '米哈游', '鹰角', '鹰角网络', '库洛', '库洛游戏', '悠星', '悠星网络', '蛮啾', '蛮啾网络',
  '乐元素', '完美世界',
]);
const GAME_PREFIXES = ['原神', '绝区零', '星穹铁道', '崩坏星穹铁道', '明日方舟终末地', '明日方舟', '终末地',
  '鸣潮', '蔚蓝档案', '碧蓝档案', '蓝色星原', '白银之城', '因缘精灵', '崩坏因缘精灵', '异环'];
// 「明确日期」必须与「生日」同句相邻，否则会把抽奖开奖日（11月18日开奖）当成生日
const EXPLICIT_MD_RES: RegExp[] = [
  /生日[^。\n]{0,8}?(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,6}?(?:生日|庆生)/,
];

function explicitMonthDay(text: string): string | null {
  for (const re of EXPLICIT_MD_RES) {
    const m = text.match(re);
    if (!m) continue;
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return pad2(mo) + '-' + pad2(d);
  }
  return null;
}

function mmdd(ms: number): string {
  const d = new Date(ms + TZ_OFFSET);
  return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function isValidMonthDay(value: string): boolean {
  const m = value.match(/^(\d{2})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

/** 角色名清洗：#绝区零妮可# → 妮可；#生日快乐妮可# → 妮可 */
export function cleanCharacterTag(tag: string, game?: string | GameConfig): string {
  const cfg = typeof game === 'string' ? GAME_BY_KEY.get(game) : game;
  let name = (tag || '').replace(/[\s\u3000]/g, '');
  const prefixes = [...GAME_PREFIXES, cfg?.name ?? '', ...(cfg?.aliases ?? [])].filter(Boolean);
  // 长前缀优先，避免「明日方舟」先吃掉「明日方舟终末地」
  for (const prefix of prefixes.sort((a, b) => b.length - a.length)) {
    if (prefix.length > 1 && name.startsWith(prefix) && name.length > prefix.length + 1) {
      name = name.slice(prefix.length);
      break;
    }
  }
  name = name.replace(/^(?:生日快乐|生日|祝)+/, '');
  name = name.replace(/(?:生日快乐|生日|庆生)+$/, '');
  return name.trim();
}

/**
 * 从官方动态学习角色生日。
 * - 必须同时出现 #生日快乐# 与角色话题标签；
 * - 正文写了「X月X日」→ 采用该日期（explicit）；
 * - 否则只有白名单账号（生日当天发布）才用发布日推断；
 * - 同一角色学到多个不同 MM-DD → 视为不可靠，整条丢弃。
 */
export function learnBirthdays(game: string | GameConfig, items: NewsItem[], now: number = Date.now()): BirthdayRecord[] {
  const cfg = typeof game === 'string' ? GAME_BY_KEY.get(game) : game;
  const key = cfg?.key ?? String(game);
  const gameTags = new Set<string>([cfg?.name ?? '', ...(cfg?.aliases ?? [])].filter(Boolean));
  const trustPostDate = POST_DATE_TRUSTED.has(key);

  const candidates = new Map<string, { monthDay: string; explicit: boolean; url: string | null }[]>();
  const push = (name: string, monthDay: string, explicit: boolean, url: string | null) => {
    const list = candidates.get(name) ?? [];
    list.push({ monthDay, explicit, url });
    candidates.set(name, list);
  };

  for (const item of items) {
    const text = item.title + '\n' + item.summary;
    if (!text.includes('生日')) continue;
    const tags = [...text.matchAll(/#([^#\n]{1,20})#/g)].map(m => m[1].trim()).filter(Boolean);
    if (!tags.some(t => t.includes('生日快乐'))) continue;

    const explicitDate = explicitMonthDay(text);
    const published = parseMs(item.published_at) ?? now;
    const postedMonthDay = mmdd(published);

    for (const tag of tags) {
      if (tag.includes('生日快乐')) continue;
      if (BIRTHDAY_STOPWORD_RE.test(tag)) continue;
      if (gameTags.has(tag)) continue;
      // 先剥掉游戏名前缀（#绝区零妮可# → 妮可），再判断是否仍是游戏名
      const name = cleanCharacterTag(tag, cfg);
      if (GAME_NAME_SET.has(name) || GAME_NAME_SET.has(tag)) continue;
      if (name.length < 2 || name.length > 12) continue;
      if (/^\d+$/.test(name)) continue;

      if (explicitDate) push(name, explicitDate, true, item.url ?? null);
      else if (trustPostDate) push(name, postedMonthDay, false, item.url ?? null);
      // 不可信账号且无明确日期 → 不采纳（宁可 birthdays 为空）
    }
  }

  const out: BirthdayRecord[] = [];
  for (const [name, list] of candidates) {
    const explicitDays = [...new Set(list.filter(x => x.explicit).map(x => x.monthDay))];
    let chosen: string | null = null;
    if (explicitDays.length === 1) chosen = explicitDays[0];
    else if (explicitDays.length === 0) {
      const inferred = [...new Set(list.map(x => x.monthDay))];
      if (inferred.length === 1) chosen = inferred[0];
    }
    // explicitDays.length > 1 或推断出多个不同日期 → 不可靠，丢弃
    if (!chosen) continue;
    const best = list.find(x => x.monthDay === chosen) ?? list[0];
    out.push({
      character: name,
      month_day: chosen,
      url: best.url ?? null,
      source: 'official',
      learned_at: new Date(now).toISOString(),
      explicit: best.explicit,
    });
  }
  return out;
}

/** 合并生日簿（跨运行累积）：同一角色以最新学习结果为准，保留已有链接 */
export function mergeBirthdayBook(prev: BirthdayBook = {}, learned: BirthdayBook = {}): BirthdayBook {
  const out: BirthdayBook = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(learned)]);
  for (const key of keys) {
    const byName = new Map<string, BirthdayRecord>();
    for (const rec of prev[key] ?? []) {
      if (!rec?.character || !isValidMonthDay(rec.month_day)) continue;
      byName.set(rec.character, { ...rec });
    }
    for (const rec of learned[key] ?? []) {
      if (!rec?.character || !isValidMonthDay(rec.month_day)) continue;
      const old = byName.get(rec.character);
      byName.set(rec.character, {
        ...rec,
        url: rec.url ?? old?.url ?? null,
        source: rec.source ?? old?.source ?? 'official',
      });
    }
    const list = [...byName.values()].sort((a, b) => a.month_day.localeCompare(b.month_day) || a.character.localeCompare(b.character));
    if (list.length) out[key] = list;
  }
  return out;
}

/**
 * 下一次生日（+08:00 当天 00:00）；生日当天 days_until = 0。
 * 同时给出「最近一次生日」距今天数（days_since），用于 UI 显示「昨天 / N 天前」。
 */
export function nextBirthday(
  month_day: string,
  now: number = Date.now(),
): { next_at: string; days_until: number; days_since: number | null; state: BirthdayState } | null {
  const m = month_day.match(/^(\d{2})-(\d{2})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const todayStart = shanghaiDayStart(now);
  const year = new Date(todayStart + TZ_OFFSET).getUTCFullYear();
  let cand = Date.UTC(year, mo - 1, d) - TZ_OFFSET;
  if (cand < todayStart) cand = Date.UTC(year + 1, mo - 1, d) - TZ_OFFSET;
  const days_until = Math.round((cand - todayStart) / DAY_MS);

  // 最近一次生日：今年生日已过则就是今年，否则是去年
  let last = Date.UTC(year, mo - 1, d) - TZ_OFFSET;
  if (last > todayStart) last = Date.UTC(year - 1, mo - 1, d) - TZ_OFFSET;
  const days_since = days_until === 0 ? 0 : Math.round((todayStart - last) / DAY_MS);

  let state: BirthdayState;
  if (days_until === 0) state = 'today';
  else if (days_until <= 30) state = 'upcoming';
  else if (days_since !== null && days_since <= 30) state = 'recent';
  else state = 'far';

  return {
    next_at: toShanghaiIso(cand),
    days_until,
    days_since: state === 'today' || state === 'recent' ? days_since : null,
    state,
  };
}

/**
 * 生日列表：按距离下一次生日的天数升序，最多 4 条。
 * 入参可以是单个游戏的生日记录数组，也可以是整本生日簿（会合并所有游戏）。
 * 没有数据 → 返回 []（绝不补占位）。
 */
export function birthdayItems(
  book: BirthdayBook | BirthdayRecord[] | null | undefined,
  now: number = Date.now(),
  limit: number = MAX_BIRTHDAYS,
): BirthdayItem[] {
  if (!book) return [];
  const records: BirthdayRecord[] = Array.isArray(book) ? book : Object.values(book).flat();
  const out: BirthdayItem[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (!rec?.character || !isValidMonthDay(rec.month_day)) continue;
    const key = rec.character + '|' + rec.month_day;
    if (seen.has(key)) continue;
    const next = nextBirthday(rec.month_day, now);
    if (!next) continue;
    seen.add(key);
    out.push({
      character: rec.character,
      month_day: rec.month_day,
      next_at: next.next_at,
      days_until: next.days_until,
      days_since: next.days_since,
      state: next.state,
      url: rec.url ?? null,
      source: rec.source ?? 'official',
    });
  }
  // 相关度优先：今天 / 30 天内 → 过去 30 天内 → 其余按下一次生日天数
  const group = (b: BirthdayItem): number => {
    if (b.state === 'today' || b.state === 'upcoming') return 0;
    if (b.state === 'recent') return 1;
    return 2;
  };
  out.sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) return (a.days_since ?? 0) - (b.days_since ?? 0);
    return a.days_until - b.days_until || a.month_day.localeCompare(b.month_day) || a.character.localeCompare(b.character);
  });
  return out.slice(0, limit);
}
