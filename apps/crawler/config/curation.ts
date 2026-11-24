// 人工活动种子 + 预热里程碑。
//
// 全部条目都来自官方 B 站动态（url 指向对应动态/视频），不编造活动名与日期；
// 官方没有公布结束时间时 end_at 为 null，由 calendar.eventStatus 计算状态。
// status 是人工声明的兜底状态：用于「一次性活动（只有开始时间）」或「尚无日期」的条目，
// 其余情况以 start_at / end_at 计算出的状态为准（见 extract/calendar.ts:fromCurated）。
export type CuratedEventStatus = '进行中' | '即将开始' | '已结束' | '时间待定';

export interface CuratedEvent {
  id: string;
  game: string;                              // GameConfig.key
  title: string;
  category: 'event' | 'prelaunch';
  start_at: string | null;                   // ISO 8601（+08:00）
  end_at: string | null;
  status: CuratedEventStatus;
  note: string | null;
  url: string | null;
  source: 'curated';
}

const BILI = 'https://www.bilibili.com';

export const CURATED_EVENTS: CuratedEvent[] = [
  // ——————————————————————— 原神（7.2 版本进行中活动） ———————————————————————
  // 官方 2026-11-19 动态（opus/1272329947017379840）确认三项活动仍在进行
  {
    id: 'genshin-quanyu-zhenwei',
    game: 'genshin',
    title: '「全域镇卫·逆捍谬罚」活动',
    category: 'event',
    start_at: '2026-11-04T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '7.2 版本期间持续开放，完成驰援行动可自选邀请四星角色',
    url: BILI + '/opus/1265958105361940489',
    source: 'curated',
  },
  {
    id: 'genshin-huaimie-zhaoshi',
    game: 'genshin',
    title: '「坏灭肇始之时」魔神任务限时奖励',
    category: 'event',
    start_at: '2026-11-04T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方 11-19 动态确认奖励活动仍在进行中',
    url: BILI + '/opus/1272329947017379840',
    source: 'curated',
  },
  {
    id: 'genshin-jingshi-rulin',
    game: 'genshin',
    title: '「晶石如林生长之地」区域探索限时奖励',
    category: 'event',
    start_at: '2026-11-04T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方 11-19 动态确认区域探索奖励仍在进行中',
    url: BILI + '/opus/1272329947017379840',
    source: 'curated',
  },

  // ——————————————————————— 绝区零 ———————————————————————
  {
    id: 'zzz-data-bounty',
    game: 'zzz',
    title: '「数据悬赏-实战模拟」活动',
    category: 'event',
    start_at: '2026-11-25T04:00:00+08:00',
    end_at: '2026-11-30T03:59:00+08:00',
    status: '即将开始',
    note: '官方活动说明：实战模拟室双倍奖励',
    url: BILI + '/opus/1273749863225360393',
    source: 'curated',
  },
  {
    id: 'zzz-34-reservation',
    game: 'zzz',
    title: '3.4 版本「决战于黎明之前」预约 & 签到活动',
    category: 'event',
    start_at: '2026-11-20T00:00:00+08:00',
    end_at: '2026-12-02T05:59:00+08:00',
    status: '进行中',
    note: '网页预约与游戏内签到活动进行中',
    url: BILI + '/opus/1272751066454163522',
    source: 'curated',
  },
  {
    id: 'zzz-34-version',
    game: 'zzz',
    title: '3.4 版本「长日终尽」上线',
    category: 'event',
    start_at: '2026-12-02T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：3.4 版本将于 12 月 2 日上线',
    url: BILI + '/opus/1273749863225360393',
    source: 'curated',
  },

  // ——————————————————————— 崩坏：星穹铁道 ———————————————————————
  {
    id: 'hsr-plane-split',
    game: 'hsr',
    title: '「位面分裂」双倍奖励活动',
    category: 'event',
    start_at: '2026-11-23T04:00:00+08:00',
    end_at: '2026-12-07T03:59:00+08:00',
    status: '进行中',
    note: '官方活动说明：模拟宇宙 / 饰品提取双倍奖励',
    url: BILI + '/opus/1273378778045743111',
    source: 'curated',
  },
  {
    id: 'hsr-return-web',
    game: 'hsr',
    title: '「重返群星之旅」回归网页活动',
    category: 'event',
    start_at: '2026-11-11T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '4.7 版本期间开放，最高可得 480 星琼',
    url: BILI + '/opus/1269304572093923336',
    source: 'curated',
  },
  {
    id: 'hsr-aha-exhibition',
    game: 'hsr',
    title: '星神★阿哈特别展览活动',
    category: 'event',
    start_at: '2026-11-11T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：11 月 11 日正式开启',
    url: BILI + '/opus/1266792016175431682',
    source: 'curated',
  },

  // ——————————————————————— 崩坏：因缘精灵（预约） ———————————————————————
  {
    id: 'nexusanima-happiness-test',
    game: 'nexusanima',
    title: '「幸福测试」招募开启',
    category: 'prelaunch',
    start_at: '2026-11-25T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：幸福测试 11 月 25 日开启，可填写问卷参与招募',
    url: BILI + '/video/BV1nm4g6NE71',
    source: 'curated',
  },
  {
    id: 'nexusanima-release-window',
    game: 'nexusanima',
    title: '公测定档 2027 年春季 · App Store 预约开放',
    category: 'prelaunch',
    start_at: null,
    end_at: null,
    status: '时间待定',
    note: '官方公告：公测定档 2027 年春季，App Store 已开放预约',
    url: BILI + '/video/BV1nm4g6NE71',
    source: 'curated',
  },

  // ——————————————————————— 明日方舟 ———————————————————————
  {
    id: 'arknights-snow-reprint',
    game: 'arknights',
    title: 'SideStory「雪山降临1101」限时复刻',
    category: 'event',
    start_at: '2026-11-22T04:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：11 月 22 日 04:00 开启，含新装上架与主题家具复刻',
    url: BILI + '/opus/1273100464188030994',
    source: 'curated',
  },
  {
    id: 'arknights-autumn-tea-party',
    game: 'arknights',
    title: '「秋意茶话会」× 名创优品 合作活动',
    category: 'event',
    start_at: '2026-10-30T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：合作活动现已开启',
    url: BILI + '/opus/1264813692011151366',
    source: 'curated',
  },
  {
    id: 'arknights-audiobook',
    game: 'arknights',
    title: '有声剧「风雪过境」',
    category: 'event',
    start_at: '2026-10-24T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：已上架喜马拉雅，可收听',
    url: BILI + '/opus/1262756492878020614',
    source: 'curated',
  },

  // ——————————————————————— 明日方舟：终末地（丹青渡版本进行中活动） ———————————————————————
  {
    id: 'endfield-sanity-supply',
    game: 'endfield',
    title: '「理智补给」限时活动',
    category: 'event',
    start_at: '2026-11-18T04:00:00+08:00',
    end_at: '2026-11-25T04:00:00+08:00',
    status: '进行中',
    note: '官方活动说明：每日完成指定任务领取理智补给',
    url: BILI + '/opus/1271538814034116615',
    source: 'curated',
  },
  {
    id: 'endfield-pass-boost',
    game: 'endfield',
    title: '「协议通行证」提速任务',
    category: 'event',
    start_at: '2026-11-18T04:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方说明：开放至版本更新维护前',
    url: BILI + '/opus/1272280984403836947',
    source: 'curated',
  },
  {
    id: 'endfield-mushroom-signin',
    game: 'endfield',
    title: '「蕈属集群」限时签到活动',
    category: 'event',
    start_at: '2026-11-21T12:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方活动说明：闪断更新后开启，累计签到 3 日可得寻访凭证与嵌晶玉',
    url: BILI + '/opus/1273131387929493526',
    source: 'curated',
  },

  // ——————————————————————— 鸣潮 ———————————————————————
  {
    id: 'wuwa-38-version',
    game: 'wutheringwaves',
    title: '3.8 版本「旧梦凋零的百合」',
    category: 'event',
    start_at: '2026-11-12T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：11 月 12 日正式开启',
    url: BILI + '/video/BV1L44q6eEyt',
    source: 'curated',
  },
  {
    id: 'wuwa-lahailuo-block',
    game: 'wutheringwaves',
    title: '「拉海洛方块・逆转」休闲活动',
    category: 'event',
    start_at: '2026-11-19T04:00:00+08:00',
    end_at: '2026-12-03T03:59:00+08:00',
    status: '进行中',
    note: '官方活动说明：每日开放新关卡，完成目标领取星声等奖励',
    url: BILI + '/opus/1271866964588888065',
    source: 'curated',
  },
  {
    id: 'wuwa-annual-chapter',
    game: 'wutheringwaves',
    title: '年度篇章《鸣潮：永明的烬焰》',
    category: 'event',
    start_at: '2026-12-22T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：12 月 22 日开启',
    url: BILI + '/video/BV1jKsq6cEEP',
    source: 'curated',
  },

  // ——————————————————————— 蔚蓝档案 ———————————————————————
  {
    id: 'bluearchive-reprint-recruit',
    game: 'bluearchive',
    title: '限时复刻招募【银装素裹，一樽星月】等',
    category: 'event',
    start_at: '2026-11-26T00:00:00+08:00',
    end_at: '2026-12-10T13:59:00+08:00',
    status: '即将开始',
    note: '官方公告：11 月 26 日维护结束后 ~ 12 月 10 日 13:59',
    url: BILI + '/opus/1274105486497546261',
    source: 'curated',
  },
  {
    id: 'bluearchive-art-event',
    game: 'bluearchive',
    title: '限时活动「为谁而存的艺术 ~赝品与美学的归宿~」',
    category: 'event',
    start_at: '2026-11-26T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：11 月 26 日开启',
    url: BILI + '/video/BV1kTs36eEaL',
    source: 'curated',
  },
  {
    id: 'bluearchive-occult-event',
    game: 'bluearchive',
    title: '限时活动「我等乃神秘学研究会！~学院之谜与古老咒文~」',
    category: 'event',
    start_at: '2026-10-29T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：10 月 29 日开启，结束时间未公布',
    url: BILI + '/video/BV1vAnJ6vEqm',
    source: 'curated',
  },

  // ——————————————————————— 蓝色星原：旅谣（预约） ———————————————————————
  {
    id: 'azurpromilia-prepublic',
    game: 'azurpromilia',
    title: '正式公测',
    category: 'prelaunch',
    start_at: '2026-11-26T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：11 月 26 日正式公测，bilibili 预约已开启',
    url: BILI + '/video/BV1NdWo6vEQL',
    source: 'curated',
  },
  {
    id: 'azurpromilia-prepublic-program',
    game: 'azurpromilia',
    title: '公测前瞻节目',
    category: 'prelaunch',
    start_at: '2026-11-20T19:00:00+08:00',
    end_at: null,
    status: '已结束',
    note: '官方直播已于 11 月 20 日 19:00 开播，回顾影像已发布',
    url: BILI + '/opus/1272636622711554145',
    source: 'curated',
  },
  {
    id: 'azurpromilia-trail-test-end',
    game: 'azurpromilia',
    title: '「旅迹测试」已结束',
    category: 'prelaunch',
    start_at: '2026-10-07T16:00:00+08:00',
    end_at: '2026-10-07T16:00:00+08:00',
    status: '已结束',
    note: '官方公告：旅迹测试已于 10 月 7 日 16:00（UTC+8）结束',
    url: BILI + '/opus/1256355265002864695',
    source: 'curated',
  },

  // ——————————————————————— 白银之城（预约） ———————————————————————
  {
    id: 'silverpalace-release-date',
    game: 'silverpalace',
    title: '全球公测定档 2026 年 12 月 14 日',
    category: 'prelaunch',
    start_at: '2026-12-14T00:00:00+08:00',
    end_at: null,
    status: '即将开始',
    note: '官方公告：全球公测正式定档 2026 年 12 月 14 日',
    url: BILI + '/video/BV1BJnR66Eij',
    source: 'curated',
  },
  {
    id: 'silverpalace-hidden-pages',
    game: 'silverpalace',
    title: '「隐藏的书页」角色短片系列',
    category: 'prelaunch',
    start_at: '2026-11-08T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方连载中，持续更新角色短片',
    url: BILI + '/video/BV1ScyXztEMY',
    source: 'curated',
  },
  {
    id: 'silverpalace-character-pv',
    game: 'silverpalace',
    title: '角色 PV「馨西亚二世：到月下的城邦去」',
    category: 'prelaunch',
    start_at: '2026-11-12T00:00:00+08:00',
    end_at: null,
    status: '已结束',
    note: '官方角色 PV 已发布',
    url: BILI + '/video/BV1PoW16NEZN',
    source: 'curated',
  },

  // ——————————————————————— 异环 ———————————————————————
  {
    id: 'yh-stride-collab',
    game: 'yh',
    title: '异环 × 炫迈 联动活动',
    category: 'event',
    start_at: '2026-10-30T00:00:00+08:00',
    end_at: null,
    status: '进行中',
    note: '官方公告：10 月 30 日起联名产品与主题周边线上多平台开售',
    url: BILI + '/video/BV12Gnm6wEAt',
    source: 'curated',
  },
  {
    id: 'yh-15-version',
    game: 'yh',
    title: '1.5 版本「致电，空想迷数」',
    category: 'event',
    start_at: null,
    end_at: null,
    status: '进行中',
    note: '官方已发布版本 PV 与前瞻节目，版本内容持续开放',
    url: BILI + '/video/BV1TExT6eEsF',
    source: 'curated',
  },
];

const BY_GAME: Record<string, CuratedEvent[]> = {};
for (const event of CURATED_EVENTS) {
  (BY_GAME[event.game] ??= []).push(event);
}

/** 取某款游戏的人工活动种子（保持配置顺序） */
export function curatedEventsFor(gameKey: string): CuratedEvent[] {
  return BY_GAME[gameKey] ?? [];
}
