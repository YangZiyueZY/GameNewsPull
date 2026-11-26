// 唯一时间源：全站对外时间一律东八区（Asia/Shanghai，CST，UTC+8）。
// 实现只做「epoch ms + 固定偏移 → 用 getUTC* 读字段」，完全不读进程时区：
// 这样 TZ=UTC 与 TZ=America/New_York 下输出一字不差（契约 §1 / 验收 1）。
// 东八区没有夏令时，偏移固定，所以可以直接拼 "+08:00" / "+0800" 后缀。

export const CST_OFFSET = 8 * 60 * 60 * 1000;

/** 放宽入参：调用方手里可能是秒级/毫秒级时间戳、ISO 串或 Date */
export type TimeLike = string | number | Date;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_SUFFIX = '+08:00';
const RFC822_SUFFIX = '+0800';

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 归一化成 epoch ms；解析失败返回 NaN，由各函数统一拦截 */
function toMs(t: TimeLike): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return Date.parse(t);
}

/** 把 epoch ms 平移到东八区钟面：之后用 getUTC* 读到的就是「北京时间」字段 */
const shift = (ms: number): number => ms + CST_OFFSET;

/** 东八区日历日序号（自 1970-01-01 起）；跨日比较只认它，不认毫秒差 */
const dayIndex = (ms: number): number => Math.floor(shift(ms) / DAY_MS);

function requireFinite(ms: number, fn: string): void {
  if (!Number.isFinite(ms)) {
    // 时间源不做「猜一个」的兜底：拿到 NaN/Infinity 说明上游数据坏了，尽早暴露
    throw new RangeError(`[datetime] ${fn} 需要有限的时间，收到无效值`);
  }
}

export interface CstParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
}

/** 拆出东八区日历字段 */
export function cstParts(t: TimeLike): CstParts {
  const ms = toMs(t);
  requireFinite(ms, 'cstParts');
  const d = new Date(shift(ms));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** epoch ms / ISO / Date → "2026-11-24T12:00:00+08:00"（秒级精度，与契约示例一致） */
export function toCstIso(t: TimeLike): string {
  const ms = toMs(t);
  requireFinite(ms, 'toCstIso');
  // 先截到整秒再拆字段，避免 .999 被进位成下一秒
  const p = cstParts(Math.floor(ms / 1000) * 1000);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${ISO_SUFFIX}`;
}

/** 当前时间（或调用方注入的时刻）的东八区 ISO */
export function nowCstIso(t: TimeLike = Date.now()): string {
  return toCstIso(t);
}

/** 东八区日历日键 "YYYY-MM-DD"（做去重/分组时用） */
export function cstDayKey(t: TimeLike): string {
  const p = cstParts(t);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * 按**东八区日历日**算差：返回 to − from（整数，可为负）。
 * 例：23:00 → 次日 01:00 = 1 天（只差 2 小时），不是 0 天也不是 0.08 天。
 */
export function cstDayDiff(from: TimeLike, to: TimeLike): number {
  const a = toMs(from);
  const b = toMs(to);
  requireFinite(a, 'cstDayDiff');
  requireFinite(b, 'cstDayDiff');
  return dayIndex(b) - dayIndex(a);
}

/** 该时刻所在东八区日历日的 00:00:00（epoch ms） */
export function cstDayStart(t: TimeLike): number {
  const ms = toMs(t);
  requireFinite(ms, 'cstDayStart');
  return dayIndex(ms) * DAY_MS - CST_OFFSET;
}

/** 用东八区钟面字段构造 epoch ms（显式偏移，不经过 Date 的本地时区解析） */
export function fromCstParts(year: number, month: number, day: number, hour: number = 0, minute: number = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - CST_OFFSET;
}

/** RSS / HTTP 用的 RFC 822 时间：`Tue, 24 Nov 2026 12:00:00 +0800` */
export function rfc822Cst(t: TimeLike): string {
  const ms = toMs(t);
  requireFinite(ms, 'rfc822Cst');
  const p = cstParts(ms);
  const day = EN_DAYS[p.weekday] ?? 'Sun';
  const month = EN_MONTHS[p.month - 1] ?? 'Jan';
  return `${day}, ${pad2(p.day)} ${month} ${p.year} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${RFC822_SUFFIX}`;
}

/** 校验并输出东八区 ISO；越界（如 2 月 30 日）返回 null，绝不让 Date 静默进位 */
function buildCstIso(year: number, month: number, day: number, hour: number, minute: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const ms = fromCstParts(year, month, day, hour, minute);
  const p = cstParts(ms);
  if (p.year !== year || p.month !== month || p.day !== day || p.hour !== hour || p.minute !== minute) return null;
  return toCstIso(ms);
}

/**
 * 解析「2026年11月4日 12:00」「11月4日」这类中文日期，显式按 +08:00 构造。
 * 年份缺失时用 refYear（默认取当前东八区年份），避免跨年公告被解析成上一年。
 */
export function parseCnDateCst(text: string, refYear?: number): string | null {
  if (!text) return null;
  const full = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/);
  if (full) {
    return buildCstIso(Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4] ?? 0), Number(full[5] ?? 0));
  }
  const short = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!short) return null;
  const year = refYear ?? cstParts(Date.now()).year;
  return buildCstIso(year, Number(short[1]), Number(short[2]), Number(short[3] ?? 0), Number(short[4] ?? 0));
}

/** 旧导出名（normalize.ts 等调用方仍在用）：秒级时间戳 → 东八区 ISO */
export function tsToIso(ts: string | number): string {
  const n = Number(ts);
  // B 站接口给的是秒级时间戳；非法值退回当前时间（保持旧行为，抓取流程不中断）
  return Number.isFinite(n) ? toCstIso(n * 1000) : nowCstIso();
}

/** 旧导出名：中文日期 → 东八区 ISO（年份缺失用当前年） */
export function cnDateToIso(text: string): string | null {
  return parseCnDateCst(text);
}
