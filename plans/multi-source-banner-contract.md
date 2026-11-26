# 多信源卡池 + CDN + 嵌入 API 实施契约

> 本文件是并行开发的唯一口径。任何字段名/行为改动都必须先改这里。
> 决策来源：用户在 2026-11-26 的逐条选择（q1–q13）。

## 0. 已确认决策

| 编号 | 议题 | 结论 |
|---|---|---|
| q1 | 信源架构 | **社区聚合为主**（Akasha / PRTS 直接出数），官方一手作触发与校验 |
| q2 | 第三方定位 | 允许做**副主源**；官方缺失时可渲染，但必须 `confidence: low` |
| q3 | 冲突裁决 | 采用 L0–L4 分级 + 字段级规则 + 缺锚点置 null + `sources[]`/`confidence` |
| q4 | 解析失败 | **隐藏卡池块** + 写 health 告警（不猜、不回填） |
| q5 | 人工配置 | 删除 config 里手写角色名，只保留时段/期次骨架 |
| q6 | 修复范围 | **五款一次全修**：终末地 / 明日方舟 / 鸣潮 / 蔚蓝档案 / 星穹铁道 |
| q7 | 蓝色星原 | 立即 `stage: live` + 接入「弦定观测」卡池解析 |
| q8 | 碧蓝航线 | **纳入**，只用日服/国际服官方 JSON |
| q9 | 方舟常驻池 | PRTS SMW ask 为主 + `gacha_table.json` 校验时间 |
| q10 | 角色名映射 | 本地字典 `data/char-names.json` |
| q11 | API 形态 | 纯静态 JSON 端点（`docs/api/v1/`） |
| q12 | 鉴权/跨域 | 公开只读、不鉴权；跨域走 jsDelivr `ACAO: *` |
| q13 | 图片配额 | 最新 150 条资讯 × 每条 ≤2 张，全局 ≤200MB |

## 1. 时间（全部 Asia/Shanghai）

- 新增/统一时间源：`apps/crawler/src/utils/datetime.ts`（`toCstIso` / `nowCstIso` / `cstDayKey` / `cstDayDiff` / `rfc822Cst` / `parseCnDateCst`）。
- `feed.generated_at` = `YYYY-MM-DDTHH:mm:ss+08:00`；并**并列**输出 `generated_at_utc`（Z）。
- `published_at` / `preview_start_at` / `facts_checked_at` / `events[].start_at` / `up_banners[].start_at` 全部 `+08:00`。
- `health.checked_at`、`birthdays.generated_at`、store `fetched_at` 同样 `+08:00`（health 额外保留 `checked_at_utc`）。
- RSS `lastBuildDate`/`pubDate` 用 `+0800` 形式。
- 天数（`current_version_days` / `days_to_next_version` / `release.days_until`）用**东八区日历日差**。
- `cnDateToIso` 必须显式按 +08:00 构造，禁止依赖进程时区。
- 前端所有日期用 `Intl.DateTimeFormat` + `timeZone: 'Asia/Shanghai'`，并在页脚标注「北京时间」。

## 2. 图片（CDN + 回退 + 配额）

- 地址三件套（`apps/crawler/src/utils/cdn.ts`）：
  - 主字段 = `cdnUrl()` → `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/docs/img/xxx.jpg`
  - `*_fallback` = `pagesUrl()` → `https://yangziyuezy.github.io/GameNewsPull/img/xxx.jpg`
  - `*_local` = 相对路径 `img/xxx.jpg`
- 覆盖字段：`icon_url`、`preview_images[]`、`media.items[].poster_url`、`news[].images[]`、`news[].cover`。
- 新闻图纳入本地化：最新 `IMAGE_QUOTA.newsMaxItems` 条、每条 ≤ `imagesPerItem` 张；超配额的长尾保留官方原链并标 `external`。
- 落地清单 `data/image-manifest.json`：`{ url: { local, sha1, bytes, first_seen } }`。
- 前端 `SmartImage.vue`：`cdn → fallback → local` 三级 `@error` 降级。
- RSS 每条加 `<enclosure>` + `<media:content>`，无图条目不加。

## 3. 卡池引擎（`apps/crawler/src/pools/`）

```ts
PoolCandidate = { game_key, pool_name, pool_type, characters, start_at, end_at, version?, period?, evidence?, note?, source }
ResolvedPool   = { id, game_key, label, pool_name, pool_type, pool_type_label, characters,
                   start_at, end_at, version, status, days_remaining,
                   confidence: 'high'|'low', sources: SourceRef[], note, source }
```

- `pool_type` 枚举见 `pools/types.ts`；`weapon` 不进 `current_up_characters`。
- 合并键：`game_key + 归一化池名 + 起止(>=1 小时粒度)`；同键多源合并，不同源分列 `sources[]`。
- 置信度：≥2 源一致或 L0 单源 → `high`；仅 L2/L3/L1 单源 → `low`。
- 守卫：UP 人数上限（原神 2 / HSR 2 / ZZZ 2 / 终末地 2 / 方舟 2 / BA 1 / 蓝原 2 / 碧蓝 2）、时长 1h–90 天、
  角色名必须通过 roster 校验、禁止把「全部可能出现」这类噪声串当角色、武器池单列。
- 输出到 feed 的 `up_banners[]`：保留 `label/characters/start_at/end_at/status/days_remaining/source` 旧字段，
  新增 `pool_name/pool_type/pool_type_label/confidence/sources[]`。
- `current_up_characters` = 进行中角色池（非 weapon）的 UP 并集，按开始时间排序去重。
- 解析不到 → `up_banners: []`，写 health `banner_warnings`，**不回填 config 角色名**。

## 4. 信源适配器（`apps/crawler/src/sources/`）

| id | tier | 覆盖 | 数据来源 |
|---|---|---|---|
| `hypergryph-cms` | L0 | endfield, arknights | `web-news.hypergryph.com/api/bulletin?code=endfield_web\|arknights`（**不带 Origin 头**） |
| `prts-smw` | L2 | arknights | `prts.wiki/api.php?action=ask`（常驻轮换，出率提升干员 + 时间戳） |
| `akasha` | L2 | genshin, hsr, zzz | `akasha.trrw.cn/api/v1/games/{ys\|sr\|zzz}/calendar`（kind=卡池） |
| `kuro-site` | L0 | wutheringwaves | `media-cdn-mingchao.kurogame.com/.../ArticleMenu.json` |
| `bluearchive-cargo` | L2 | bluearchive | `bluearchive.wiki/w/api.php?action=cargoquery&tables=banners`（仅 JP/GL，作校验，不单独渲染国服） |
| `azurlane-jp` | L0 | azurlane | `azurlane.jp/api/news/list`（维护公告正文内「期間限定建造」） |
| `azurlane-en` | L0 | azurlane | `azurlane.yo-star.com/news/wp-json/wp/v2/posts` |
| `nte-guide` | L2 | yh | `nteguide.com/api/characters.json`（仅角色名单，不做当期池） |
| `bili-dynamics` | L0 | 全部 | 复用现有 `data/store.json` 正文（蓝原「弦定观测」、鸣潮「唤取」等） |
| `config` | L4 | 全部 | `config/banners.ts`（只提供时段骨架，不含角色名） |

约束：适配器必须支持 `ctx.offline`（只读 `data/source-cache/<id>.json`），网络失败返回 `[]` 并打日志，禁止编造。

## 5. 嵌入 API（`docs/api/v1/`）

- `index.json`：`{ api_version, schema_version, generated_at, generated_at_utc, counts, endpoints{...}, cdn{images,api}, rate_limit_note }`
- `news.json` / `news/latest.json`（最新 50）：`{ items: [{ id, game_key, game_name, title, summary, url, published_at, type, images: [{url, fallback, local, width?, height?}], cover }] }`
- `games.json` / `games/<key>.json`：游戏状态 + `up_banners`（含 confidence/sources）
- `media.json`、`birthdays.json`、`feed.json`（全量镜像）
- 统一信封：`{ api_version: 'v1', schema_version, generated_at, generated_at_utc, count, cdn, items }`
- 主入口 = jsDelivr（自带 `ACAO: *`），回退 = raw.githubusercontent；Pages 仅人类可读入口。

## 6. 验收

1. `TZ=UTC npm test` 与 `TZ=America/New_York npm test` 全绿；
2. `npm run feed:rebuild` 产出 `generated_at` 以 `+08:00` 结尾、与 `generated_at_utc` 差 8h；
3. `docs/feed.json` 所有图片主字段为 CDN、`*_fallback` 为 GitHub 地址；
4. 终末地 `current_up_characters` 含「小刻」且不含「明河」；方舟出现常驻轮换池；鸣潮/BA 不再是 0 条；
5. `docs/api/v1/index.json`、`news.json`、`games/endfield.json` 结构符合 §5；
6. RSS 每条有图条目带 `<enclosure>`，`lastBuildDate` 为 `+0800`。

## 7. 实施状态（2026-11-26 收尾）

| 验收项 | 状态 | 证据 |
|---|---|---|
| TZ=UTC / America_New_York 下测试全绿 | ✅ | `TZ=UTC npm test` → 137 pass / 0 fail |
| feed `generated_at` +08:00 且与 `generated_at_utc` 差 8h | ✅ | `2026-11-26T14:49:05+08:00` / `2026-11-26T06:49:05.405Z` |
| 图片主字段 CDN、`*_fallback` GitHub 地址 | ✅ | icon/poster/preview 已是 CDN+fallback+local；新闻图超出配额或离线未下载时标 `external` |
| 终末地 UP 含「小刻」不含「明河」 | ✅ | `endfield current=['小刻','洁尔佩塔']`，明河只出现在已结束的「烟火邀星河」 |
| 方舟出现常驻轮换池 | ✅ | 8 条 `常驻标准寻访 N 期`（PRTS SMW + wikitext） |
| 鸣潮 / BA 不再是 0 条 | ✅ | 鸣潮 8 条（莉莉/安魂…）、BA 6 条（时雨/美游…） |
| 蓝色星原 live + 卡池 | ✅ | `桃笺为契 · 涂山小玉`（B 站「弦定观测」） |
| 碧蓝航线纳入 | ✅ | 1 条（国际服 WP REST，Molotov/Sinop → 莫洛托夫/锡诺普） |
| `docs/api/v1/*` 端点 | ✅ | index/news/latest/games/games\<key\>/media/birthdays/feed，19 个文件 |
| RSS 有图条目带 enclosure，`+0800` | ✅ | 100 条 enclosure；`Thu, 26 Nov 2026 14:49:05 +0800` |

已知遗留（不影响上线）：

1. `data/health.json` 只由抓取流程写；`npm run feed:rebuild` 不写它，所以本地重建后仍是上一轮的值，下一次 Actions 运行即刷新。
2. 新闻图本地化需要真实下载，只在 `crawl` 时发生；离线 `feed:rebuild` 会把未缓存的新闻图标成 `external`。
3. `bluearchive-cargo` 在 Node 原生 fetch 下被 Cloudflare 拦（403，curl 可通）→ BA 目前只有 B 站单源，按契约 `confidence: low`。
4. 《异环》没有可靠第三方卡池源（nteguide 明确不提供当期池），当前 `up_banners: []` 属预期，等官方公告结构稳定后再接。
5. jsDelivr 以 `@main` 引用，最长 12h 缓存；需要立即可见时切 `@<commit-sha>`。
