import 'dotenv/config';
import { signWbi } from '../../utils/wbi.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://api.bilibili.com';

export interface ApiResponse<T> { code: number; message: string; data: T }

export class BiliClient {
  private cookie: string;
  private imgUrl = '';
  private subUrl = '';
  private lastWbiFetch = 0;

  constructor() {
    this.cookie = process.env.BILIBILI_COOKIE || '';
    if (!this.cookie) console.warn('[bili] BILIBILI_COOKIE 未设置，将使用匿名请求（成功率较低）');
  }

  private async request<T>(url: string): Promise<ApiResponse<T>> {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json, text/plain, */*',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    try { return JSON.parse(text) as ApiResponse<T>; }
    catch { throw new Error(`B站返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`); }
  }

  async refreshWbi(): Promise<void> {
    if (Date.now() - this.lastWbiFetch < 3_600_000 && this.imgUrl) return;
    const res = await this.request<{ wbi_img: { img_url: string; sub_url: string }; isLogin: boolean }>(`${BASE}/x/web-interface/nav`);
    if (res.code !== 0 || !res.data.wbi_img) throw new Error(`获取 WBI key 失败: ${res.code} ${res.message}`);
    this.imgUrl = res.data.wbi_img.img_url;
    this.subUrl = res.data.wbi_img.sub_url;
    this.lastWbiFetch = Date.now();
    console.log(`[bili] WBI key 已刷新，登录状态: ${res.data.isLogin}`);
  }

  async getSigned<T>(path: string, params: Record<string, string | number | boolean>): Promise<ApiResponse<T>> {
    await this.refreshWbi();
    const q = signWbi(params, this.imgUrl, this.subUrl);
    return this.request<T>(`${BASE}${path}?${q.toString()}`);
  }

  async get<T>(path: string, params: Record<string, string | number>): Promise<ApiResponse<T>> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return this.request<T>(`${BASE}${path}?${q.toString()}`);
  }

  async getOfficialInfo(mid: string): Promise<{ name: string; face: string; verified: boolean; desc: string; fans: number } | null> {
    const r = await this.get<{ card: { name: string; face: string; official_verify: { type: number; desc: string }; fans: number } }>(
      '/x/web-interface/card', { mid }
    );
    if (r.code !== 0) return null;
    const c = r.data.card;
    return { name: c.name, face: c.face, verified: c.official_verify.type === 1, desc: c.official_verify.desc, fans: c.fans };
  }

  async verifyOfficial(mid: string): Promise<{ name: string; face: string; verified: boolean; desc: string; fans: number }> {
    const info = await this.getOfficialInfo(mid);
    if (!info) throw new Error(`校验 UID ${mid} 失败`);
    return info;
  }

  /**
   * 拉取官方账号的动态流。
   * 单一端点有被风控/参数变更的风险，失败时按变体重试：
   *   ① features=itemOpusStyle（默认，Opus 结构最完整）
   *   ② 不带 features
   *   ③ 不带 features 且 type=all
   * 三个变体都失败才抛错，避免一次参数变更导致整条数据管线停摆。
   */
  async getDynamicFeed(mid: string, offset = ''): Promise<{ items: any[]; offset: string; hasMore: boolean }> {
    const base = { host_mid: mid, timezone_offset: -480, offset };
    const variants: Array<Record<string, string | number>> = [
      { ...base, features: 'itemOpusStyle', type: '' },
      { ...base, type: '' },
      { ...base, type: 'all' },
    ];
    let lastError: unknown = null;
    for (let i = 0; i < variants.length; i++) {
      try {
        const r = await this.getSigned<{ items: any[]; offset: string; has_more: boolean }>(
          '/x/polymer/web-dynamic/v1/feed/space', variants[i]
        );
        if (r.code !== 0) throw new Error(`拉取动态失败 mid=${mid}: ${r.code} ${r.message}`);
        return { items: r.data?.items || [], offset: r.data?.offset || '', hasMore: !!r.data?.has_more };
      } catch (e: any) {
        lastError = e;
        if (i < variants.length - 1) {
          console.warn(`[bili] 动态接口变体 ${i + 1} 失败（${e.message}），改用变体 ${i + 2} 重试`);
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`拉取动态失败 mid=${mid}: ${String(lastError)}`);
  }

  /**
   * 投稿视频列表（/x/space/wbi/arc/search）。
   * 作为端点级兜底与健康检查：动态接口挂掉时据此判断「账号/网络可达，只是动态接口不可用」。
   */
  async getSpaceVideos(mid: string, pageSize = 10): Promise<Array<{ bvid: string; title: string; created: number; cover: string }>> {
    const r = await this.getSigned<{ list: { vlist: any[] } }>(
      '/x/space/wbi/arc/search',
      { mid, ps: pageSize, pn: 1, order: 'pubdate', index: 0, keyword: '', tid: 0 }
    );
    if (r.code !== 0) throw new Error(`拉取投稿失败 mid=${mid}: ${r.code} ${r.message}`);
    const list = r.data?.list?.vlist || [];
    return list.map((v: any) => ({
      bvid: v?.bvid || '',
      title: v?.title || '',
      created: Number(v?.created) || 0,
      cover: v?.pic || '',
    })).filter(v => v.bvid);
  }

  async getVideoInfo(bvid: string): Promise<any | null> {
    try {
      const r = await this.get<any>('/x/web-interface/view', { bvid });
      return r.code === 0 ? r.data : null;
    } catch { return null; }
  }
}
