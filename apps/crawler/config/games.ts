export type GameStage = 'live' | 'prelaunch';

export interface GameConfig {
  key: string;
  name: string;
  mid: string;
  icon: string;
  aliases: string[];
  publisher: string;                       // PublisherConfig.key
  stage: GameStage;
  /** 是否有可抓取的 B 站国服官号（碧蓝航线国服 mid 未确认，仅走日服/国际服 JSON） */
  bili?: boolean;
  official: { name: string; mid: string; url: string };
  download: { available: boolean; label: string; url: string | null };
  release: { label: string; date: string | null };   // date 为 ISO 8601 或 null（官方未公布不编造）
}

const LIVE_RELEASE = { label: '已上线', date: null };
const LIVE_DOWNLOAD = { available: true, label: '官方下载', url: null };
// 未上线：本站不提供下载链接，也不编造上线日期
const PRELAUNCH_DOWNLOAD = { available: false, label: '未开放下载 · 预约中', url: null };
// 档期来自官方动态（2026-11-24 抓取核验）：
//   因缘精灵「幸福测试 11 月 25 日开启 · 公测定档 2027 年春季」
//   蓝色星原「11 月 26 日正式公测」 白银之城「全球公测正式定档 2026 年 12 月 14 日」
// 仍属未上线（stage=prelaunch、不开放下载），只是公布档期不再写「待官方公布」。
const RESERVE_RELEASE = { label: '幸福测试 11 月 25 日开启 · 公测定档 2027 年春季', date: null };

const official = (name: string, mid: string) => ({ name, mid, url: `https://space.bilibili.com/${mid}` });

// 全部经过官网蓝 V 认证核验（official_verify.type === 1）
export const GAMES: GameConfig[] = [
  // —— 米哈游 ——
  {
    key: 'genshin', name: '原神', mid: '401742377', icon: '/icons/genshin.svg',
    aliases: ['原神', 'Genshin'], publisher: 'mihoyo', stage: 'live',
    official: official('原神', '401742377'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  {
    key: 'zzz', name: '绝区零', mid: '1636034895', icon: '/icons/zzz.svg',
    aliases: ['绝区零', 'ZZZ'], publisher: 'mihoyo', stage: 'live',
    official: official('绝区零', '1636034895'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  {
    key: 'hsr', name: '崩坏：星穹铁道', mid: '1340190821', icon: '/icons/hsr.svg',
    aliases: ['星穹铁道', '崩铁', 'HSR'], publisher: 'mihoyo', stage: 'live',
    official: official('崩坏：星穹铁道', '1340190821'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  {
    key: 'nexusanima', name: '崩坏：因缘精灵', mid: '3546886017387331', icon: '/icons/nexusanima.svg',
    aliases: ['因缘精灵', '崩坏：因缘精灵', 'Nexus Anima'], publisher: 'mihoyo', stage: 'prelaunch',
    official: official('崩坏：因缘精灵', '3546886017387331'), download: PRELAUNCH_DOWNLOAD, release: RESERVE_RELEASE,
  },
  // —— 鹰角网络 ——
  {
    key: 'arknights', name: '明日方舟', mid: '161775300', icon: '/icons/arknights.svg',
    aliases: ['明日方舟', 'Arknights'], publisher: 'hypergryph', stage: 'live',
    official: official('明日方舟', '161775300'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  {
    key: 'endfield', name: '明日方舟：终末地', mid: '1265652806', icon: '/icons/endfield.svg',
    aliases: ['终末地', 'Endfield'], publisher: 'hypergryph', stage: 'live',
    official: official('明日方舟：终末地', '1265652806'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  // —— 库洛游戏 ——
  {
    key: 'wutheringwaves', name: '鸣潮', mid: '1955897084', icon: '/icons/wutheringwaves.svg',
    aliases: ['鸣潮', 'Wuthering Waves'], publisher: 'kuro', stage: 'live',
    official: official('鸣潮', '1955897084'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  // —— 悠星网络 ——
  {
    key: 'bluearchive', name: '蔚蓝档案', mid: '3493265644980448', icon: '/icons/bluearchive.svg',
    aliases: ['蔚蓝档案', '碧蓝档案', 'Blue Archive', 'BA'], publisher: 'yostar', stage: 'live',
    official: official('蔚蓝档案', '3493265644980448'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  // —— 蛮啾网络 ——
  {
    // 2026-11-26 正式公测、已开放下载（决策 q7=A）：卡池走 B 站官号「弦定观测」解析
    key: 'azurpromilia', name: '蓝色星原：旅谣', mid: '3546569016085336', icon: '/icons/azurpromilia.svg',
    aliases: ['蓝色星原', '蓝色星原：旅谣', 'Azur Promilia'], publisher: 'manjuu', stage: 'live',
    official: official('蓝色星原：旅谣', '3546569016085336'), download: LIVE_DOWNLOAD,
    release: { label: '2026 年 11 月 26 日正式公测', date: '2026-11-26T00:00:00+08:00' },
  },
  // —— 乐元素 ——
  {
    key: 'silverpalace', name: '白银之城', mid: '3546879304403742', icon: '/icons/silverpalace.svg',
    aliases: ['白银之城', 'Silver Palace'], publisher: 'happyelements', stage: 'prelaunch',
    official: official('白银之城', '3546879304403742'), download: PRELAUNCH_DOWNLOAD,
    release: { label: '全球公测定档 2026 年 12 月 14 日', date: '2026-12-14T00:00:00+08:00' },
  },
  // —— 蛮啾网络（碧蓝航线）——
  // 决策 q8=B：纳入本站，但只用日服/国际服官方 JSON（国服 B 站官号 mid 未确认，故 bili:false）
  {
    key: 'azurlane', name: '碧蓝航线', mid: '233114659', icon: '/icons/azurlane.svg',
    aliases: ['碧蓝航线', 'Azur Lane', 'AL', '碧蓝'], publisher: 'manjuu', stage: 'live',
    official: official('碧蓝航线', '233114659'),
    download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
  // —— 完美世界 ——
  {
    key: 'yh', name: '异环', mid: '3546636978489848', icon: '/icons/yh.svg',
    aliases: ['异环', 'Neverness to Everness', 'Ananta'], publisher: 'perfectworld', stage: 'live',
    official: official('异环', '3546636978489848'), download: LIVE_DOWNLOAD, release: LIVE_RELEASE,
  },
];

export const GAME_BY_MID = new Map(GAMES.map(g => [g.mid, g]));
export const GAME_BY_KEY = new Map(GAMES.map(g => [g.key, g]));
export const GAME_STAGE = new Map(GAMES.map(g => [g.key, g.stage]));
