export interface BannerPeriod {
  label: string;          // 第 1 期 / 上半 / 返场
  /**
   * 卡池内角色：**已废弃手写值**（决策 q5=A）。
   * 角色一律由多信源引擎（apps/crawler/src/pools/）产出并校验；
   * 这里保留字段只为兼容旧调用与测试，config 不再填写。
   */
  characters?: string[];
  start: string | null;   // ISO，开始时间
  end: string | null;     // ISO，结束时间；null 表示官方未公布
  note?: string;
}

// 卡池期次骨架：只维护「期次标签 + 时段」，角色名交给信源引擎。
// 官方公告通常不公布结束时间，因此结束时间仍需人工兜底。
// 新增一期卡池时，只追加 label/start/end，不要写角色名。
export const BANNERS: Record<string, BannerPeriod[]> = {
  genshin: [
    { label: '第 1 期', start: '2026-11-04T00:00:00+08:00', end: '2026-11-24T17:59:00+08:00' },
    { label: '第 2 期', start: '2026-11-24T18:00:00+08:00', end: null },
  ],
  zzz: [
    { label: '上半', start: '2026-10-21T00:00:00+08:00', end: '2026-11-11T11:59:00+08:00' },
    { label: '下半', start: '2026-11-11T12:00:00+08:00', end: '2026-12-01T14:59:00+08:00' },
  ],
  endfield: [
    { label: '第 1 期', start: '2026-10-15T12:00:00+08:00', end: '2026-11-05T11:59:00+08:00' },
    { label: '重构寻访', start: '2026-10-29T12:00:00+08:00', end: '2026-11-19T11:59:00+08:00' },
    { label: '第 2 期', start: '2026-11-05T12:00:00+08:00', end: null },
  ],
  hsr: [],
  yh: [
    { label: '第 1 期', start: '2026-11-05T00:00:00+08:00', end: '2026-11-26T05:59:00+08:00' },
    { label: '返场', start: '2026-11-05T00:00:00+08:00', end: '2026-11-26T05:59:00+08:00' },
  ],
};
