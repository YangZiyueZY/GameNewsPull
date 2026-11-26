# 二游资讯 · 嵌入用 API v1

面向第三方：直接 fetch 即可，**无需鉴权、无需 Key**。所有端点都是静态 JSON（构建时生成），
主入口走 jsDelivr（自带 `Access-Control-Allow-Origin: *`），回退到 GitHub 原始地址。

> 这份文档会被 `crawl` / `feed:rebuild` 复制到 `docs/api/README.md` 与 `apps/web/public/api/README.md`，
> 因为 `vite build` 会清空 `docs/`（再由 `public/` 拷回），手写进 `docs/` 的文档会丢。

## 端点

| 路径 | 说明 |
|---|---|
| `index.json` | 端点自描述 + 计数 + 生成时间 + CDN 基址 |
| `news.json` | 全量资讯（含图片对象） |
| `news/latest.json` | 最新 50 条（嵌入首选，约 100KB） |
| `games.json` | 全部游戏状态 + 当期卡池 |
| `games/<key>.json` | 单款游戏（如 `games/endfield.json`） |
| `media.json` | 官方影像（PV / 前瞻 / 短片） |
| `birthdays.json` | 角色生日（按游戏聚合） |
| `feed.json` | 全量 feed 镜像（与站点 `feed.json` 同构） |

## 基址

- CDN（推荐，带 CORS）：`https://cdn.jsdelivr.net/gh/YangZiyueZY/GameNewsPull@main/docs/api/v1/`
- 原始（回退）：`https://raw.githubusercontent.com/YangZiyueZY/GameNewsPull/main/docs/api/v1/`
- 人类可读页面：`https://yangziyuezy.github.io/GameNewsPull/`

## 响应信封

```json
{
  "api_version": "v1",
  "schema_version": 4,
  "generated_at": "2026-11-26T14:20:00+08:00",
  "generated_at_utc": "2026-11-26T06:20:00.000Z",
  "count": 50,
  "cdn": { "images": "https://cdn.jsdelivr.net/gh/.../docs/img", "api": "https://cdn.jsdelivr.net/gh/.../docs/api/v1" },
  "items": []
}
```

## 图片字段

```json
"images": [
  { "url": "https://cdn.jsdelivr.net/gh/.../docs/img/ab12.jpg",
    "fallback": "https://yangziyuezy.github.io/GameNewsPull/img/ab12.jpg",
    "local": "img/ab12.jpg" }
]
```

`url` 优先用 CDN；失败时按 `fallback` → 站内相对 `local` 降级。超出本地化配额的长尾图片仍是 B 站原链，
这类条目的 `image_status` 为 `external`。

## 卡池字段（`games[].up_banners[]`）

`label` 是期次/阶段标签（如「4.7 版本」），`pool_name` 是官方池名，`pool_type` 取
`limited_character` / `rerun_character` / `standard_character` / `fes` / `weapon` / `other`；
`confidence` 为 `low` 表示只有一个非官方信源支撑（页面会标「待核实」），建议调用方自行复核；
`sources[]` 列出该卡池采用的每个信源（`id` / `tier` / `url`），便于回溯。

## 示例

```js
const BASE = 'https://cdn.jsdelivr.net/gh/YangZiyueZY/GameNewsPull@main/docs/api/v1';
const { items } = await fetch(BASE + '/news/latest.json').then(r => r.json());
const { game } = await fetch(BASE + '/games/endfield.json').then(r => r.json());
console.log(game.up_banners);
```

## 缓存与版本

- jsDelivr 对分支引用（`@main`）有最长 12 小时缓存；需要「立即最新」请改用 `@<commit-sha>`。
- 所有时间字段为东八区 ISO 8601（`+08:00`），另有 `generated_at_utc` 供机器对齐。
- 只读公开数据，请自行缓存并做降级（源站每天构建一次）。
- 服务端接口与鉴权：**本期未实现**（决策 q11=A / q12=A）。
