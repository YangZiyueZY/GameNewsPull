// B 站官方动态正文卡池适配器（id: bili-dynamics，tier L0，games: ['azurpromilia','wutheringwaves','bluearchive','hsr']）。
// 数据来源是本地 data/store.json 里的 dynamics（抓取层已落盘的 raw JSON），不再发网络请求：
//   正文 = module_dynamic.desc.text 与 module_dynamic.major.opus.summary.text 的拼接。
// 解析口径（按游戏句式）：
//   · 蓝色星原：「弦定观测「池名」」+「观测时间 2026年11月26日开服后 - 2026年12月17日 03:59（UTC+8）」
//       +「限定五星角色「涂山小玉（猛攻·风&光）」」→ limited_character；「开服后」相对起点 → start_at=null 并在 note 留痕。
//   · 鸣潮：「[池名]角色活动唤取」「[A]、[B]角色活动唤取」「「武器」武器活动唤取」+「活动时间 … ~ 2026年12月3日09:59」；
//       武器池 → weapon 且 characters=[]；角色名只取「5星角色「X」」且必须出现在「概率限时提升」句子里。
//   · 蔚蓝档案：「限时（复刻）招募【池名】」+「3★…成员"纱织（泳装）"」+「招募时间 11月X日 维护结束后 ~ 11月Y日 13:59」；
//       含「复刻」→ rerun_character。
//   · 星穹铁道：「4.7版本活动跃迁（其一）」+「限定5星角色「…」…跃迁时间为 2026/11/11 4.7版本更新后 - 2026/12/22 15:00」；
//       也支持「活动跃迁：A、B」+「活动时间 … 4.7版本更新后 ~ 2026-12-02 03:59」版式。
// 时间：无年份日期用该动态 published_at 的年份补全并显式按 +08:00 构造；「维护结束后 / 开服后 / 版本更新后」一律 null + note。
// 绝不编造：句式不匹配 → 该条动态不产出候选。
import fs from 'node:fs';
import path from 'node:path';
import type { PoolCandidate, PoolType, SourceAdapter, SourceContext } from '../pools/types.ts';

export const BILI_GAMES = ['azurpromilia', 'genshin', 'wutheringwaves', 'bluearchive', 'hsr', 'yh', 'zzz'];
const SOURCE_ID = 'bili-dynamics';
const CST_OFFSET_MS = 8 * 3_600_000;
/** 每个游戏最多产出的候选数 */
const MAX_PER_GAME = 8;

/** epoch ms → 东八区 ISO（+08:00） */
function cstIso(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/** 按给定时区（默认 +8）钟面时间构造东八区 ISO */
function cstFromParts(y: number, mo: number, d: number, h = 0, mi = 0, offsetHours = 8): string {
  return cstIso(Date.UTC(y, mo - 1, d, h, mi) - offsetHours * 3_600_000);
}

/** 动态 published_at（Z）在东八区的年、月 */
function cstYearMonth(iso: string): { y: number; mo: number } {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    const now = cstIso(Date.now());
    return { y: Number(now.slice(0, 4)), mo: Number(now.slice(5, 7)) };
  }
  const s = cstIso(t);
  return { y: Number(s.slice(0, 4)), mo: Number(s.slice(5, 7)) };
}

/** 无年份日期补年：月份小于参照月视为跨年 */
function pickYear(month: number, ref: { y: number; mo: number }): number {
  return month < ref.mo ? ref.y + 1 : ref.y;
}

/** 去掉角色名后面的括号属性说明：涂山小玉（猛攻·风&光）→ 涂山小玉；星神★阿哈（欢愉•量子）→ 星神★阿哈 */
export function cleanCharacterName(raw: string): string {
  const name = raw
    .replace(/[（(][^（()）]*[)）]\s*$/, '')
    .replace(/^[「『【\[]+/, '')
    .replace(/[」』】\]]+$/, '')
    .trim();
  return name;
}

/** 噪声串黑名单：这些不是角色名（契约 §3 守卫：禁止把「全部可能出现」这类串当角色） */
const NOISE_RE = /(全部可能|可能出现|概率|包括|请前往|更多详情|获取途径|不在本|以下)/;

function isNameLike(name: string): boolean {
  if (!name) return false;
  if (name.length < 1 || name.length > 20) return false;
  if (NOISE_RE.test(name)) return false;
  return true;
}

interface ParseMeta {
  id: string;
  gameKey: string;
  publishedAt: string;
  url?: string | null;
  fetchedAt?: string;
}

function sourceRef(meta: ParseMeta, url?: string | null) {
  return {
    id: SOURCE_ID,
    tier: 'L0' as const,
    url: url ?? meta.url ?? null,
    fetched_at: meta.fetchedAt ?? null,
  };
}

/** 从 store.json 的 raw 字段抽正文（desc.text + opus.summary.text） */
export function dynamicTextFromRaw(raw: string): string {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const d = j?.modules?.module_dynamic;
    const parts = [d?.desc?.text, d?.major?.opus?.summary?.text].filter((x: unknown) => typeof x === 'string' && x.length > 0);
    return parts.join('\n');
  } catch {
    return '';
  }
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 区间拆分：「A - B」「A ~ B」 */
function splitRange(text: string): { left: string; right: string } | null {
  const m = text.match(/^(.*?)(?:[~～]|\s[-—]\s)(.*)$/);
  if (!m) return null;
  const left = m[1].trim();
  const right = m[2].trim();
  if (!left || !right) return null;
  return { left: left, right: right };
}

const RELATIVE_START_RE = /(开服后|版本更新后|更新维护后|维护结束后|维护后|配信後|メンテナンス後)/;

// ————————————————————————— 蓝色星原：弦定观测 —————————————————————————

const PROMILIA_TIME_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\n~～\-]{0,8}[-~～]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/;

export function parseAzurpromiliaText(text: string, meta: ParseMeta): PoolCandidate[] {
  const pools: string[] = [];
  for (const m of text.matchAll(/弦定观测「([^」]{1,30})」/g)) {
    const name = m[1].trim();
    if (name && pools.indexOf(name) < 0) pools.push(name);
  }
  if (pools.length === 0) return [];
  const chars: string[] = [];
  for (const m of text.matchAll(/限定五星角色「([^」]{1,30})」/g)) {
    const name = cleanCharacterName(m[1]);
    if (isNameLike(name) && chars.indexOf(name) < 0) chars.push(name);
  }
  const timeMatch = text.match(PROMILIA_TIME_RE);
  const rangeLine = (text.match(/观测时间[^\n]*\n?([^\n]*)/) ?? [])[1] ?? '';
  const startRelative = RELATIVE_START_RE.test(rangeLine) || RELATIVE_START_RE.test(text.slice(0, (timeMatch?.index ?? 0) + 1));
  const end = timeMatch
    ? cstFromParts(+timeMatch[4], +timeMatch[5], +timeMatch[6], +timeMatch[7], +timeMatch[8])
    : null;
  const noteParts = ['观测时间原文 ' + (rangeLine.trim() || '未找到')];
  if (startRelative) noteParts.push('起点为「开服后」等相对表述，start_at=null');

  return pools.map((name) => ({
    game_key: 'azurpromilia',
    pool_name: name,
    pool_type: 'limited_character' as PoolType,
    characters: chars.slice(0, 2),
    start_at: null,
    end_at: end,
    version: null,
    period: null,
    evidence: rangeLine.trim().slice(0, 200),
    note: noteParts.join('；'),
    source: sourceRef(meta),
  }));
}

// ————————————————————————— 鸣潮：活动唤取 —————————————————————————

interface PoolToken {
  name: string;
  suffix: string;
}

/** 扫描一行里的「池名 + 唤取类型」（列表式优先） */
export function scanKuroTokens(line: string): PoolToken[] {
  const tokens: PoolToken[] = [];
  const taken: Array<[number, number]> = [];
  const listRe = /((?:[\[<][^\[\]<>]{1,40}[\]>]\s*(?:、|,|，|和|与)?\s*)+)(角色活动唤取|武器活动唤取|忆旅唤取)/g;
  for (const m of line.matchAll(listRe)) {
    const idx = m.index ?? 0;
    for (const n of m[1].matchAll(/[\[<]([^\[\]<>]{1,40})[\]>]/g)) {
      const name = n[1].trim();
      if (name) tokens.push({ name: name, suffix: m[2] });
    }
    taken.push([idx, idx + m[0].length]);
  }
  const quotedListRe = /((?:「[^「」]{1,40}」\s*(?:、|,|，|和|与)?\s*)+)(角色活动唤取|武器活动唤取|忆旅唤取)/g;
  for (const m of line.matchAll(quotedListRe)) {
    const idx = m.index ?? 0;
    for (const n of m[1].matchAll(/「([^「」]{1,40})」/g)) {
      const name = n[1].trim();
      if (name) tokens.push({ name: name, suffix: m[2] });
    }
    taken.push([idx, idx + m[0].length]);
  }
  const singleRe = /(?:[\[<]([^\[\]<>]{1,40})[\]>]|「([^「」]{1,40})」)\s*(角色活动唤取|武器活动唤取|忆旅唤取)/g;
  for (const m of line.matchAll(singleRe)) {
    const idx = m.index ?? 0;
    if (taken.some((r) => idx >= r[0] && idx < r[1])) continue;
    const name = (m[1] ?? m[2] ?? '').trim();
    if (!name || name.indexOf('/') >= 0 || name.indexOf('唤取') >= 0) continue;
    tokens.push({ name: name, suffix: m[3] });
  }
  return tokens;
}

export function parseKuroDynamicText(text: string, meta: ParseMeta): PoolCandidate[] {
  const lines = nonEmptyLines(text);
  const plain = lines.join('\n');
  const version = (plain.match(/(\d+\.\d+)\s*版本/))?.[1] ?? null;
  const periodMatch = plain.match(/活动唤取[・·]\s*第([一二三四五六七八九十百\d]+)\s*期/);
  const period = periodMatch ? '第' + periodMatch[1] + '期' : null;

  // 活动时间区间
  let startAbs: string | null = null;
  let endAbs: string | null = null;
  let timeRaw = '';
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(/(活动时间|开放时间|唤取时间)/);
    if (!label) continue;
    const from = (label.index ?? 0) + label[0].length;
    const candidates = [lines[i].slice(from), lines[i + 1] ?? ''];
    for (const raw of candidates) {
      const cleaned = raw.replace(/^[✦\s:：]+/, '').replace(/[（(]\s*服务器时间\s*[）)]/g, '').trim();
      const pair = splitRange(cleaned);
      if (!pair) continue;
      if (!/\d{1,2}\s*[:：]\s*\d{2}/.test(pair.right)) continue;
      timeRaw = pair.left + ' ~ ' + pair.right;
      const endMatch = pair.right.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
      if (endMatch) endAbs = cstFromParts(+endMatch[1], +endMatch[2], +endMatch[3], +endMatch[4], +endMatch[5]);
      const startMatch = pair.left.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
      if (startMatch && !RELATIVE_START_RE.test(pair.left)) {
        startAbs = cstFromParts(+startMatch[1], +startMatch[2], +startMatch[3], +startMatch[4], +startMatch[5]);
      }
      break;
    }
    if (timeRaw) break;
  }

  // 5星角色：必须出现在「概率限时提升 / 概率UP」句子里
  const upChars: string[] = [];
  for (const line of lines) {
    if (!/(概率限时提升|概率UP|概率提升)/.test(line)) continue;
    for (const m of line.matchAll(/5星(?:角色|共鸣者)「([^」]{1,20})」/g)) {
      const name = cleanCharacterName(m[1]);
      if (isNameLike(name) && upChars.indexOf(name) < 0) upChars.push(name);
    }
  }

  const out: PoolCandidate[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const token of scanKuroTokens(line)) {
      const key = token.suffix + '|' + token.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const isWeapon = token.suffix.indexOf('武器') >= 0;
      const noteParts: string[] = ['动态 ' + meta.id];
      if (timeRaw) noteParts.push('活动时间原文 ' + timeRaw);
      if (timeRaw && startAbs === null) noteParts.push('起点为「版本更新后」等相对表述，start_at=null');
      if (!timeRaw) noteParts.push('未找到活动时间，起止均为 null');
      const poolType: PoolType = isWeapon ? 'weapon' : token.suffix.indexOf('忆旅') >= 0 ? 'rerun_character' : 'limited_character';
      out.push({
        game_key: 'wutheringwaves',
        pool_name: token.name,
        pool_type: poolType,
        characters: isWeapon ? [] : upChars.slice(0, 1),
        start_at: startAbs,
        end_at: endAbs,
        version: version,
        period: period,
        evidence: (timeRaw || line).slice(0, 200),
        note: noteParts.join('；'),
        source: sourceRef(meta),
      });
    }
  }
  return out;
}

// ————————————————————————— 蔚蓝档案：限时招募 —————————————————————————

const BA_TIME_RE = /招募时间\s*(\d{1,2})月(\d{1,2})日\s*([^\n~～]*?)\s*[~～]\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/;

export function parseBlueArchiveText(text: string, meta: ParseMeta): PoolCandidate[] {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const timeMatch = flat.match(BA_TIME_RE);
  const ref = cstYearMonth(meta.publishedAt);
  let startAbs: string | null = null;
  let endAbs: string | null = null;
  let noteParts: string[] = ['动态 ' + meta.id];
  if (timeMatch) {
    const startSide = timeMatch[3].trim();
    const sm = startSide.match(/(\d{1,2}):(\d{2})/);
    if (sm && !RELATIVE_START_RE.test(startSide)) {
      const mo = +timeMatch[1];
      startAbs = cstFromParts(pickYear(mo, ref), mo, +timeMatch[2], +sm[1], +sm[2]);
    } else if (/维护结束后|维护后/.test(startSide)) {
      // 「11月26日 维护结束后」：日维护通常在 14:00 左右结束（国服活动公告口径），按当日 14:00 近似
      const mo = +timeMatch[1];
      startAbs = cstFromParts(pickYear(mo, ref), mo, +timeMatch[2], 14, 0);
      noteParts.push('起点按「维护结束后」当日 14:00 近似');
    } else {
      noteParts.push('起点原文「' + (startSide || '维护结束后') + '」，start_at=null');
    }
    const emo = +timeMatch[4];
    endAbs = cstFromParts(pickYear(emo, ref), emo, +timeMatch[5], +timeMatch[6], +timeMatch[7]);
    noteParts.push('招募时间原文 ' + timeMatch[0].replace(/\s+/g, ' '));
  } else {
    // 没有招募时间就无法判断期次状态，宁可不出（避免「时间待公布」的空卡）
    return [];
  }

  const heads: Array<{ index: number; kind: string; name: string }> = [];
  const headRe = /(限时[^\n【]{0,10}?招募)【([^】]{1,30})】/g;
  for (const m of flat.matchAll(headRe)) {
    const name = m[2].trim();
    // 只认中文池名：英文标题（如「Amiable, Advisor, Analytica！」）不是国服招募名，直接剔除
    if (!/[\u4e00-\u9fa5]/.test(name)) continue;
    heads.push({ index: m.index ?? 0, kind: m[1], name });
  }
  if (heads.length === 0) return [];

  const out: PoolCandidate[] = [];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].index : flat.length;
    const section = flat.slice(head.index, end);
    const chars: string[] = [];
    for (const m of section.matchAll(/3★[^\n，。]{0,12}?["“]([^"”]{1,20})["”]/g)) {
      const name = cleanCharacterName(m[1]);
      if (isNameLike(name) && chars.indexOf(name) < 0) chars.push(name);
    }
    const isRerun = /复刻/.test(head.kind) || /复刻/.test(section);
    out.push({
      game_key: 'bluearchive',
      pool_name: head.name,
      pool_type: isRerun ? 'rerun_character' : 'limited_character',
      characters: chars.slice(0, 1),
      start_at: startAbs,
      end_at: endAbs,
      version: null,
      period: null,
      evidence: section.slice(0, 200),
      note: noteParts.join('；'),
      source: sourceRef(meta),
    });
  }
  return out;
}

// ————————————————————————— 星穹铁道：活动跃迁 —————————————————————————

const HSR_TIME_RE = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*(\d{1,2}):(\d{2})/g;

export function parseHsrText(text: string, meta: ParseMeta): PoolCandidate[] {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const version = (flat.match(/(\d+\.\d+)\s*版本活动跃迁/))?.[1] ?? (flat.match(/(\d+\.\d+)\s*版本/))?.[1] ?? null;
  const phase = (flat.match(/(\d+\.\d+)\s*版本活动跃迁[（(]([^）)]{1,10})[）)]/))?.[2] ?? null;
  const out: PoolCandidate[] = [];
  const noteBase = '动态 ' + meta.id + (version ? '；版本 ' + version : '');

  // 版式 A：多次「跃迁时间为 <起> - <止>」，每次对应一组限定5星角色
  const anchors: Array<{ index: number; text: string }> = [];
  for (const m of flat.matchAll(/跃迁时间为/g)) anchors.push({ index: m.index ?? 0, text: m[0] });
  if (anchors.length > 0) {
    let prevAnchor = 0;
    for (const anchor of anchors) {
      const windowText = flat.slice(anchor.index, anchor.index + 160);
      const dates = [...windowText.matchAll(HSR_TIME_RE)];
      if (dates.length === 0) continue;
      const endD = dates[dates.length - 1];
      const endAbs = cstFromParts(+endD[1], +endD[2], +endD[3], +endD[4], +endD[5]);
      // 角色只取「上一个跃迁时间锚点 → 本锚点」之间出现的限定5星角色
      const beforeWindow = flat.slice(prevAnchor, anchor.index);
      const chars: string[] = [];
      for (const m of beforeWindow.matchAll(/限定5星角色「([^」]{1,30})」/g)) {
        const name = cleanCharacterName(m[1]);
        if (isNameLike(name) && chars.indexOf(name) < 0) chars.push(name);
      }
      prevAnchor = anchor.index + 5;
      const startSide = windowText.slice(0, windowText.indexOf('-') > 0 ? windowText.indexOf('-') : windowText.length);
      const startRelative = RELATIVE_START_RE.test(startSide);
      const startAbs = !startRelative && dates.length > 1
        ? cstFromParts(+dates[0][1], +dates[0][2], +dates[0][3], +dates[0][4], +dates[0][5])
        : null;
      if (chars.length === 0) continue;
      const noteParts = [noteBase];
      if (startRelative) noteParts.push('起点为「版本更新后」等相对表述，start_at=null');
      out.push({
        game_key: 'hsr',
        pool_name: chars.join('、'),
        pool_type: 'limited_character',
        characters: chars.slice(0, 2),
        start_at: startAbs,
        end_at: endAbs,
        version: version,
        period: phase,
        evidence: windowText.slice(0, 200),
        note: noteParts.join('；'),
        source: sourceRef(meta),
      });
    }
    if (out.length > 0) return out;
  }

  // 版式 B：「活动跃迁：A、B」+「活动时间 … 4.7版本更新后 ~ 2026-12-02 03:59」
  const listMatch = flat.match(/活动跃迁[：:]\s*([^\s。；;：\n]{1,60})/);
  const timeMatch = flat.match(/活动时间[：:]?\s*([^。\n]{1,80})/);
  if (!listMatch) return [];
  const items = listMatch[1]
    .split(/[、,，]/)
    .map((s) => cleanCharacterName(s.trim()))
    .filter((s) => isNameLike(s));
  if (items.length === 0) return [];
  // 「活动跃迁：A、B、C、光锥1、光锥2、光锥3」：前 3 个当角色，其余只取第一个当池名，剩下的进 note
  const names = items.slice(0, 3);
  const poolNameFromList = items.length > 3 ? items[3] : names.join('、');
  const extraItems = items.length > 3 ? items.slice(4) : [];
  let endAbs: string | null = null;
  let startAbs: string | null = null;
  let timeRaw = timeMatch ? timeMatch[1].trim() : '';
  if (timeMatch) {
    const pair = splitRange(timeRaw.replace(/^[✦\s]+/, ''));
    if (pair) {
      const endD = pair.right.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日]?\s*(\d{1,2})[:：](\d{2})/);
      if (endD) endAbs = cstFromParts(+endD[1], +endD[2], +endD[3], +endD[4], +endD[5]);
      const startD = pair.left.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日]?\s*(\d{1,2})[:：](\d{2})/);
      if (startD && !RELATIVE_START_RE.test(pair.left)) {
        startAbs = cstFromParts(+startD[1], +startD[2], +startD[3], +startD[4], +startD[5]);
      }
    }
  }
  const noteParts = [noteBase];
  if (timeRaw && startAbs === null) noteParts.push('起点为「版本更新后」等相对表述，start_at=null');
  if (!timeRaw) noteParts.push('未找到活动时间，起止均为 null');
  if (items.length > 3) {
    noteParts.push('活动跃迁原文条目 ' + items.join('、'));
    if (extraItems.length) noteParts.push('其余条目 ' + extraItems.join('、'));
  }
  return [{
    game_key: 'hsr',
    pool_name: poolNameFromList,
    pool_type: 'limited_character',
    characters: names.slice(0, 2),
    start_at: startAbs,
    end_at: endAbs,
    version: version,
    period: phase,
    evidence: (timeRaw || listMatch[1]).slice(0, 200),
    note: noteParts.join('；'),
    source: sourceRef(meta),
  }];
}

// ————————————————————————— 原神：活动祈愿 / 集录祈愿 —————————————————————————

const GENSHIN_TIME_RANGE_RE = /(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})\s*[~～]\s*(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})/;
const GENSHIN_TIME_OPEN_RE = /将于\s*(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})\s*开启/;
/** 原神 UP 人数上限（契约 §3） */
const GENSHIN_MAX_UP = 2;

/** 原神角色名：「驹隙隐泉·兹白(岩)」→ 兹白（先去属性括号，再取 · 之后的名字） */
export function cleanGenshinName(raw: string): string {
  const base = cleanCharacterName(raw).replace(/[（(][^（()）]*[)）]/g, '').trim();
  const parts = base.split('·');
  return (parts[parts.length - 1] ?? '').trim();
}

/** 从一段文本里取「限定5星角色「…」」的名字 */
function genshinFiveStar(raw: string, keyword: string): string[] {
  const out: string[] = [];
  const re = new RegExp(keyword + '((?:「[^」]{1,30}」)+)', 'g');
  for (const m of raw.matchAll(re)) {
    for (const n of m[1].matchAll(/「([^」]{1,30})」/g)) {
      const name = cleanGenshinName(n[1]);
      if (isNameLike(name) && out.indexOf(name) < 0) out.push(name);
    }
  }
  return out;
}

/**
 * 原神动态正文 → 卡池候选。
 * 两种写法都支持：
 *   A) 「本期活动祈愿时间为2026/11/24 18:00 ~ 2026/12/15 14:59。限定5星角色「驹隙隐泉·兹白(岩)」「博闻异旅·莉奈娅(岩)」…」
 *   B) 「「呀吼吼博物志」活动祈愿将于2026年11月24日18:00开启，届时，限定5星角色「博闻异旅·莉奈娅(岩)」的祈愿获取概率将大幅提升！」
 */
export function parseGenshinText(text: string, meta: ParseMeta): PoolCandidate[] {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const version = (flat.match(/(\d+\.\d+)\s*版本/))?.[1] ?? null;

  let startAbs: string | null = null;
  let endAbs: string | null = null;
  let timeRaw = '';
  const range = flat.match(GENSHIN_TIME_RANGE_RE);
  if (range) {
    startAbs = cstFromParts(+range[1], +range[2], +range[3], +range[4], +range[5]);
    endAbs = cstFromParts(+range[6], +range[7], +range[8], +range[9], +range[10]);
    timeRaw = range[0];
  } else {
    const open = flat.match(GENSHIN_TIME_OPEN_RE);
    if (open) {
      startAbs = cstFromParts(+open[1], +open[2], +open[3], +open[4], +open[5]);
      timeRaw = open[0];
    }
  }

  // 池名取紧邻的「…」活动祈愿 / 「…」集录（集录祈愿是武器池）
  const named: Array<{ name: string; kind: string; index: number }> = [];
  for (const m of flat.matchAll(/「([^「」]{1,30})」(活动祈愿|祈愿|集录)/g)) {
    const name = m[1].trim();
    if (!isNameLike(name) || name.indexOf('祈愿') >= 0) continue;
    const kind = m[2] === '集录' ? 'weapon' : 'character';
    if (named.some((n) => n.name === name && n.kind === kind)) continue;
    named.push({ name: name, kind: kind, index: m.index ?? 0 });
  }

  const allChars = genshinFiveStar(flat, '限定5星角色');
  const allWeapons = genshinFiveStar(flat, '限定5星武器');
  const noteParts = ['动态 ' + meta.id];
  if (version) noteParts.push('版本 ' + version);
  if (timeRaw) noteParts.push('祈愿时间原文 ' + timeRaw);
  else noteParts.push('未找到祈愿时间，起止均为 null');

  const makePool = (poolName: string, isWeapon: boolean, chars: string[], section: string): PoolCandidate => {
    const notes = noteParts.slice();
    if (isWeapon && allWeapons.length) notes.push('武器 「' + allWeapons.join('」「') + '」');
    return {
      game_key: 'genshin',
      pool_name: poolName,
      pool_type: isWeapon ? 'weapon' : 'limited_character',
      characters: isWeapon ? [] : chars.slice(0, GENSHIN_MAX_UP),
      start_at: startAbs,
      end_at: endAbs,
      version: version,
      period: null,
      evidence: (timeRaw || section).slice(0, 200),
      note: notes.join('；'),
      source: sourceRef(meta),
    };
  };

  if (named.length > 0) {
    const out: PoolCandidate[] = [];
    for (let i = 0; i < named.length; i++) {
      const item = named[i];
      const to = i + 1 < named.length ? named[i + 1].index : flat.length;
      const section = flat.slice(item.index, to);
      const isWeapon = item.kind === 'weapon';
      const chars = isWeapon ? [] : genshinFiveStar(section, '限定5星角色');
      const effective = chars.length ? chars : allChars;
      // 既没角色也没时间 → 没有可用信息，不产出（避免页面出现空卡池）
      if (!isWeapon && effective.length === 0 && !startAbs && !endAbs) continue;
      out.push(makePool(item.name, isWeapon, effective, section));
    }
    // 只有「集录祈愿」（武器）名字、但正文给了限定5星角色 → 补一条角色池候选
    if (allChars.length > 0 && !named.some((n) => n.kind === 'character')) {
      out.push(makePool('活动祈愿', false, allChars, flat));
    }
    if (out.length > 0) return out;
  }

  const out: PoolCandidate[] = [];
  if (allChars.length > 0) {
    out.push(makePool('活动祈愿', false, allChars, flat));
    noteParts.push('池名缺失，用「活动祈愿」占位');
  }
  if (allWeapons.length > 0) out.push(makePool('武器祈愿', true, [], flat));
  return out;
}

/** 单条动态 → 候选（按 game_key 选解析器；不匹配句式返回 []） */
// ————————————————————————— 异环：协定卡池（限定棋盘）—————————————————————————
// 官方动态措辞：「「破晓前」限定棋盘…即将返场，可获得限定S级角色「真红」和限定S级弧盘「穿过胭红蜃景」！
//            ▸开放时间 2026/11/5 版本更新后~2026/11/26 5:59（服务器时间）
// 异环把角色卡池叫「限定棋盘」，官方没出现「协定」二字；按用户口径统一归到 pact（协定卡池）字段。
const YH_POOL_RE = /「([^」]{2,25})」\s*限定棋盘/g;
const YH_CHAR_RE = /限定S级角色「([^」]{1,20})」/g;
const YH_RANGE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?[^~～\n]{0,14}[~～][^\n]{0,20}?(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?/;

export function parseYhText(text: string, meta: ParseMeta): PoolCandidate[] {
  const names: string[] = [];
  for (const m of text.matchAll(YH_POOL_RE)) {
    const name = m[1].trim();
    if (name && names.indexOf(name) < 0) names.push(name);
  }
  if (!names.length) return [];

  const chars: string[] = [];
  for (const m of text.matchAll(YH_CHAR_RE)) {
    const name = cleanCharacterName(m[1]);
    if (isNameLike(name) && chars.indexOf(name) < 0) chars.push(name);
  }

  const range = text.match(YH_RANGE_RE);
  // 「版本更新后」是相对起点：原文里第一个日期是版更当天，不当作精确开池时刻（契约 q3：缺锚点置 null）
  const relativeStart = /版本更新后|更新维护后|维护后/.test(text.slice(0, (range?.index ?? 0) + 40));
  // 起点：给了绝对时间就用；只写「版本更新后」时用原文的版更日 + 05:00 近似（异环维护普遍凌晨结束，
  // 且同一公告的结束时刻都是 05:59，属自洽的近似），并在 note 明确标注，避免前端显示成「时间待定」。
  const start = range
    ? (relativeStart
        ? cstFromParts(+range[1], +range[2], +range[3], 5, 0)
        : cstFromParts(+range[1], +range[2], +range[3], range[4] ? +range[4] : 0, range[5] ? +range[5] : 0))
    : null;
  // 结束时间缺 HH:mm（如「2026/11/26 5:59」通常给了，缺失时按当天 23:59 兜底并在 note 说明）
  const endHour = range?.[9] ? +range[9] : 23;
  const endMin = range?.[10] ? +range[10] : 59;
  const end = range ? cstFromParts(+range[6], +range[7], +range[8], endHour, endMin) : null;
  const isRerun = /返场|复刻/.test(text);
  const noteParts = ['异环限定棋盘（官方措辞）'];
  if (isRerun) noteParts.push('返场/复刻');
  if (relativeStart) noteParts.push('起点按版更日 05:00 近似（原文：版本更新后）');

  return names.map((name) => ({
    game_key: 'yh',
    pool_name: name,
    pool_type: 'pact' as PoolType,
    characters: chars.slice(0, 2),
    start_at: start,
    end_at: end,
    version: null,
    period: null,
    evidence: (range ? text.slice(range.index ?? 0, (range.index ?? 0) + 80) : text.slice(0, 80)).trim(),
    note: noteParts.join('；'),
    source: sourceRef(meta),
  }));
}

// ————————————————————————— 绝区零：代理人调频 —————————————————————————
// B 站官号没有「带时间的调频公告」（时间都在图里），但每条版本动态都带一句
// 「限定S级代理人「A」&「B」现已加入调频&复刻」，版本内容一览里还会写「…加入限时频段」。
// 因此这里只产出「角色 + 池类型」，时间留空，由 resolver 的「无时间候选按角色交集并入」规则
// 合并到 Akasha 日历里同时段的同类型池，从而把置信度从 low 抬到 high。
const ZZZ_FOOTER_RE = /限定S级代理人「([^」]{1,20})」\s*&\s*「([^」]{1,20})」现已加入调频/g;
const ZZZ_FREQ_RE = /S级代理人\[([^\]()]{1,20})(?:\([^)]*\))?\]、?\[([^\]()]{1,20})(?:\([^)]*\))?\][^。\n]{0,20}加入限时频段/g;

export function parseZzzText(text: string, meta: ParseMeta): PoolCandidate[] {
  const chars: string[] = [];
  const pushChar = (raw: string) => {
    const name = cleanCharacterName(raw);
    if (isNameLike(name) && chars.indexOf(name) < 0) chars.push(name);
  };
  for (const m of text.matchAll(ZZZ_FOOTER_RE)) { pushChar(m[1]); pushChar(m[2]); }
  for (const m of text.matchAll(ZZZ_FREQ_RE)) { pushChar(m[1]); pushChar(m[2]); }
  if (!chars.length) return [];

  const isRerun = /现已加入调频&复刻|复刻/.test(text);
  const noteParts = ['B 站版本动态只给角色名，时间由 Akasha 日历同池补齐'];
  if (isRerun) noteParts.push('含复刻');

  return [{
    game_key: 'zzz',
    pool_name: '代理人调频',
    pool_type: 'limited_character' as PoolType,
    characters: chars.slice(0, UP_LIMIT_HINT),
    start_at: null,
    end_at: null,
    version: (text.match(/(\d+\.\d+)\s*版本/) ?? [])[1] ?? null,
    period: null,
    evidence: text.slice(0, 200),
    note: noteParts.join('；'),
    source: sourceRef(meta),
    published_at: meta.publishedAt,
  }];
}

/** 单条动态最多取几个代理人（与 resolver 的 UP 上限一致，多余的在守卫里会被丢弃） */
const UP_LIMIT_HINT = 2;
export function parseDynamic(dyn: { id: string; game_key: string; published_at: string; raw: string; url?: string | null }, fetchedAt?: string): PoolCandidate[] {
  const text = dynamicTextFromRaw(dyn.raw);
  if (!text) return [];
  const meta: ParseMeta = {
    id: String(dyn.id),
    gameKey: dyn.game_key,
    publishedAt: dyn.published_at,
    url: dyn.url ?? null,
    fetchedAt: fetchedAt ?? null,
  };
  switch (dyn.game_key) {
    case 'genshin':
      return parseGenshinText(text, meta);
    case 'azurpromilia':
      return parseAzurpromiliaText(text, meta);
    case 'wutheringwaves':
      return parseKuroDynamicText(text, meta);
    case 'bluearchive':
      return parseBlueArchiveText(text, meta);
    case 'hsr':
      return parseHsrText(text, meta);
    case 'yh':
      // 异环：限定棋盘 → 协定卡池（pact）
      return parseYhText(text, meta);
    case 'zzz':
      // 绝区零：只给角色，时间由 Akasha 日历补齐
      return parseZzzText(text, meta);
    default:
      return [];
  }
}

interface StoreLike {
  dynamics?: Array<{ id?: string | number; game_key?: string; published_at?: string; raw?: string; url?: string }>;
}

/** 从 store.json 的 dynamics 里解析全部候选 */
export function parseStoreDynamics(store: StoreLike | null, fetchedAt?: string): PoolCandidate[] {
  const dynamics = store?.dynamics;
  if (!Array.isArray(dynamics)) return [];
  const out: PoolCandidate[] = [];
  const perGame = new Map<string, number>();
  // 新的动态优先
  const sorted = dynamics
    .filter((d) => d && typeof d === 'object' && BILI_GAMES.indexOf(String(d.game_key ?? '')) >= 0)
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
  for (const dyn of sorted) {
    const gameKey = String(dyn.game_key ?? '');
    const cands = parseDynamic({
      id: String(dyn.id ?? ''),
      game_key: gameKey,
      published_at: String(dyn.published_at ?? ''),
      raw: String(dyn.raw ?? ''),
      url: dyn.url ?? null,
    }, fetchedAt);
    for (const cand of cands) {
      const used = perGame.get(gameKey) ?? 0;
      if (used >= MAX_PER_GAME) break;
      perGame.set(gameKey, used + 1);
      out.push(cand);
    }
  }
  return out;
}

export async function collectBiliDynamics(ctx: SourceContext): Promise<PoolCandidate[]> {
  const storePath = path.join(ctx.dataDir, 'store.json');
  let store: StoreLike | null = null;
  try {
    if (!fs.existsSync(storePath)) {
      ctx.log('[source:bili-dynamics] 未找到 ' + storePath + '，返回空');
      return [];
    }
    store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as StoreLike;
  } catch (e: any) {
    // 只读本地 store，不联网；读取失败也不编造
    ctx.log('[source:bili-dynamics] 读取 store.json 失败: ' + (e?.message ?? String(e)));
    return [];
  }
  const out = parseStoreDynamics(store, ctx.nowCst);
  if (out.length === 0) ctx.log('[source:bili-dynamics] 未从动态正文解析出卡池');
  return out;
}

export const biliDynamicsAdapter: SourceAdapter = {
  id: SOURCE_ID,
  tier: 'L0',
  label: 'B站官方动态正文',
  games: BILI_GAMES,
  collect: collectBiliDynamics,
};

export default biliDynamicsAdapter;
