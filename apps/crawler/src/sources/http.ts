// 信源抓取的公共底座：统一 UA/超时、原始 JSON 落盘缓存、离线可用的 withSourceCache。
// 约定：适配器永远不要因为网络失败抛错到上层；拿不到数据返回 null/[]，由 resolver 判空。
import fs from 'node:fs';
import path from 'node:path';
import type { SourceContext } from '../pools/types.ts';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 20_000;

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

/** 注意：访问鹰角 CMS 时不要带 Origin 头（会 403） */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: { 'User-Agent': DEFAULT_UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}

export function sourceCachePath(ctx: SourceContext, id: string): string {
  return path.join(ctx.cacheDir, `${id}.json`);
}

export function readSourceCache<T = any>(ctx: SourceContext, id: string): T | null {
  try {
    const file = sourceCachePath(ctx, id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeSourceCache(ctx: SourceContext, id: string, data: unknown): void {
  try {
    fs.mkdirSync(ctx.cacheDir, { recursive: true });
    fs.writeFileSync(sourceCachePath(ctx, id), JSON.stringify({ cached_at: ctx.nowCst, data }, null, 2));
  } catch (e: any) {
    ctx.log(`[cache] 写入 ${id} 失败:`, e?.message ?? e);
  }
}

/**
 * 带缓存的抓取：
 * - offline=true 时只读缓存；
 * - 在线时先请求，成功写缓存；失败回落到缓存；
 * - 两者都拿不到返回 null（调用方决定是否告警）。
 */
export async function withSourceCache<T>(
  ctx: SourceContext,
  id: string,
  fetcher: () => Promise<T>,
): Promise<T | null> {
  const cached = readSourceCache<{ cached_at: string; data: T }>(ctx, id);
  if (ctx.offline) return cached?.data ?? null;
  try {
    const data = await fetcher();
    writeSourceCache(ctx, id, data);
    return data;
  } catch (e: any) {
    if (cached?.data !== undefined) {
      ctx.log(`[source:${id}] 抓取失败，使用缓存(${cached.cached_at}):`, e?.message ?? e);
      return cached.data;
    }
    ctx.log(`[source:${id}] 抓取失败且无缓存:`, e?.message ?? e);
    return null;
  }
}

/** 简易 HTML 去标签，用于从公告页正文抽文本 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
