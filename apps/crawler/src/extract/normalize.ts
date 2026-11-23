import { tsToIso } from '../utils/datetime.ts';
import type { GameConfig } from '../../config/games.ts';
import {
  readDynamicText,
  readDynamicImages,
  readDynamicTitle,
  readDynamicOpusTitle,
  toHttpsUrl,
} from './opus.ts';

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

const toHttps = (url: any): string | undefined => toHttpsUrl(url) || undefined;

function normalizeVideo(item: any, game: GameConfig, author: any, dynamicUrl: string, publishedAt: string): NewsItem | null {
  const arc = item?.modules?.module_dynamic?.major?.archive;
  if (!arc) return null;
  return {
    id: String(item.id_str || item.id),
    game_key: game.key,
    game_name: game.name,
    published_at: publishedAt,
    url: toHttps(arc.jump_url) ?? dynamicUrl,
    source_mid: game.mid,
    source_name: author.name || game.name,
    images: [],
    type: 'video',
    title: arc.title || '(无标题)',
    summary: (arc.desc || '').slice(0, 500),
    bvid: arc.bvid,
    cover: toHttps(arc.cover),
    duration: arc.duration_text,
  };
}

function normalizeForward(item: any, game: GameConfig, author: any, dynamicUrl: string, publishedAt: string): NewsItem | null {
  const orig = item.orig || {};
  const origArchive = orig?.modules?.module_dynamic?.major?.archive;
  // 转发者自己说的话（通常很短，或者只是抽奖结果）
  const forwardText = (item?.modules?.module_dynamic?.desc?.text || '').trim();
  // 被转发内容的正文：orig 已是 Opus 格式时必须走统一读取
  const origText = readDynamicText(orig);
  const title = origArchive?.title
    || readDynamicTitle(orig)
    || readDynamicText(item).split('\n')[0]
    || forwardText.split('\n')[0]
    || '转发动态';
  const summary = [forwardText, origText, origArchive?.desc || ''].filter(Boolean).join('\n').slice(0, 800);
  const images = readDynamicImages(orig);

  if (!title && !summary && !images.length) return null;

  return {
    id: String(item.id_str || item.id),
    game_key: game.key,
    game_name: game.name,
    published_at: publishedAt,
    url: toHttps(origArchive?.jump_url) ?? dynamicUrl,
    source_mid: game.mid,
    source_name: author.name || game.name,
    images,
    type: 'forward',
    title: title.length > 60 ? title.slice(0, 59) + '…' : title,
    summary,
    bvid: origArchive?.bvid,
    cover: toHttps(origArchive?.cover),
  };
}

export function normalizeDynamic(item: any, game: GameConfig): NewsItem | null {
  const modules = item?.modules || {};
  const author = modules.module_author || {};
  const pubTs = author.pub_ts || item?.pub_ts;
  const publishedAt = pubTs ? tsToIso(pubTs) : new Date().toISOString();
  const dynamicUrl = `https://www.bilibili.com/opus/${item?.id_str || item?.id}`;

  if (item?.type === 'DYNAMIC_TYPE_AV' || item?.type === 'DYNAMIC_TYPE_PGC') {
    return normalizeVideo(item, game, author, dynamicUrl, publishedAt);
  }

  if (item?.type === 'DYNAMIC_TYPE_FORWARD') {
    return normalizeForward(item, game, author, dynamicUrl, publishedAt);
  }

  // 图文动态：Opus（major.opus）与旧版 major.draw 统一读取，
  // 只要 text 或 images 有一个非空就必须保留（旧实现只读 desc.text 导致整类丢失）。
  const text = readDynamicText(item);
  const images = readDynamicImages(item);
  if (!text && !images.length) return null;

  const title = readDynamicTitle(item)
    || readDynamicOpusTitle(item)
    || '[图片动态]';

  return {
    id: String(item.id_str || item.id),
    game_key: game.key,
    game_name: game.name,
    published_at: publishedAt,
    url: dynamicUrl,
    source_mid: game.mid,
    source_name: author.name || game.name,
    images,
    type: 'dynamic',
    title: title.length > 60 ? title.slice(0, 59) + '…' : title,
    summary: text.slice(0, 500),
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
