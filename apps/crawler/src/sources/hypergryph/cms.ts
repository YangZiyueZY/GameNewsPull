// 鹰角官方 CMS 信源适配器（tier L0）：终末地 + 明日方舟。
//
// 数据源：https://web-news.hypergryph.com/api/bulletin（列表）+ /api/bulletin/<cid>（正文）。
// 关键约束（踩过的坑，别改）：
//   1) 请求**不要带 Origin 头**——外站 Origin 会被服务端 403（sources/http.ts 的 fetchText 只带 UA）；
//   2) 公告是「头图 + 正文」，池名/UP 只在正文文本里，头图不解析（OCR 不属本适配器职责）；
//   3) 时间写作「服务器时间」（= UTC+8）或相对表述（「版本更新后」「版本更新维护前」），
//      相对表述用同版本「版本更新说明」里的「更新维护时间」锚定；锚不到就 null，绝不猜（契约 q3/q4）；
//   4) 终末地正文里「全部可能出现的6星干员包括：A/B/C…」是**噪声名单**（不是 UP），
//      所以抽 UP 前必须先截断到「全部可能出现的」之前——否则会把明河这类常驻名单成员误当 UP。
//
// 缓存：整包（列表 + 需要的详情）落 data/source-cache/hypergryph-cms-<game>.json，
// 离线（ctx.offline）时只读它，保证测试不联网。

import type { PoolCandidate, PoolType, SourceAdapter, SourceContext } from '../../pools/types.ts';
import { fetchJson, stripHtml, withSourceCache } from '../http.ts';

// —————————————— 时区工具（本文件自足；全部走 Date.UTC，禁止依赖进程时区）——————————————

const CST_OFFSET_MS = 8 * 3_600_000;
const HOUR_MS = 3_600_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch ms → 东八区 ISO（`+08:00`） */
export function cstIsoFromMs(ms: number): string {
  const d = new Date(ms + CST_OFFSET_MS);
  return (
    d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '+08:00'
  );
}

/** 东八区墙上时间（月份从 1 开始）→ ISO；先按 UTC 组装再减 8h，与进程时区无关 */
export function cstIso(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return cstIsoFromMs(Date.UTC(y, mo - 1, d, h, mi, 0) - CST_OFFSET_MS);
}

/** epoch ms 的东八区年月（用于从公告发布时间推导「无年份」日期的年份） */
function cstYearMonth(ms: number): { y: number; mo: number } {
  const d = new Date(ms + CST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 };
}

interface DateFrag {
  /** 公告里显式写了年份才非 null */
  y: number | null;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** 抓文本里所有「YYYY/MM/DD HH:mm」或「MM月DD日 HH:mm」片段（日期分隔符 2026/11/25 与 11月25日 都吃） */
const DATE_FRAG_RE = /(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2}))?/g;

function collectDateFrags(text: string): DateFrag[] {
  const out: DateFrag[] = [];
  DATE_FRAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_FRAG_RE.exec(text)) !== null) {
    out.push({
      y: m[1] ? Number(m[1]) : null,
      mo: Number(m[2]),
      d: Number(m[3]),
      h: m[4] ? Number(m[4]) : 0,
      mi: m[5] ? Number(m[5]) : 0,
    });
  }
  return out;
}

/** 把单个时间片段按公告发布时间补年份：公告在年末、活动在年初时 +1 年 */
function fragToMs(frag: DateFrag, refMs: number): number {
  const ref = cstYearMonth(refMs);
  let y = frag.y ?? ref.y;
  if (frag.y === null && frag.mo - ref.mo < -6) y += 1;
  return Date.parse(cstIso(y, frag.mo, frag.d, frag.h, frag.mi));
}

/** 用「空格包围的 - / ~」切起止；日期里的连字符不带空格，所以不会被误切 */
function splitRange(line: string): [string, string] | null {
  const m = line.match(/^(.*?)\s+[-~～]\s+(.*)$/);
  if (m) return [m[1], m[2]];
  const m2 = line.match(/^(.*?)[~～](.*)$/);
  if (m2) return [m2[1], m2[2]];
  return null;
}

// —————————————— 公告数据形状 ——————————————

interface CmsListItem {
  cid: string;
  title: string;
  displayTime: number;
  tab?: string;
}

/** 列表接口响应（只保留用到的字段；缓存里存的是真实响应裁剪） */
interface CmsBundle {
  code: string;
  list: CmsListItem[];
  /** cid → 详情接口原始响应（详情正文在 data.data） */
  details: Record<string, unknown>;
}

const BULLETIN_API = 'https://web-news.hypergryph.com/api/bulletin';
const MAX_LIST_ITEMS = 60;
const MAX_DETAIL_FETCH = 12;
const MAX_ANCHOR_FETCH = 4;
const EVIDENCE_MAX = 240;

/** 卡片标题命中这些词才值得拉详情（其余公告与卡池无关） */
const POOL_TITLE_RE = /寻访|申领/;
/** 版本更新 / 维护公告：给「版本更新后」「维护前」提供锚点 */
const ANCHOR_TITLE_RE = /版本更新说明|版本更新预告|更新维护|停机维护/;

interface NoticeMeta {
  cid: string;
  title: string;
  displayTime: number;
  gameKey: string;
  code: string;
}

function detailData(resp: unknown): any {
  const root = resp as any;
  return root?.data ?? root ?? {};
}

/** 详情正文 HTML（真实响应里正文在 data.data；兼容字符串/嵌套对象两种形态） */
function detailHtml(resp: unknown): string {
  const d = detailData(resp);
  if (typeof d === 'string') return d;
  if (typeof d?.data === 'string') return d.data;
  if (typeof d?.content === 'string') return d.content;
  return '';
}

function noticeMeta(resp: unknown, fallback: CmsListItem, gameKey: string, code: string): NoticeMeta {
  const d = detailData(resp);
  return {
    cid: String(d?.cid ?? fallback.cid),
    title: String(d?.title ?? fallback.title ?? '').trim(),
    displayTime: Number(d?.displayTime ?? fallback.displayTime ?? 0) * 1000,
    gameKey,
    code,
  };
}

// —————————————— 版本更新维护锚点 ——————————————

/** 「更新维护时间」锚点：终末地是 2026/11/25 06:00，明日方舟是 2026年11月01日06:00 */
interface VersionAnchor {
  versionName: string | null;
  /** 维护开始时刻（epoch ms）——相对表述统一按它锚定 */
  maintenanceMs: number;
  /** 公告发布时间（epoch ms），用于「取下一次维护」 */
  displayMs: number;
}

function parseMaintenanceMs(text: string): number | null {
  const slash = text.match(/更新维护时间[\s\S]{0,24}?(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (slash) return Date.parse(cstIso(+slash[1], +slash[2], +slash[3], +slash[4], +slash[5]));
  const cn = text.match(/(?:更新)?维护时间[：:\s]*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (cn) return Date.parse(cstIso(+cn[1], +cn[2], +cn[3], +cn[4], +cn[5]));
  return null;
}

/** 从标题里取版本名：『「穿越甚大蘑境与你相逢」版本更新说明』→ 穿越甚大蘑境与你相逢 */
function versionNameOf(title: string): string | null {
  const m = title.match(/「([^」]{2,40})」\s*版本更新/);
  return m ? m[1] : null;
}

/**
 * 给相对表述挑锚点：
 * - 文案点名了版本（「X」版本更新后）→ 用该版本维护公告的「更新维护时间」；
 * - 没点名 → 取发布之后最近的一次维护（「更新后」与「维护前」都以同一次维护为界）。
 * 找不到返回 null（调用方把时间置 null，不猜）。
 */
function pickAnchor(sideText: string, anchors: VersionAnchor[], bannerMs: number): VersionAnchor | null {
  const named = sideText.match(/「([^」]{2,40})」\s*版本更新/);
  if (named) {
    const hit = anchors.find((a) => a.versionName && (a.versionName.includes(named[1]) || named[1].includes(a.versionName)));
    if (hit) return hit;
  }
  const later = anchors
    .filter((a) => a.displayMs >= bannerMs - 12 * HOUR_MS && Number.isFinite(a.maintenanceMs))
    .sort((a, b) => a.maintenanceMs - b.maintenanceMs);
  return later[0] ?? null;
}

const RELATIVE_AFTER_RE = /版本更新后|版本更新维护后|更新后|开服后|维护后|更新完成后/;
const RELATIVE_BEFORE_RE = /更新维护前|版本更新前|维护前|更新前/;

interface ParsedRange {
  start_at: string | null;
  end_at: string | null;
  /** 用到锚点时的说明（写进 note，便于回溯为什么是这个时刻） */
  anchorNote: string | null;
}

/** 解析「开放时间 / 活动时间」整行：两侧各自可以是绝对时间，也可以是相对表述 */
export function parseNoticeRange(line: string, refMs: number, anchors: VersionAnchor[]): ParsedRange {
  const sides = splitRange(line);
  if (!sides) return { start_at: null, end_at: null, anchorNote: null };

  let anchoredAt: number | null = null;
  const resolveSide = (side: string): string | null => {
    const frags = collectDateFrags(side);
    if (frags.length) return cstIsoFromMs(fragToMs(frags[0], refMs));
    if (!RELATIVE_AFTER_RE.test(side) && !RELATIVE_BEFORE_RE.test(side)) return null;
    const anchor = pickAnchor(side, anchors, refMs);
    if (!anchor) return null;
    anchoredAt = anchor.maintenanceMs;
    return cstIsoFromMs(anchor.maintenanceMs);
  };

  const start = resolveSide(sides[0]);
  const end = resolveSide(sides[1]);
  // 起止都拿到且顺序反了（跨年且年份没补上）→ 结束时间顺延一年，仍是真实日历而非猜测
  let fixedEnd = end;
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    const nextYear = cstIsoFromMs(Date.parse(end) + 365 * 24 * HOUR_MS);
    if (Date.parse(nextYear) > Date.parse(start)) fixedEnd = nextYear;
  }
  return {
    start_at: start,
    end_at: fixedEnd,
    anchorNote: anchoredAt === null ? null : cstIsoFromMs(anchoredAt),
  };
}

/** 在一段正文里找「开放时间 / 活动时间 / 寻访时间」这一行（相对表述的池公告常只写「▼//开放时间」+ 下一行） */
function findRangeLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const explicit = lines.find((l) => /^(?:[·•\-]\s*)?(?:开放时间|寻访时间|活动时间|开放期间)[：:]/.test(l));
  if (explicit) {
    const idx = lines.indexOf(explicit);
    const same = explicit.replace(/^[^：:]*[：:]\s*/, '');
    // 「开放时间：」后面直接换行的情况，拼上下一行
    if (!same || !splitRange(same)) return explicit + (lines[idx + 1] ? ' ' + lines[idx + 1] : '');
    return explicit;
  }
  const relative = lines.find((l) => (RELATIVE_AFTER_RE.test(l) || RELATIVE_BEFORE_RE.test(l)) && splitRange(l) !== null);
  return relative ?? null;
}

// —————————————— 终末地：池名 / 类型 / UP ——————————————

interface EndfieldPoolSpec {
  name: string;
  type: PoolType;
  /** 期次标签，如「重构寻访1」 */
  period: string | null;
  keyword: string;
}

/** 池类型关键词：长的在前，「重构寻访」不能被「寻访」截断 */
const POOL_KEYWORD_RE = /^(特许寻访|重构寻访|重构申领|限定寻访|申领)(\d*)/;
const BRACKET_RE = /「([^」]{1,40})」/g;

/**
 * 标题里的池名 + 类型关键词；一个公告可能同时开两个池（重构寻访 + 重构申领）。
 * 两种写法都认：
 *   「锻砧、行囊与蜜糖」特许寻访说明   → 关键词在「」之后；
 *   「月映申领」限时特卖说明           → 关键词在「」之内（池名要把关键词切掉）。
 */
export function endfieldPoolSpecs(title: string): EndfieldPoolSpec[] {
  const specs: EndfieldPoolSpec[] = [];
  const seen = new Set<string>();
  const push = (name: string, keyword: string, digit: string) => {
    const key = name + '|' + keyword + digit;
    if (!name || seen.has(key)) return;
    seen.add(key);
    // 「申领」= 武器池（申领券池）；「重构寻访N」= 复刻角色池；「特许寻访」= 限定角色池
    const type: PoolType = keyword.includes('申领')
      ? 'weapon'
      : keyword.startsWith('重构')
        ? 'rerun_character'
        : 'limited_character';
    specs.push({ name, type, period: digit ? keyword + digit : keyword, keyword });
  };
  BRACKET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_RE.exec(title)) !== null) {
    const bracketName = m[1].trim();
    const afterBracket = title.slice(m.index + m[0].length, m.index + m[0].length + 10);
    const outside = afterBracket.match(/^\s*(特许寻访|重构寻访|重构申领|限定寻访|申领)(\d*)/);
    if (outside) {
      push(bracketName, outside[1], outside[2]);
      continue;
    }
    const inside = bracketName.match(/^(.*?)(特许寻访|重构寻访|重构申领|限定寻访|申领)(\d*)$/);
    if (inside) push(inside[1].trim(), inside[2], inside[3]);
  }
  return specs;
}

/** 截到标记之前（「全部可能出现的」之后是常驻名单，不是 UP） */
function cutAt(text: string, marker: string): string {
  const i = text.indexOf(marker);
  return i < 0 ? text : text.slice(0, i);
}

/** 取「▼//「池名」…」到下一个「▼//」之间的这一段（一个公告两个池时靠它分段） */
function sectionFor(text: string, poolName: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('▼//') && l.includes('「' + poolName + '」'));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('▼//')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function dedupeNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = n.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 终末地 UP：只认显式句式
 *   「…概率提升的6星干员为【X】」「6星干员【X】获取概率提升」（武器同理）
 * 绝不用「全部可能出现」名单，也不用「干员试用」这种顺带提到的句子。
 */
export function endfieldRateUpNames(text: string, type: PoolType): string[] {
  const noun = type === 'weapon' ? '武器' : '干员';
  const body = cutAt(text, '全部可能出现的');
  const names: string[] = [];
  const explicit = new RegExp('概率提升的6星' + noun + '为【([^】]{1,24})】', 'g');
  const headline = new RegExp('6星' + noun + '【([^】]{1,24})】\\s*获取概率提升', 'g');
  for (const re of [explicit, headline]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) names.push(m[1]);
  }
  return dedupeNames(names);
}

// —————————————— 明日方舟：池名 / 类型 / UP ——————————————

/** 方舟 UP 行：★★★★★★：A \ B（占6★出率的50%）；5 倍权值行单独收进 note，不当主 UP */
export function arknightsRateUp(text: string): { characters: string[]; weighted: string[] } {
  // 「寻访数据契约交换所」后面也是一堆 ★★★★★★ 行，但那是兑换清单，不是 UP
  const body = text.split(/寻访数据契约交换所/)[0] ?? text;
  const characters: string[] = [];
  const weighted: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^[◆·•※\-]\s*/, '');
    const m = line.match(/^(★{4,6})\s*[：:]\s*(.+)$/);
    if (!m || m[1].length !== 6) continue;
    const tail = m[2];
    const isRateUp = /占6★出率/.test(tail);
    const isWeighted = /权值/.test(tail);
    if (!isRateUp && !isWeighted) continue;
    // 去掉行尾的（占6★出率的50%）之类说明与 [限定] 标注
    const namesPart = tail.replace(/[（(][^）)]*[）)]\s*$/, '');
    const names = namesPart
      .split(/[\\／/、]/)
      .map((s) => s.replace(/\[[^\]]*\]/g, '').trim())
      .filter(Boolean);
    for (const n of names) (isRateUp ? characters : weighted).push(n);
  }
  return { characters: dedupeNames(characters), weighted: dedupeNames(weighted) };
}

/** 方舟池类型：庆典/春节/夏季/周年/欢庆 = fes，复刻 = rerun，常驻标准 = standard，其余新干员池 = limited */
export function arknightsPoolType(title: string, series: string | null): PoolType {
  if (/常驻标准|标准寻访/.test(title)) return 'standard_character';
  if (/复刻/.test(title)) return 'rerun_character';
  if (series && /庆典|春节|夏季|周年|欢庆/.test(series)) return 'fes';
  if (/限定寻访/.test(title)) return 'limited_character';
  return 'limited_character';
}

/** 方舟池名：标题里的【将雪投火】；系列（[限定寻访·庆典]）只作 note */
function arknightsPoolName(title: string): string | null {
  const m = title.match(/【([^】]{1,40})】/);
  return m ? m[1].trim() : null;
}

// —————————————— 组装候选池 ——————————————

function clip(text: string, max = EVIDENCE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function sourceRef(ctx: SourceContext, code: string, cid: string) {
  // 官方公告页（人可读）；API 只做机器读取
  const host = code === 'arknights' ? 'ak.hypergryph.com' : 'endfield.hypergryph.com';
  return {
    id: 'hypergryph-cms',
    tier: 'L0' as const,
    url: 'https://' + host + '/news/' + cid,
    fetched_at: ctx.nowCst,
  };
}

function joinNotes(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => !!p && !!p.trim());
  return kept.length ? kept.join('；') : null;
}

/** 终末地公告 → 候选池（一个公告可能出两个池） */
function endfieldCandidates(meta: NoticeMeta, text: string, anchors: VersionAnchor[], ctx: SourceContext): PoolCandidate[] {
  const specs = endfieldPoolSpecs(meta.title);
  const out: PoolCandidate[] = [];
  for (const spec of specs) {
    const section = sectionFor(text, spec.name) || text;
    // 时间可能写在公告开头的共享段（7201 两池共用一条开放时间），先找本段再退回全文
    const line = findRangeLine(section) ?? findRangeLine(text);
    const range = line ? parseNoticeRange(line, meta.displayTime, anchors) : { start_at: null, end_at: null, anchorNote: null };
    const names = endfieldRateUpNames(section, spec.type);
    const isWeapon = spec.type === 'weapon';
    out.push({
      game_key: 'endfield',
      pool_name: spec.name,
      pool_type: spec.type,
      // 武器池不列角色（契约 §3），武器名放 note 便于人工核对
      characters: isWeapon ? [] : names,
      start_at: range.start_at,
      end_at: range.end_at,
      version: null,
      period: spec.period,
      evidence: clip(section),
      note: joinNotes([
        isWeapon && names.length ? '武器：' + names.join('、') : null,
        range.anchorNote ? '相对时间按同版本「更新维护时间」' + range.anchorNote + '锚定' : null,
      ]),
      source: sourceRef(ctx, meta.code, meta.cid),
    });
  }
  return out;
}

/** 明日方舟公告 → 单个候选池（标题里只有一个池名；没有池名直接放弃） */
function arknightsCandidate(meta: NoticeMeta, text: string, anchors: VersionAnchor[], ctx: SourceContext): PoolCandidate | null {
  const poolName = arknightsPoolName(meta.title);
  if (!poolName) return null;
  const series = (meta.title.match(/^\[([^\]]+)\]/)?.[1] ?? null) as string | null;
  const type = arknightsPoolType(meta.title, series);
  const line = findRangeLine(text);
  const range = line ? parseNoticeRange(line, meta.displayTime, anchors) : { start_at: null, end_at: null, anchorNote: null };
  const up = arknightsRateUp(text);
  return {
    game_key: 'arknights',
    pool_name: poolName,
    pool_type: type,
    characters: type === 'weapon' ? [] : up.characters,
    start_at: range.start_at,
    end_at: range.end_at,
    version: null,
    period: series,
    evidence: clip(text),
    note: joinNotes([
      series ? '系列：' + series : null,
      up.weighted.length ? '5 倍权值：' + up.weighted.join('、') : null,
      range.anchorNote ? '相对时间按同版本「更新维护时间」' + range.anchorNote + '锚定' : null,
    ]),
    source: sourceRef(ctx, meta.code, meta.cid),
  };
}

// —————————————— 抓取（在线）/ 读缓存（离线）——————————————

const GAME_CODES: Array<{ gameKey: string; code: string }> = [
  { gameKey: 'endfield', code: 'endfield_web' },
  { gameKey: 'arknights', code: 'arknights' },
];

/** 缓存 id（离线 fixture 的名字，测试固定用它） */
export function cmsCacheId(code: string): string {
  return 'hypergryph-cms-' + (code === 'endfield_web' ? 'endfield' : 'arknights');
}

async function fetchBulletinList(code: string): Promise<CmsListItem[]> {
  // 不要加 Origin 头：外站 Origin 会被 403
  const resp = await fetchJson<any>(
    BULLETIN_API + '?lang=zh-cn&code=' + encodeURIComponent(code) + '&page=1&pageSize=50',
  );
  const list = Array.isArray(resp?.data?.list) ? resp.data.list : [];
  return list.slice(0, MAX_LIST_ITEMS).map((it: any) => ({
    cid: String(it.cid),
    title: String(it.title ?? ''),
    displayTime: Number(it.displayTime ?? 0),
    tab: it.tab ? String(it.tab) : undefined,
  }));
}

async function fetchDetail(code: string, cid: string): Promise<unknown> {
  return await fetchJson<any>(BULLETIN_API + '/' + encodeURIComponent(cid) + '?lang=zh-cn&code=' + encodeURIComponent(code));
}

/** 在线抓一份整包：列表 + 卡池相关公告详情 + 版本维护公告详情（锚点） */
async function fetchBundle(code: string, ctx: SourceContext): Promise<CmsBundle> {
  const list = await fetchBulletinList(code);
  const details: Record<string, unknown> = {};
  const poolItems = list.filter((it) => POOL_TITLE_RE.test(it.title) && !ANCHOR_TITLE_RE.test(it.title));
  const anchorItems = list.filter((it) => ANCHOR_TITLE_RE.test(it.title));
  for (const it of poolItems.slice(0, MAX_DETAIL_FETCH)) {
    try {
      details[it.cid] = await fetchDetail(code, it.cid);
    } catch (e: any) {
      ctx.log('[hypergryph-cms] 详情抓取失败 cid=' + it.cid + ':', e?.message ?? e);
    }
  }
  for (const it of anchorItems.slice(0, MAX_ANCHOR_FETCH)) {
    try {
      details[it.cid] = await fetchDetail(code, it.cid);
    } catch (e: any) {
      ctx.log('[hypergryph-cms] 维护公告抓取失败 cid=' + it.cid + ':', e?.message ?? e);
    }
  }
  return { code, list, details };
}

function buildAnchors(bundle: CmsBundle, gameKey: string): VersionAnchor[] {
  const anchors: VersionAnchor[] = [];
  for (const item of bundle.list) {
    if (!ANCHOR_TITLE_RE.test(item.title)) continue;
    const resp = bundle.details[item.cid];
    if (!resp) continue;
    const meta = noticeMeta(resp, item, gameKey, bundle.code);
    const text = stripHtml(detailHtml(resp));
    const maintenanceMs = parseMaintenanceMs(text);
    if (!Number.isFinite(maintenanceMs)) continue;
    anchors.push({ versionName: versionNameOf(meta.title), maintenanceMs, displayMs: meta.displayTime });
  }
  return anchors;
}

function parseBundle(bundle: CmsBundle, gameKey: string, ctx: SourceContext): PoolCandidate[] {
  const anchors = buildAnchors(bundle, gameKey);
  if (!anchors.length) {
    ctx.log('[hypergryph-cms] ' + gameKey + ' 无「更新维护时间」锚点，相对时间将置 null');
  }
  const out: PoolCandidate[] = [];
  for (const item of bundle.list) {
    if (ANCHOR_TITLE_RE.test(item.title) && !POOL_TITLE_RE.test(item.title)) continue;
    if (!POOL_TITLE_RE.test(item.title)) continue;
    const resp = bundle.details[item.cid];
    if (!resp) continue;
    const meta = noticeMeta(resp, item, gameKey, bundle.code);
    const text = stripHtml(detailHtml(resp));
    if (!text) continue;
    if (gameKey === 'endfield') out.push(...endfieldCandidates(meta, text, anchors, ctx));
    else {
      const cand = arknightsCandidate(meta, text, anchors, ctx);
      if (cand) out.push(cand);
    }
  }
  return out;
}

export const hypergryphCmsAdapter: SourceAdapter = {
  id: 'hypergryph-cms',
  tier: 'L0',
  label: '鹰角官方公告',
  games: ['endfield', 'arknights'],

  async collect(ctx: SourceContext): Promise<PoolCandidate[]> {
    const out: PoolCandidate[] = [];
    for (const { gameKey, code } of GAME_CODES) {
      // 单个游戏的失败不影响另一个（契约：任一源失败只丢该源）
      try {
        const bundle = await withSourceCache<CmsBundle>(ctx, cmsCacheId(code), () => fetchBundle(code, ctx));
        if (!bundle || !Array.isArray(bundle.list)) {
          ctx.log('[hypergryph-cms] ' + gameKey + ' 无可用数据（离线无缓存 / 网络失败）');
          continue;
        }
        out.push(...parseBundle(bundle, gameKey, ctx));
      } catch (e: any) {
        ctx.log('[hypergryph-cms] ' + gameKey + ' 解析失败:', e?.message ?? e);
      }
    }
    return out;
  },
};

export default hypergryphCmsAdapter;
