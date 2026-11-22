import { tsToIso } from '../utils/datetime.ts';
import type { GameConfig } from '../../config/games.ts';

export interface NewsItem {
  id: string;
  game_key: string;
  game_name: string;
  type: 'video' | 'dynamic' | 'forward';
  title: string;
  summary: string;
  published_at: string;
  url: string;
  bvid?: string;
  cover?: string;
  duration?: string;
  images: string[];
  source_mid: string;
  source_name: string;
}

export function normalizeDynamic(item: any, game: GameConfig): NewsItem | null {
  const modules = item.modules || {};
  const author = modules.module_author || {};
  const dyn = modules.module_dynamic || {};
  const pubTs = author.pub_ts || item.pub_ts;
  const publishedAt = pubTs ? tsToIso(pubTs) : new Date().toISOString();
  const dynamicUrl = `https://www.bilibili.com/opus/${item.id_str || item.id}`;
  const base = {
    id: String(item.id_str || item.id),
    game_key: game.key,
    game_name: game.name,
    published_at: publishedAt,
    url: dynamicUrl,
    source_mid: game.mid,
    source_name: author.name || game.name,
    images: [] as string[],
  };

  if (item.type === 'DYNAMIC_TYPE_AV' || item.type === 'DYNAMIC_TYPE_PGC') {
    const arc = dyn.major?.archive;
    if (!arc) return null;
    return {
      ...base,
      type: 'video',
      title: arc.title || '(无标题)',
      summary: (arc.desc || '').slice(0, 500),
      bvid: arc.bvid,
      cover: arc.cover?.replace(/^http:/, 'https:'),
      duration: arc.duration_text,
      url: arc.jump_url ? `https:${arc.jump_url}` : dynamicUrl,
    };
  }

  if (item.type === 'DYNAMIC_TYPE_FORWARD') {
    const orig = item.orig || {};
    const origMods = orig.modules || {};
    const origDyn = origMods.module_dynamic || {};
    const forwardText = (dyn.desc?.text || '').trim();
    const origText = (origDyn.desc?.text || '').trim();
    const origArchive = origDyn.major?.archive;
    const title = origArchive?.title || origText.split('\n')[0] || forwardText.split('\n')[0] || '转发动态';
    const summary = [forwardText, origText, origArchive?.desc || ''].filter(Boolean).join('\n').slice(0, 800);
    return {
      ...base,
      type: 'forward',
      title: title.length > 60 ? title.slice(0, 60) + '…' : title,
      summary,
      bvid: origArchive?.bvid,
      cover: origArchive?.cover?.replace(/^http:/, 'https:'),
      url: origArchive?.jump_url ? `https:${origArchive.jump_url}` : dynamicUrl,
      images: (origDyn.major?.draw?.items || []).map((i: any) => i.src?.replace(/^http:/, 'https:')).filter(Boolean),
    };
  }

  const text = (dyn.desc?.text || '').trim();
  const drawItems = dyn.major?.draw?.items || [];
  const images = drawItems.map((i: any) => i.src?.replace(/^http:/, 'https:')).filter(Boolean);
  if (!text && !images.length) return null;
  const firstLine = text.split('\n').find((l: string) => l.trim())?.trim() || '[图片动态]';
  return {
    ...base,
    type: 'dynamic',
    title: firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine,
    summary: text.slice(0, 500),
    images,
  };
}

export function classifyMedia(item: NewsItem): string | null {
  if (item.type !== 'video' || !item.title) return null;
  const t = item.title;
  if (/前瞻|特别节目|直播回放|回顾/.test(t)) return 'preview_program';
  if (/版本\s*PV|版本PV|版本宣传/.test(t)) return 'version_pv';
  if (/角色PV|角色展示|角色演示|角色预告/.test(t)) return 'character_pv';
  if (/动画短片|短片|动画/.test(t)) return 'short_film';
  if (/PV|PV[|｜]|宣传|预告|OP|ED/i.test(t)) return 'promotional_pv';
  return null;
}
