export interface BannerPeriod {
  label: string;          // 第 1 期 / 上半 / 返场
  characters: string[];   // 卡池内角色
  start: string | null;   // ISO，开始时间
  end: string | null;     // ISO，结束时间；null 表示官方未公布
  note?: string;
}

// 限定卡池时段：B站官方动态只公布角色、不公布结束时间，
// 因此这里人工维护时段，程序自动计算「剩余天数 / 状态」。
// 官方发布新卡池后，在对应游戏下追加一条即可。
export const BANNERS: Record<string, BannerPeriod[]> = {
  genshin: [
    { label: '第 1 期', characters: ['米提亚', '芙宁娜'], start: '2026-11-04T00:00:00+08:00', end: '2026-11-24T17:59:00+08:00' },
    { label: '第 2 期', characters: ['莉奈娅'], start: '2026-11-24T18:00:00+08:00', end: null },
  ],
  zzz: [
    { label: '上半', characters: ['菲欧妮', '维琳娜'], start: '2026-10-21T00:00:00+08:00', end: '2026-11-11T11:59:00+08:00' },
    { label: '下半', characters: ['赛维里安', '诺姆'], start: '2026-11-11T12:00:00+08:00', end: '2026-12-01T14:59:00+08:00' },
  ],
  endfield: [
    { label: '第 1 期', characters: ['祀'], start: '2026-10-15T12:00:00+08:00', end: '2026-11-05T11:59:00+08:00' },
    { label: '重构寻访', characters: ['汤汤'], start: '2026-10-29T12:00:00+08:00', end: '2026-11-19T11:59:00+08:00' },
    { label: '第 2 期', characters: ['明河'], start: '2026-11-05T12:00:00+08:00', end: null },
  ],
  hsr: [],
  yh: [
    { label: '第 1 期', characters: ['曳尔沐'], start: '2026-11-05T00:00:00+08:00', end: '2026-11-26T05:59:00+08:00' },
    { label: '返场', characters: ['真红'], start: '2026-11-05T00:00:00+08:00', end: '2026-11-26T05:59:00+08:00' },
  ],
};
