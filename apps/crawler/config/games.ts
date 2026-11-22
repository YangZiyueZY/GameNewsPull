export interface GameConfig {
  key: string;
  name: string;
  mid: string;
  icon: string;
  aliases: string[];
}

// 全部经过官网蓝 V 认证核验（official_verify.type === 1）
export const GAMES: GameConfig[] = [
  { key: 'genshin', name: '原神', mid: '401742377', icon: '/icons/genshin.svg', aliases: ['原神', 'Genshin'] },
  { key: 'zzz', name: '绝区零', mid: '1636034895', icon: '/icons/zzz.svg', aliases: ['绝区零', 'ZZZ'] },
  { key: 'endfield', name: '明日方舟：终末地', mid: '1265652806', icon: '/icons/endfield.svg', aliases: ['终末地', 'Endfield'] },
  { key: 'hsr', name: '崩坏：星穹铁道', mid: '1340190821', icon: '/icons/hsr.svg', aliases: ['星穹铁道', '崩铁', 'HSR'] },
  { key: 'yh', name: '异环', mid: '3546636978489848', icon: '/icons/yh.svg', aliases: ['异环', 'Neverness to Everness', 'Ananta'] },
];

export const GAME_BY_MID = new Map(GAMES.map(g => [g.mid, g]));
