export function tsToIso(ts: string | number): string {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

export function cnDateToIso(text: string): string | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h = '0', min = '0'] = m;
    return new Date(+y, +mo - 1, +d, +h, +min).toISOString();
  }
  const m2 = text.match(/(\d{1,2})月(\d{1,2})日(?:(\d{1,2}):(\d{2}))?/);
  if (m2) {
    const now = new Date();
    const [, mo, d, h = '0', min = '0'] = m2;
    return new Date(now.getFullYear(), +mo - 1, +d, +h, +min).toISOString();
  }
  return null;
}
