# 二游资讯 · 厂商标签页 / 活动 / 生日 契约 v3

> 本文件是并行开发的唯一接口契约。data-core 与 ui-core 都以此为准；任何字段变更必须先改本文件并通知 lead。

## 1. 文件归属（避免并行冲突）

| 归属 | 文件 |
|---|---|
| lead | `plans/**`、`scripts/**`、最终集成 |
| data-core | `apps/crawler/**`、`tests/**`、`data/store.json`、`data/birthdays.json`、`data/health.json` |
| ui-core | `apps/web/src/**`、`apps/web/index.html`、`apps/web/src/style.css` |
| asset-flash | `apps/web/public/favicon*`、`apps/web/public/icon-*.png`、`apps/web/public/site.webmanifest`、`README.md` |

- 不修改对方归属文件；需要对方改动时先通知 lead。
- `apps/web/public/feed.json`、`docs/**` 由 lead 在集成阶段统一重建，data-core 只允许通过 crawler 写 feed.json。

## 2. 厂商

```ts
export interface PublisherConfig {
  key: string;        // mihoyo / hypergryph / kuro / yostar / manjuu / happyelements / perfectworld
  name: string;       // 米哈游 / 鹰角网络 / ...
  color: string;      // 仅用于小圆点、激活下划线，不改变整体琥珀主色
  order: number;
}
```

顺序：米哈游、鹰角网络、库洛游戏、悠星网络、蛮啾网络、乐元素、完美世界。

## 3. 游戏配置

```ts
export interface GameConfig {
  key: string;
  name: string;
  mid: string;
  icon: string;
  aliases: string[];
  publisher: string;                       // PublisherConfig.key
  stage: 'live' | 'prelaunch';
  official: { name: string; mid: string; url: string }; // url = https://space.bilibili.com/<mid>
  download: { available: boolean; label: string; url: string | null };
  release: { label: string; date: string | null };      // ISO 8601 或 null
}
```

### 11 款游戏与 UID（已核验）

| 游戏 | key | mid | 厂商 | stage |
|---|---|---|---|---|
| 原神 | genshin | 401742377 | mihoyo | live |
| 绝区零 | zzz | 1636034895 | mihoyo | live |
| 崩坏：星穹铁道 | hsr | 1340190821 | mihoyo | live |
| 崩坏：因缘精灵 | nexusanima | 3546886017387331 | mihoyo | prelaunch |
| 明日方舟 | arknights | 161775300 | hypergryph | live |
| 明日方舟：终末地 | endfield | 1265652806 | hypergryph | live |
| 鸣潮 | wutheringwaves | 1955897084 | kuro | live |
| 蔚蓝档案 | bluearchive | 3493265644980448 | yostar | live |
| 蓝色星原：旅谣 | azurpromilia | 3546569016085336 | manjuu | prelaunch |
| 白银之城 | silverpalace | 3546879304403742 | happyelements | prelaunch |
| 异环 | yh | 3546636978489848 | perfectworld | live |

- 最后 3 款（因缘精灵 / 蓝色星原 / 白银之城）必须 `stage: 'prelaunch'`、`download.available: false`，卡片不显示版本号 / 卡池 / 距离更新。
- 官方已公布档期时，`release.date` 可填官方日期（仍保持 `stage: 'prelaunch'` 直到正式上线）：
  - 蓝色星原：`2026-11-26T00:00:00+08:00`，label「预下载已开启 · 11 月 26 日正式公测」。
  - 白银之城：`2026-12-14T00:00:00+08:00`，label「全球公测定档 2026 年 12 月 14 日」。
  - 因缘精灵：`release.date = null`，label「幸福测试 11 月 25 日开启 · 公测定档 2027 年春季」。
- 没有官方日期的游戏不得编造；`release.days_until` 由程序计算。

## 4. feed.json v3

顶层：

```json
{
  "schema_version": 3,
  "generated_at": "2026-11-24T...",
  "publishers": [{ "key": "mihoyo", "name": "米哈游", "color": "#ffb454", "order": 1 }],
  "ui": { "page": {}, "sections": [] },
  "data": { "games": [] },
  "media": { "categories": [], "items": [] },
  "news": []
}
```

`data.games[i]` 在旧字段（game_name / key / icon_url / current_version / next_version / up_banners / sources ...）基础上新增：

```ts
{
  publisher_key: string;
  publisher_name: string;
  publisher_color: string;
  stage: 'live' | 'prelaunch';
  official_account: { mid: string; name: string; url: string };
  download: { available: boolean; label: string; url: string | null };
  release: { label: string; date: string | null; days_until: number | null };
  events: EventItem[];      // 最多 3 条
  birthdays: BirthdayItem[]; // 最多 4 条；没有数据必须是 []
}
```

```ts
export interface EventItem {
  id: string;
  title: string;
  category: 'event' | 'prelaunch';
  status: '进行中' | '即将开始' | '已结束' | '时间待定';
  start_at: string | null;       // ISO
  end_at: string | null;         // ISO
  days_remaining: number | null; // 仅进行中
  note: string | null;
  url: string | null;            // 官方动态 / 公告
  source: 'curated' | 'official';
}

export interface BirthdayItem {
  character: string;
  month_day: string;             // 'MM-DD'
  next_at: string;               // 下一次生日 00:00 +08:00
  days_until: number;
  days_since: number | null;     // 最近一次生日过去的天数（0=今天；未来生日为 null）
  state: 'today' | 'upcoming' | 'recent' | 'far';
  url: string | null;            // 官方生日贺图动态
  source: 'curated' | 'official';
}
```

规则：
- `events` 为空数组时前端隐藏「当前活动」块；`birthdays` 为空数组时前端**完全隐藏**「角色生日」块（不显示空占位、不显示“暂无”）。
- 活动排序：进行中 → 即将开始 → 时间待定 → 最近结束。
- 生日仅收录有官方生日企划的游戏；从官方 `#角色# #生日快乐#` 动态学习，落盘累积到 `data/birthdays.json`。
- 旧字段必须保留，避免 RSS / 现有测试 / 旧前端回归。

## 5. 前端组件 API

```ts
// PublisherTabs.vue
props: { publishers: Publisher[]; modelValue: string; counts: Record<string, number> }
emits: { 'update:modelValue': [key: string] }

// GameCard.vue
props: { game: Game }
emits: { 'play-media': [media: MediaItem]; 'show-sources': [game: Game] }

// EventList.vue
props: { events: EventItem[]; stage: 'live' | 'prelaunch' }

// BirthdayList.vue
props: { birthdays: BirthdayItem[] }
```

交互：
- 默认选中 `mihoyo`；若无该厂商则选第一个。
- 点击标签切换；左右方向键 / Home / End 可切换；`#publisher=mihoyo` 深链；`history.replaceState` 同步，不新增历史记录。
- 标签栏 `role="tablist"`，按钮 `role="tab"` + `aria-selected`；面板 `role="tabpanel"`。
- 卡片保留：官方影像、版本内容、限定卡池、最新动态、信源弹窗、视频弹窗。
- 预约卡：显示「未开放下载 · 预约中」、官方账号按钮、预热里程碑；隐藏版本统计 / 卡池 / 距离更新。
- 视觉：保留现有深色 + 琥珀 `#ffb454` 风格；厂商色只做小圆点 / 激活下划线。

## 6. 验收命令

```bash
npm test
npm run web:build
curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/
```

- 11 款游戏全部出现且只出现一次；7 个标签计数 4/2/1/1/1/1/1。
- 无生日数据的游戏不渲染生日块。
- 控制台无报错，桌面 1440 / 移动 390 无横向溢出。
