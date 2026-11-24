/** 静态资源路径：相对路径在 base:'./' 下需补 './'；远程图在 dev 走 /img 代理 */
export function img(url?: string | null): string {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) {
    return typeof location !== 'undefined' && location.port === '5173'
      ? '/img?u=' + encodeURIComponent(url)
      : url;
  }
  return url.startsWith('./') || url.startsWith('/') ? url : './' + url;
}

/** MM-DD HH:mm（本地时区） */
export function fmtDate(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** MM-DD */
export function fmtDay(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 图标兜底用的首字 */
export function initials(name?: string | null): string {
  return (name || '?').trim().slice(0, 1) || '?';
}

/** 相对天数：0 → 今天，1 → 明天，n → n 天后 */
export function relDay(n?: number | null): string {
  if (n == null) return '';
  if (n <= 0) return '今天';
  if (n === 1) return '明天';
  return `${n} 天后`;
}

/** 剩余天数文案（活动） */
export function remainText(n?: number | null): string {
  if (n == null) return '';
  if (n <= 0) return '今天结束';
  return `剩余 ${n} 天`;
}

/**
 * 去掉标题前面与游戏同名的冗余话题标签，例如：
 *   "#原神# #原神7.2版本# 旅行者好呀~" → "旅行者好呀~"
 *   "#崩坏星穹铁道# #此刻将群星付之一笑#" → "#此刻将群星付之一笑#"
 * 只做展示层清理，不改数据。
 */
export function cleanTitle(text?: string | null, _gameName?: string | null): string {
  const raw = (text || '').trim();
  if (!raw) return '';

  // 去掉标题开头的全部话题标签（官方动态常用 #游戏# #版本# 做前缀）。
  // 例如 "#崩坏星穹铁道# #此刻将群星付之一笑# 「位面分裂」活动说明"
  //   → "「位面分裂」活动说明"。
  // 只有标签、没有实际正文的条目返回空串，由调用方过滤。
  let s = raw;
  for (let i = 0; i < 6; i += 1) {
    const m = /^#([^#]{1,40})#(?:[\s\u200b\u3000]|\uFEFF)*/.exec(s);
    if (!m) break;
    const next = s.slice(m[0].length).trim();
    if (!next) return '';
    s = next;
  }
  return s;
}
