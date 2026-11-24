// 厂商配置：标签页顺序、显示名与点缀色（仅用于小圆点 / 激活下划线）。
// 顺序即契约规定的标签顺序：米哈游 → 鹰角网络 → 库洛游戏 → 悠星网络 → 蛮啾网络 → 乐元素 → 完美世界。
export interface PublisherConfig {
  key: string;
  name: string;
  color: string;
  order: number;
}

export const PUBLISHERS: PublisherConfig[] = [
  { key: 'mihoyo', name: '米哈游', color: '#7cc7ff', order: 1 },
  { key: 'hypergryph', name: '鹰角网络', color: '#e8e8e8', order: 2 },
  { key: 'kuro', name: '库洛游戏', color: '#ff9f6b', order: 3 },
  { key: 'yostar', name: '悠星网络', color: '#6fe0c4', order: 4 },
  { key: 'manjuu', name: '蛮啾网络', color: '#9bb8ff', order: 5 },
  { key: 'happyelements', name: '乐元素', color: '#ffb3c7', order: 6 },
  { key: 'perfectworld', name: '完美世界', color: '#c9a6ff', order: 7 },
];

export const PUBLISHER_BY_KEY = new Map(PUBLISHERS.map(p => [p.key, p]));
