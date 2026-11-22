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
    this.data.dynamics.push(d);
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
