// 异环角色名单适配器（id: nte-guide，tier L2，games: ['yh']）。
// 数据源：https://nteguide.com/api/characters.json
// 该站明确只提供角色图鉴、不提供当期卡池，因此 collect() 恒返回 []（并打日志），
// 只实现 roster(ctx) 给 resolver 做角色名校验。
import { fetchJson, withSourceCache } from '../http.ts';
import type { CharacterBookEntry, SourceAdapter, SourceContext } from '../../pools/types.ts';

const CACHE_ID = 'nte-guide';
const CHARACTERS_URL = 'https://nteguide.com/api/characters.json';

interface NteCharacter {
  id?: string;
  name?: string;
  nameCn?: string;
  slug?: string;
  element?: string;
  weapon?: string;
  rarity?: number;
  role?: string;
}

/** characters.json 条目 → 角色字典条目 */
export function parseNteCharacters(raw: unknown): CharacterBookEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterBookEntry[] = [];
  for (const item of raw as NteCharacter[]) {
    if (!item || typeof item !== 'object') continue;
    const cn = String(item.nameCn ?? '').trim();
    const en = String(item.name ?? '').trim();
    if (!cn && !en) continue;
    const aliases: string[] = [];
    for (const cand of [String(item.slug ?? '').trim(), en, cn]) {
      if (!cand) continue;
      if (cand === cn || cand === en) continue;
      if (aliases.indexOf(cand) >= 0) continue;
      aliases.push(cand);
    }
    out.push({
      game_key: 'yh',
      cn: cn || en,
      en: en || null,
      aliases: aliases,
    });
  }
  return out;
}

export async function collectNteRoster(ctx: SourceContext): Promise<CharacterBookEntry[]> {
  const raw = await withSourceCache<unknown>(ctx, CACHE_ID, () => fetchJson(CHARACTERS_URL));
  if (!raw) {
    ctx.log('[source:nte-guide] 角色名单不可用（离线无缓存或请求失败），返回空');
    return [];
  }
  const roster = parseNteCharacters(raw);
  if (roster.length === 0) ctx.log('[source:nte-guide] 角色名单为空');
  return roster;
}

export const nteGuideAdapter: SourceAdapter = {
  id: 'nte-guide',
  tier: 'L2',
  label: '异环 NTE Guide 角色库',
  games: ['yh'],
  // 该站不提供当期卡池，只做角色名单校验
  collect: async (ctx: SourceContext) => {
    ctx.log('[source:nte-guide] 该站不提供当期卡池，collect 返回空');
    return [];
  },
  roster: collectNteRoster,
};

export default nteGuideAdapter;
