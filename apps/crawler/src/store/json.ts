// 无状态 JSON 存储：适合 GitHub Actions 每次冷启动的场景。
// 数据文件 data/store.json 会随提交持久化，作为"离线数据库"。
import fs from 'node:fs';
import path from 'node:path';

export interface RawDynamic {
  id: string;
  game_key: string;
  mid: string;
  type: string;
  published_at: string;
  raw: string;
  url: string;
  fetched_at: string;
}

interface StoreFile {
  dynamics: RawDynamic[];
  state: Record<string, string>;
}

const MAX_PER_GAME = 400;   // 每游戏最多保留条数，控制仓库体积
const MAX_AGE_DAYS = 150;   // 超过这个天数的动态不再保留

// ——————————————— raw 压缩 ———————————————
// 原始动态 JSON 里有大量解析用不到的字段（评论/转发/挂件/装扮/多套重复的 major 子树等），
// 单条常有 30~80KB，长期累积会把 store.json 撑到几十 MB。
// 这里只保留解析必需的字段，并保证 compactRaw 幂等：
//   normalizeDynamic(JSON.parse(compactRaw(raw))) 与原文的 title/summary/images 完全一致。
// 必须保留的关键字段：
//   - modules.module_author.pub_ts / name（发布时间与署名）
//   - modules.module_dynamic.desc.text（旧格式正文）
//   - modules.module_dynamic.major.opus（Opus 正文与图片）
//   - modules.module_dynamic.major.draw（旧版图文图片）
//   - modules.module_dynamic.major.archive（视频投稿：title/desc/bvid/cover/duration_text/jump_url）
//   - orig.modules.module_dynamic（转发内容的同一套字段）

function pickFields(source: any, keys: string[], target: any): void {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  }
}

function pickAuthor(author: any): any {
  if (!author || typeof author !== 'object') return undefined;
  const out: any = {};
  pickFields(author, ['mid', 'name', 'face', 'pub_ts', 'pub_time'], out);
  return Object.keys(out).length ? out : undefined;
}

function pickPics(pics: any): any[] | undefined {
  if (!Array.isArray(pics)) return undefined;
  const out = pics.map((pic: any) => {
    const one: any = {};
    pickFields(pic || {}, ['url', 'width', 'height', 'live_url'], one);
    return one;
  });
  return out;
}

function pickOpus(opus: any): any {
  if (!opus || typeof opus !== 'object') return undefined;
  const out: any = {};
  pickFields(opus, ['jump_url', 'title'], out);
  const summary = opus.summary;
  if (summary && typeof summary === 'object') {
    const picked: any = {};
    if (typeof summary.title === 'string') picked.title = summary.title;
    if (typeof summary.text === 'string') picked.text = summary.text;
    // rich_text_nodes 与 text 重复；仅在 text 为空（需要兜底读取）时才保留
    if (!(typeof summary.text === 'string' && summary.text.trim()) && Array.isArray(summary.rich_text_nodes)) {
      picked.rich_text_nodes = summary.rich_text_nodes;
    }
    out.summary = picked;
  }
  const pics = pickPics(opus.pics);
  if (pics) out.pics = pics;
  return out;
}

function pickDraw(draw: any): any {
  if (!draw || typeof draw !== 'object' || !Array.isArray(draw.items)) return undefined;
  return {
    items: draw.items.map((item: any) => {
      const one: any = {};
      pickFields(item || {}, ['src', 'width', 'height'], one);
      return one;
    }),
  };
}

function pickArchive(archive: any): any {
  if (!archive || typeof archive !== 'object') return undefined;
  const out: any = {};
  pickFields(archive, ['title', 'desc', 'bvid', 'cover', 'duration_text', 'jump_url', 'aid'], out);
  return out;
}

function pickMajor(major: any): any {
  if (!major || typeof major !== 'object') return undefined;
  const out: any = {};
  pickFields(major, ['type'], out);
  const opus = pickOpus(major.opus);
  if (opus) out.opus = opus;
  const draw = pickDraw(major.draw);
  if (draw) out.draw = draw;
  const archive = pickArchive(major.archive);
  if (archive) out.archive = archive;
  return Object.keys(out).length ? out : undefined;
}

function pickDynamic(dynamic: any): any {
  if (!dynamic || typeof dynamic !== 'object') return undefined;
  const out: any = {};
  const descText = dynamic.desc?.text;
  if (typeof descText === 'string') out.desc = { text: descText };
  const major = pickMajor(dynamic.major);
  if (major) out.major = major;
  return Object.keys(out).length ? out : undefined;
}

function pickModules(modules: any, keepAuthor: boolean): any {
  if (!modules || typeof modules !== 'object') return undefined;
  const out: any = {};
  if (keepAuthor) {
    const author = pickAuthor(modules.module_author);
    if (author) out.module_author = author;
  }
  const dynamic = pickDynamic(modules.module_dynamic);
  if (dynamic) out.module_dynamic = dynamic;
  return Object.keys(out).length ? out : undefined;
}

function pickItem(item: any, keepAuthor: boolean, depth = 0): any {
  if (!item || typeof item !== 'object') return undefined;
  const out: any = {};
  pickFields(item, ['id_str', 'id', 'type'], out);
  const modules = pickModules(item.modules, keepAuthor);
  if (modules) out.modules = modules;
  // 转发：只保留被转发内容的 module_dynamic（正文/图片/视频）
  if (keepAuthor && item.orig && depth < 1) {
    const orig = pickItem(item.orig, false, depth + 1);
    if (orig) out.orig = orig;
  }
  return out;
}

/**
 * 压缩一条动态的原始 JSON（入参可以是对象或 JSON 字符串），返回 JSON 字符串。
 * 幂等；解析失败时原样返回入参字符串。
 */
export function compactRaw(raw: any): string {
  let source = raw;
  if (typeof raw === 'string') {
    try { source = JSON.parse(raw); } catch { return raw; }
  }
  if (!source || typeof source !== 'object') return typeof raw === 'string' ? raw : '{}';
  return JSON.stringify(pickItem(source, true) ?? {});
}

export class Store {
  private file: string;
  private data: StoreFile;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'store.json');
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
        this.data.dynamics ||= [];
        this.data.state ||= {};
        // 历史行迁移：旧版本存的是完整原始 JSON，这里压缩到解析必需字段（flush 时写回）
        this.data.dynamics = this.data.dynamics.map(row => {
          if (typeof row.raw !== 'string') return row;
          const compacted = compactRaw(row.raw);
          return compacted === row.raw ? row : { ...row, raw: compacted };
        });
      } catch (e) {
        console.warn('[store] store.json 损坏，重建:', String(e));
        this.data = { dynamics: [], state: {} };
      }
    } else {
      this.data = { dynamics: [], state: {} };
    }
  }

  insertDynamic(d: RawDynamic): boolean {
    if (this.data.dynamics.some(x => x.id === d.id)) return false;
    this.data.dynamics.push({ ...d, raw: compactRaw(d.raw) });
    return true;
  }

  private sorted(gameKey?: string): RawDynamic[] {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    return this.data.dynamics
      .filter(d => !gameKey || d.game_key === gameKey)
      .filter(d => new Date(d.published_at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  }

  getDynamics(gameKey: string, limit = 200): RawDynamic[] {
    return this.sorted(gameKey).slice(0, limit);
  }

  getAllDynamics(limit = 2000): RawDynamic[] {
    const rows = this.sorted();
    // 每游戏限量，避免单个游戏挤占全部
    const counts: Record<string, number> = {};
    return rows.filter(d => {
      counts[d.game_key] = (counts[d.game_key] || 0) + 1;
      return counts[d.game_key] <= MAX_PER_GAME;
    }).slice(0, limit);
  }

  getState(key: string): string | null {
    return this.data.state[key] ?? null;
  }

  setState(key: string, value: string): void {
    this.data.state[key] = value;
  }

  count(): number { return this.data.dynamics.length; }

  flush(): void {
    // 落盘前先裁剪，保持文件精简
    const kept = new Set(this.getAllDynamics(5000).map(d => d.id));
    this.data.dynamics = this.data.dynamics.filter(d => kept.has(d.id));
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  close(): void { this.flush(); }
}
