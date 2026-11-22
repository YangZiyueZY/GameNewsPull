import crypto from 'node:crypto';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(raw: string): string {
  return MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
}

export function signWbi(params: Record<string, string | number | boolean>, imgUrl: string, subUrl: string): URLSearchParams {
  const raw = imgUrl.split('/').pop()!.split('.')[0] + subUrl.split('/').pop()!.split('.')[0];
  const mixinKey = getMixinKey(raw);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return new URLSearchParams(query + `&w_rid=${wRid}`);
}
