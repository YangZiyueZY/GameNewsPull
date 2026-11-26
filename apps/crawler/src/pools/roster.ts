// 角色名归一化 + 字典校验（决策 q10=A：本地字典 data/char-names.json 为准）。
//
// 为什么集中在这里：各信源的写法完全不一样——Akasha 给英文、PRTS 给「地名·角色(属性)」、
// B 站公告给整句「概率提升的6星干员为【小刻】」。如果每个适配器各自清洗，同一角色会出现
// 多种写法，卡池去重与 current_up_characters 就会失真。所以清洗 + 映射只在本模块做一次。
//
// 设计约束：
// 1) 只读字典、不发网络请求（测试可离线跑）；
// 2) 映射不到宁可判 invalid，绝不猜（契约 q3/q4）——调用方把 invalid 计入告警；
// 3) 噪声串（「全部可能出现」「概率提升」「★★★★」这类公告套话）先按片段回收再判定。

import fs from 'node:fs';
import path from 'node:path';
import type { CharacterBook, CharacterBookEntry } from './types.ts';

/** 括号包裹：剥「外层」时成对使用，避免把「兹白(岩)」的右括号当包裹符剥掉 */
const OPEN_BRACKETS = '「『【《〈（([' + '"';
const CLOSE_BRACKETS = '」』】》〉）)]' + '"';

/** 属性括号里的词（原神/星铁/终末地等属性写法）；白名单制，避免误伤「纱织（泳装）」这类形态名 */
const ATTRIBUTE_WORDS = [
  '岩', '火', '水', '草', '雷', '冰', '风', '光', '暗', '物理', '量子', '虚数', '星', '共鸣',
  '霜', '电', '阳', '阴', '热熔', '冷凝', '衍射', '气动', '导电', '湮灭', '凋亡', '净焰', '燃烧',
  'Physical', 'Pyro', 'Hydro', 'Dendro', 'Anemo', 'Electro', 'Cryo', 'Geo', 'Quantum', 'Imaginary',
];

const ATTR_PAREN = new RegExp('[(（]\\s*(?:' + ATTRIBUTE_WORDS.join('|') + ')\\s*[)）]\\s*$', 'i');

/** 尾部标注：公告常见「小刻 UP」「小刻(6星)」，只认这些元信息词，不碰角色本体 */
const TRAILING_NOTE_RE = /[(（[【]?\s*(?:up|ssr|ur|sp|5星|6星|五星|六星|新角色|限定|复刻|返场)\s*[)）\]】]?$/i;

/** 公告里的套话：出现这些词的串不能直接当角色名（先尝试按片段回收） */
export const NOISE_CHARACTER_RE =
  /全部可能|可能出现|概率提升|获取概率|概率为|概率|★★★★|★{2,}|\d+\s*星干员|干员为|角色为|寻访|祈愿|唤取|招募|保底|活动期间|官方公告|详细内容/;

/** 归一化 key：大小写不敏感、去空格与标点（字典查找只认它） */
const KEY_NOISE_RE = /[\s\u3000·・\-—_–'" ，。、,.。:：;；!！?？()（）\[\]【】「」『』《》<>"\/\\|]+/g;

/** 反复剥掉成对的外层包裹符号：「「兹白」」 → 兹白 */
function stripEdgeBrackets(input: string): string {
  let text = input.trim();
  for (let i = 0; i < 4; i++) {
    if (text.length < 2) break;
    if (OPEN_BRACKETS.includes(text[0]) && CLOSE_BRACKETS.includes(text[text.length - 1])) {
      text = text.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return text;
}

/** 字典查找 key（不是展示名）：'Silver Wolf LV.999' 与 '银狼lv.999' 都能对上 */
export function nameKey(raw: string): string {
  return String(raw ?? '').normalize('NFKC').toLowerCase().replace(KEY_NOISE_RE, '');
}

/**
 * 展示用归一化：'驹隙隐泉·兹白(岩)' → '兹白'，'【小刻】' → '小刻'。
 * 清洗失败（空串 / 明显是整句）返回 ''，由调用方判 invalid。
 */
export function normalizeCharacterName(raw: string): string {
  if (typeof raw !== 'string') return '';
  let name = raw.normalize('NFKC').trim();
  if (!name) return '';
  name = stripEdgeBrackets(name);
  // 「地名·角色」取最后一段（原神/鸣潮的官方写法）
  if (/[·・]/.test(name)) {
    const parts = name.split(/[·・]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) name = parts[parts.length - 1];
  }
  // 属性括号与尾部标注可能叠加（「兹白(岩) UP」），最多剥三层
  for (let i = 0; i < 3; i++) {
    const next = stripEdgeBrackets(name).replace(ATTR_PAREN, '').replace(TRAILING_NOTE_RE, '').trim();
    if (next === name) break;
    name = next;
  }
  // 中文角色名不含空格；英文名去空格不影响字典查找（nameKey 也去空格）
  name = name.replace(/\s+/g, '');
  // 只清标点与连接符；括号交给 stripEdgeBrackets / ATTR_PAREN，否则会切坏「纱织（泳装）」的右括号
  name = name.replace(/^[·・\-—_,，。.:：;；!！?？]+|[·・\-—_,，。.:：;；!！?？]+$/g, '');
  if (!name) return '';
  // 长度兜底：公告整句（>16 字）绝不是角色名
  if ([...name].length > 16) return '';
  return name;
}

/** 是否公告套话（噪声串不允许当角色名） */
export function isNoiseCharacter(name: string): boolean {
  return NOISE_CHARACTER_RE.test(String(name ?? ''));
}

export interface RosterIndex {
  /** 任意写法 key → 规范中文名（跨游戏） */
  map: Map<string, string>;
  /** game_key → (任意写法 key → 规范中文名) */
  byGame: Map<string, Map<string, string>>;
  /** game_key → 规范中文名集合（validateCharacters 的 roster 参数来源） */
  names: Map<string, Set<string>>;
}

/** 由字典条目建索引：cn/en/jp/alias 全部注册，同一 key 先到先得（cn 永远排第一） */
export function buildRosterIndex(entries: CharacterBookEntry[]): RosterIndex {
  const index: RosterIndex = { map: new Map(), byGame: new Map(), names: new Map() };
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.cn !== 'string' || !entry.cn.trim()) continue;
    const game = String(entry.game_key ?? '').trim();
    const cn = entry.cn.trim();
    if (!game) continue;
    let gameMap = index.byGame.get(game);
    if (!gameMap) {
      gameMap = new Map();
      index.byGame.set(game, gameMap);
    }
    let nameSet = index.names.get(game);
    if (!nameSet) {
      nameSet = new Set();
      index.names.set(game, nameSet);
    }
    nameSet.add(cn);
    const spellings = [cn, entry.en, entry.jp, ...(entry.aliases ?? [])];
    for (const spelling of spellings) {
      if (typeof spelling !== 'string' || !spelling.trim()) continue;
      const key = nameKey(spelling);
      if (!key) continue;
      if (!gameMap.has(key)) gameMap.set(key, cn);
      if (!index.map.has(key)) index.map.set(key, cn);
    }
  }
  return index;
}

/** 读 data/char-names.json；缺文件/坏 JSON 返回空书（重建流程不能因此整体失败） */
export function loadCharBook(dataDir: string): CharacterBook {
  const file = path.join(dataDir, 'char-names.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CharacterBook;
    return { generated_at: raw?.generated_at, games: raw?.games ?? {} };
  } catch {
    return { games: {} };
  }
}

/** CharacterBook → 带 game_key 的扁平条目（buildRosterIndex 的入参） */
export function flattenCharBook(book: CharacterBook | null | undefined): CharacterBookEntry[] {
  const entries: CharacterBookEntry[] = [];
  for (const [gameKey, list] of Object.entries(book?.games ?? {})) {
    for (const entry of list ?? []) entries.push({ ...entry, game_key: gameKey });
  }
  return entries;
}

export interface ValidateResult {
  valid: string[];
  invalid: string[];
}

/**
 * 角色名校验：能映射就映射成规范中文名；映射不到但出现在 roster 名单里也算 valid。
 * gameKey 给定时优先用游戏内映射（避免跨游戏同名串味），否则回落到全局字典。
 */
export function validateCharacters(
  names: string[],
  index: RosterIndex,
  roster?: Iterable<string> | null,
  gameKey?: string,
): ValidateResult {
  const scoped = gameKey ? index.byGame.get(gameKey) : undefined;
  const lookup = (key: string): string | undefined => scoped?.get(key) ?? index.map.get(key);
  const rosterKeys = roster ? new Set(Array.from(roster, (n) => nameKey(n)).filter(Boolean)) : null;
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of names ?? []) {
    const cleaned = normalizeCharacterName(raw);
    const key = cleaned ? nameKey(cleaned) : '';
    const mapped = key ? lookup(key) : undefined;
    const kept = mapped ?? (key && rosterKeys?.has(key) ? cleaned : '');
    if (!kept) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(kept)) {
      seen.add(kept);
      valid.push(kept);
    }
  }
  return { valid, invalid };
}

/** 候选写法：整串、括号内片段、名单分隔片段（公告整句 → 【小刻】 的唯一回收路径） */
function candidateForms(raw: string): string[] {
  const text = String(raw ?? '');
  const forms: string[] = [text];
  for (const m of text.matchAll(/[「『【《〈(（\[［]([^」』】》〉)）\]］]{1,24})[」』】》〉)）\]］]/g)) {
    forms.push(m[1]);
  }
  for (const seg of text.split(/[、,，;；\/|]/)) forms.push(seg);
  return forms;
}

/**
 * 清洗 + 校验一步到位（resolver 用的入口）：
 * 整串是噪声时退化为「按括号片段/分隔符逐个尝试」，都映射不到就整条判 invalid。
 * index 为 null 时只做归一化 + 噪声过滤（字典该游戏为空时的降级路径，避免整池角色被误杀）。
 */
export function sanitizeCharacterNames(
  rawNames: string[],
  index: RosterIndex | null,
  roster?: Iterable<string> | null,
  gameKey?: string,
): ValidateResult {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const scoped = index && gameKey ? index.byGame.get(gameKey) : undefined;
  const rosterKeys = roster ? new Set(Array.from(roster, (n) => nameKey(n)).filter(Boolean)) : null;
  const resolve = (name: string): string => {
    if (!index) return name;
    const key = nameKey(name);
    if (!key) return '';
    const mapped = scoped?.get(key) ?? index.map.get(key);
    if (mapped) return mapped;
    if (rosterKeys?.has(key)) return name;
    return '';
  };

  for (const raw of rawNames ?? []) {
    let kept = '';
    const tried = new Set<string>();
    for (const form of candidateForms(raw)) {
      const cleaned = normalizeCharacterName(form);
      if (!cleaned || isNoiseCharacter(cleaned) || tried.has(cleaned)) continue;
      tried.add(cleaned);
      const canonical = resolve(cleaned);
      if (canonical) {
        kept = canonical;
        break;
      }
    }
    if (!kept) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(kept)) {
      seen.add(kept);
      valid.push(kept);
    }
  }
  return { valid, invalid };
}

/** 合并新的角色条目进字典：cn 为准，已有条目只补空的 en/jp/aliases，绝不覆盖人工维护的 cn */
export function mergeCharBook(book: CharacterBook, entries: CharacterBookEntry[]): { book: CharacterBook; added: number; updated: number } {
  const next: CharacterBook = { generated_at: book.generated_at, games: { ...(book.games ?? {}) } };
  let added = 0;
  let updated = 0;
  for (const entry of entries ?? []) {
    const gameKey = String(entry?.game_key ?? '').trim();
    const cn = String(entry?.cn ?? '').trim();
    if (!gameKey || !cn) continue;
    const list = [...(next.games[gameKey] ?? [])];
    const hit = list.find((item) => nameKey(item.cn) === nameKey(cn));
    if (!hit) {
      list.push({ cn, en: entry.en ?? null, jp: entry.jp ?? null, aliases: entry.aliases ?? [] });
      added++;
    } else {
      let touched = false;
      if (!hit.en && entry.en) { hit.en = entry.en; touched = true; }
      if (!hit.jp && entry.jp) { hit.jp = entry.jp; touched = true; }
      if (entry.aliases?.length) {
        const aliases = new Set([...(hit.aliases ?? []), ...entry.aliases]);
        if (aliases.size !== (hit.aliases ?? []).length) { hit.aliases = [...aliases]; touched = true; }
      }
      if (touched) updated++;
    }
    next.games[gameKey] = list;
  }
  return { book: next, added, updated };
}

/** 写回 data/char-names.json（只在内容有变化时由调用方触发，避免每天产生无意义 diff） */
export function writeCharBook(dataDir: string, book: CharacterBook): void {
  const file = path.join(dataDir, 'char-names.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated_at: book.generated_at ?? null, games: book.games }, null, 2) + '\n');
}
