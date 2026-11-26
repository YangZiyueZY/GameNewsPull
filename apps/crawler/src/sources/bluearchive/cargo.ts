// 蔚蓝档案 Cargo 数据适配器（id: bluearchive-cargo，tier L2，games: ['bluearchive']）。
// 数据源：bluearchive.wiki 的 MediaWiki Cargo 查询（banners 表）。
// 口径（契约 q1/q2：只作校验源，不单独渲染国服）：
//   · 只保留 Server=GL / JP 的记录，并在 note 里注明 server=GL 之类，供 resolver 校验；
//   · Cargo 里的时间是 UTC，页面按 +9 展示；这里统一换算成东八区 ISO（+08:00）输出；
//   · 记录缺失日期 → null，不猜。
import { fetchJson, withSourceCache } from '../http.ts';
import type { PoolCandidate, PoolType, SourceAdapter, SourceContext } from '../../pools/types.ts';

const CACHE_ID = 'bluearchive-cargo';
// Cargo query：fields 里的空格必须编码成 %20，否则部分网关会 400
const CARGO_URL =
  'https://bluearchive.wiki/w/api.php?action=cargoquery&format=json&tables=banners' +
  '&fields=Id,Server,Type,NameEN,Rateup_character,Start_date,End_date,Rerun,Limited' +
  '&order_by=Start_date%20DESC&limit=20';

const CST_OFFSET_MS = 8 * 3_600_000;

/** epoch ms → 东八区 ISO（+08:00） */
function cstIso(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

/** 按给定时区（默认 +8）钟面时间构造东八区 ISO；UTC 传 0 */
function cstFromParts(y: number, mo: number, d: number, h = 0, mi = 0, offsetHours = 8): string {
  return cstIso(Date.UTC(y, mo - 1, d, h, mi) - offsetHours * 3_600_000);
}

/**
 * Cargo 的时间字段是 UTC（"2026-11-25 02:00:00"），页面按 +9 展示，例如 02:00Z = 11:00 JST = 10:00 +08:00。
 */
export function parseCargoUtc(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = String(text).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return cstFromParts(+m[1], +m[2], +m[3], +m[4], +m[5], 0);
}

interface CargoRow {
  Id?: string;
  Server?: string;
  Type?: string;
  NameEN?: string;
  'Rateup character'?: string;
  'Start date'?: string;
  'End date'?: string;
  Rerun?: string;
  Limited?: string;
}

/** Cargo 响应条目：{ title: { ...fields } } */
export interface CargoResponse {
  cargoquery?: Array<{ title?: CargoRow }>;
}

/** Rateup 可能一次给多个角色（逗号 / 斜杠 / & 分隔） */
function splitRateup(raw: string | undefined): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[,，/&]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
}

/** 池型映射：Fes → fes；Rerun=1 → rerun_character；其余 = limited_character */
function poolTypeOf(row: CargoRow): PoolType {
  const type = String(row.Type ?? '');
  if (/fes/i.test(type)) return 'fes';
  if (String(row.Rerun ?? '') === '1') return 'rerun_character';
  return 'limited_character';
}

/** 解析 Cargo 行 → 池候选（只保留 GL / JP） */
export function parseCargoResponse(resp: CargoResponse | null, fetchedAt?: string): PoolCandidate[] {
  const rows = resp?.cargoquery ?? [];
  const out: PoolCandidate[] = [];
  for (const item of rows) {
    const row = item?.title;
    if (!row) continue;
    const server = String(row.Server ?? '').trim().toUpperCase();
    if (server !== 'GL' && server !== 'JP') continue; // 国服不由此源渲染
    const rateup = splitRateup(row['Rateup character']);
    const nameEn = String(row.NameEN ?? '').trim();
    // 池名：Cargo 的 NameEN 常为空，退化成「角色名」这一官方标识（不编造活动标题）
    const poolName = nameEn || rateup.join('、') || String(row.Type ?? '');
    if (!poolName) continue;
    const notes = ['server=' + server, 'id=' + String(row.Id ?? '?'), 'type=' + String(row.Type ?? '?')];
    notes.push('rerun=' + String(row.Rerun ?? '0'), 'limited=' + String(row.Limited ?? '0'));
    if (!nameEn) notes.push('池名缺失，取角色名');
    out.push({
      game_key: 'bluearchive',
      pool_name: poolName,
      pool_type: poolTypeOf(row),
      characters: rateup,
      start_at: parseCargoUtc(row['Start date']),
      end_at: parseCargoUtc(row['End date']),
      version: null,
      period: null,
      evidence: [row['Start date'], row['End date'], row['Rateup character']]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 200),
      note: notes.join(';'),
      source: {
        id: CACHE_ID,
        tier: 'L2',
        url: CARGO_URL,
        fetched_at: fetchedAt ?? null,
      },
    });
  }
  return out;
}

export async function collectBlueArchiveCargo(ctx: SourceContext): Promise<PoolCandidate[]> {
  const resp = await withSourceCache<CargoResponse>(ctx, CACHE_ID, () =>
    // wiki 对缺少 Accept/Referer 的请求直接 403，因此显式带上
    fetchJson<CargoResponse>(CARGO_URL, {
      headers: { Accept: 'application/json', Referer: 'https://bluearchive.wiki/' },
    }),
  );
  if (!resp) {
    ctx.log('[source:bluearchive-cargo] Cargo 查询不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const out = parseCargoResponse(resp, ctx.nowCst);
  if (out.length === 0) ctx.log('[source:bluearchive-cargo] 未解析出 GL/JP 卡池');
  return out;
}

export const bluearchiveCargoAdapter: SourceAdapter = {
  id: 'bluearchive-cargo',
  tier: 'L2',
  label: '蔚蓝档案 Cargo 数据',
  games: ['bluearchive'],
  collect: collectBlueArchiveCargo,
};

export default bluearchiveCargoAdapter;
