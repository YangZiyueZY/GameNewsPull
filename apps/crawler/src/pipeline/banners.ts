// 卡池管线：把「多信源适配器 → 合并校验 → 写回 feed」串起来。
// 设计：适配器各自失败互不影响；任一失败只丢该源，不影响其它源与站点输出。
import type { SourceAdapter, SourceContext, PoolCandidate, CharacterBookEntry, ResolvedPool, CharacterBook } from '../pools/types.ts';
import { resolvePools, applyPoolsToFeed } from '../pools/resolver.ts';
import { loadCharBook, buildRosterIndex, mergeCharBook, writeCharBook } from '../pools/roster.ts';

export interface BannerPipelineResult {
  /** 本轮自动扩写进 data/char-names.json 的角色条数（新增 / 补齐） */
  dictAdded: number;
  dictUpdated: number;
  /** 已写入卡池的 feed（新对象，必须用它替换原 feed） */
  feed: any;
  pools: ResolvedPool[];
  warnings: string[];
  sourceStats: Array<{ id: string; candidates: number; ok: boolean; error?: string }>;
}

export async function runBannerPipeline(
  ctx: SourceContext,
  adapters: SourceAdapter[],
  feed: any,
): Promise<BannerPipelineResult> {
  const sourceStats: BannerPipelineResult['sourceStats'] = [];
  // 适配器为空（开发中/离线未配置）时不要执行 applyPoolsToFeed，否则会把已有卡池清空
  if (!adapters.length) {
    ctx.log('[banners] 未配置任何信源适配器，跳过卡池重算（保留既有 up_banners）');
    return { feed, pools: [], warnings: ['未配置信源适配器，跳过卡池重算'], sourceStats, dictAdded: 0, dictUpdated: 0 };
  }
  const candidates: PoolCandidate[] = [];
  const rosterEntries: CharacterBookEntry[] = [];

  for (const adapter of adapters) {
    try {
      const collected = await adapter.collect(ctx);
      // 外服排期（如 BA 的 server=GL/JP）只用于交叉校验，不渲染到国服卡片
      const produced = collected.filter((p) => !/\bserver=(GL|JP|TW)\b/i.test(String(p.note ?? '')));
      const filtered = collected.length - produced.length;
      sourceStats.push({ id: adapter.id, candidates: produced.length, ok: true, ...(filtered ? { error: 'filtered ' + filtered + ' 外服候选' } : {}) });
      for (const p of produced) candidates.push({ ...p, source: { ...p.source, id: adapter.id, tier: adapter.tier } });
    } catch (e: any) {
      sourceStats.push({ id: adapter.id, candidates: 0, ok: false, error: e?.message ?? String(e) });
      ctx.log('[banners] 信源 ' + adapter.id + ' 异常（已跳过）:', e?.message ?? e);
    }
    if (adapter.roster) {
      try {
        for (const entry of await adapter.roster(ctx)) rosterEntries.push(entry);
      } catch (e: any) {
        ctx.log('[banners] 信源 ' + adapter.id + ' roster 失败（已跳过）:', e?.message ?? e);
      }
    }
  }

  const book: CharacterBook = loadCharBook(ctx.dataDir);
  // ① 角色字典自动扩写：各源 roster 是「每天都会变」的活数据，写回字典后
  //    新角色次日即可通过校验，不需要人工维护（人工只需在冲突时校正）。
  const mergedBook = mergeCharBook(book, rosterEntries);
  const dictAdded = mergedBook.added;
  const dictUpdated = mergedBook.updated;
  if (dictAdded || dictUpdated) {
    mergedBook.book.generated_at = ctx.nowCst;
    writeCharBook(ctx.dataDir, mergedBook.book);
    ctx.log('[banners] 角色字典自动扩写：新增 ' + dictAdded + ' 条、补齐 ' + dictUpdated + ' 条');
  }
  const index = buildRosterIndex([...bookEntries(mergeCharBook(mergedBook.book, []).book)]);
  const { pools, warnings } = resolvePools(candidates, { now: ctx.now, rosterIndex: index });
  const applied = applyPoolsToFeed(feed, pools);

  // applyPoolsToFeed 返回新对象，这里必须把 feed 一并带出去，否则调用方拿到的还是旧 feed
  return { feed: applied.feed ?? feed, pools, warnings: [...warnings, ...(applied.warnings ?? [])], sourceStats, dictAdded, dictUpdated };
}

function bookEntries(book: CharacterBook): CharacterBookEntry[] {
  const out: CharacterBookEntry[] = [];
  for (const [gameKey, list] of Object.entries(book.games ?? {})) {
    for (const entry of list ?? []) out.push({ game_key: gameKey, ...entry });
  }
  return out;
}