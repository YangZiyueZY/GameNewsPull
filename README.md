# 二游资讯 · 静态资讯站

基于 B 站**蓝 V 官方账号**、官方公告与社区信源的二游资讯聚合站，覆盖 12 款二次元游戏、8 家厂商（米哈游 / 鹰角网络 / 库洛游戏 / 悠星网络 / 蛮啾网络 / 乐元素 / 完美世界；蛮啾含两款）。站点按厂商标签页组织，每张游戏卡片展示版本节点、当前活动、角色生日、限定卡池与官方影像。全站时间统一为**北京时间（Asia/Shanghai，CST）**。

> 详细变更契约见 `plans/multi-source-banner-contract.md`。

**定位：纯静态项目。** 数据由 GitHub Actions 定时抓取并提交到仓库，站点托管在 GitHub Pages，无需服务器、无需数据库、无需代理。

## 工作原理

```
GitHub Actions (定时)  →  抓取B站官方API + 官方/社区信源  →  生成 data/store.json
                       →  下载配额内图片到 public/img 并写 data/image-manifest.json
                       →  多信源解析卡池（pools/ + sources/ + pipeline/banners.ts）
                       →  输出 feed.json / feed.rss / api/v1/ 到 docs/
                       →  写 data/health.json（抓取 + 卡池告警）
                       →  git commit & push
                                              ↓
                                   GitHub Pages 托管 docs/
```

- **存储**：`data/store.json`（随 git 提交持久化，替代数据库；raw 字段压缩存储，约 10x 体积缩减）
- **图片**：抓取时按配额下载到 `apps/web/public/img/` 并同步到 `docs/img/`（jsDelivr 主源）；前端 `SmartImage.vue` 按「jsDelivr CDN → GitHub Pages 回退 → 站内相对路径」三级降级，外链长尾标 `image_status: external`
- **部署源**：`docs/` 目录（在仓库 Settings → Pages 中选择 "main / docs"）
- **健康状态**：`data/health.json` 记录每次抓取的 `ok / degraded / stale` 状态与原因，以及 `banner_warnings` / `banner_sources` 等卡池信源告警，供 CI 与排障使用
- **嵌入 API**：`docs/api/v1/` 是公开只读的静态 JSON，主入口 jsDelivr（自带 CORS），回退 raw.githubusercontent；无服务端、无鉴权（详见下方「嵌入 API」一节）
- **时间**：`apps/crawler/src/utils/datetime.ts` 统一生成 `+08:00` 时间戳；天数按东八区日历日计算，RSS 用 `+0800`，前端用 `Intl` 固定 `Asia/Shanghai`

### 图片地址与配额

每张图输出三类地址：主字段为 `https://cdn.jsdelivr.net/gh/YangZiyueZY/GameNewsPull@main/docs/img/xxx.jpg`，`<字段>_fallback` 为 GitHub Pages，`<字段>_local` 为站内相对路径；覆盖 `icon_url`、`preview_images[]`、`media.items[].poster_url`、`news[].images[]`、`news[].cover`。配额（`apps/crawler/config/site.ts` 的 `IMAGE_QUOTA`）默认最新 150 条资讯、每条 ≤2 张、全局 ≤200MB；超配额长尾保留 B 站原链并标 `image_status: external`，不下载。下载记录写入 `data/image-manifest.json`（URL → local / sha1 / bytes / first_seen），RSS 有图条目附 `<enclosure>` / `<media:content>`。

## 数据抓取管线

抓取入口为 `npm run crawl:once`（脚本：`apps/crawler/src/index.ts`），全流程固定 `Asia/Shanghai`（Actions 里 `env.TZ: Asia/Shanghai`）。每次冷启动按以下顺序执行：

1. **官方账号核验**：对每个游戏调用 `x/web-interface/card`，核对 `official_verify.type === 1`（蓝 V），异常记录告警日志。
2. **增量翻页 + 一次性深度回填**：从 page 0 拉取 `x/polymer/web-dynamic/v1/feed/space`（WBI 签名 + Cookie），每页间隔 800ms；**新账号首轮做一次性深度回填**，最多翻 8 页 / 回溯 45 天，即使首屏已全部入库也继续翻——卡池公告常落在第 3~4 页（如 HSR 4.7 跃迁公告），提前停止会永久漏抓。回填完成后写 `backfill:<mid>` 状态，此后按增量早停（整页已入库即止）；不再使用持久化的 `offset:<mid>:<page>` 游标，避免陈旧游标导致静默漏抓。
3. **Opus 统一解析**（`src/extract/opus.ts`）：B 站官方账号已把图文动态切到 Opus 结构——正文在 `modules.module_dynamic.major.opus.summary.text`、图片在 `major.opus.pics[]`，而 `desc.text` 为空。统一内容模型按 `opus.summary → desc.text → rich_text_nodes → major.draw → 转发 orig` 的优先级读取文本与图片，http 图片自动升级为 https、按 URL 去重保序；`normalizeDynamic()` 只要文本或图片任一非空即保留条目，不再整类丢弃。视频（`DYNAMIC_TYPE_AV/PGC`）与转发（`DYNAMIC_TYPE_FORWARD`）走各自分支，转发会读取 orig 的 Opus 正文与图片。`src/extract/api.ts` 提供 B 站正文信源复用的统一入口。
4. **多信源卡池解析**：`src/pools/`（types / roster / resolver）+ `src/sources/`（hypergryph CMS、PRTS、Akasha、鸣潮官网、碧蓝航线日服/国际服、蔚蓝档案 Cargo、异环 nteguide、B 站正文等适配器）+ `src/pipeline/banners.ts` 组成卡池引擎。按 L0–L4 信源分级做字段级裁决，角色名经 `data/char-names.json` 与 roster 校验，并有人数上限 / 时长 / 噪声守卫；`source: 'config+bilibili'` 等旧标记保留用于兼容。`apps/crawler/config/banners.ts` 只保留**期次时段骨架**（label/start/end），不再写角色名。解析不到时 `up_banners: []`、前端隐藏卡池块，并写 `data/health.json` 的 `banner_warnings` / `banner_sources`，不回填人工角色名。旧版 B 站祈愿公告解析（`src/extract/banners.ts`）仍保留作公告文本兼容。
5. **版本识别与「下个节点」**（`src/extract/feed.ts`）：优先取话题标签 `#原神7.2版本#` 作为当前版本，前瞻/即将类话题不算当前版本；活动词表（联动、特别节目、千星、音乐会、嘉年华、版本前瞻等）避免把活动名误判成版本名。当没有更高版本号时，`next_version_kind` 为 `phase`，「下个节点」退化为**未开始的卡池期次**（如 `7.2 第 2 期`，开池时间 11-24 18:00），而不是空白或错误的高版本；`data.store` 与 feed 中保留 `next_version_kind` 字段（`version` / `phase` / `null`），前端统计块标题据此显示为「下个节点」。
6. **raw 压缩与入库**：`compactRaw()`（`src/store/json.ts`）在入库与历史行迁移时把每条原始 JSON 压缩到解析必需字段（发布者、desc、opus、draw、archive、orig 的正文/图片/视频字段），实测单条从约 10KB 降到 0.7KB（**约 10x**），且保证 `normalizeDynamic(JSON.parse(compactRaw(raw)))` 与原对象的 title/summary/images/type/url 完全一致、压缩幂等。`data/store.json` 每游戏保留最近 400 条 / 150 天内的动态。
7. **输出与本地化**：`src/utils/media.ts` 将配额内图片按 URL SHA1 缓存并下载到本地（清单 `data/image-manifest.json`），`src/utils/cdn.ts` / `cdnize.ts` 生成 CDN / Pages 回退 / 本地三地址；`src/extract/feed.ts` 与 `src/extract/rss.ts` 写出 `apps/web/public/feed.json`、`docs/feed.json`、`docs/feed.rss` 及 `docs/api/v1/`，最后写 `data/health.json`。

### 兜底与陈旧保护（data/health.json）

每次抓取都写 `data/health.json`，字段含 `status`（`ok` / `degraded` / `stale`）、`checked_at`（东八区 ISO）与 `checked_at_utc`、`stale_since`、`reason`、`failed_games`、`endpoint_check`、`store_count`、`feed_generated_at`，以及卡池侧的 `banner_warnings` / `banner_sources` 等：

- **全部游戏抓取失败**（fetched=0）：**不覆盖** `feed.json` / `feed.rss`，保留上一次成功产出的内容，状态记 `stale` 并递增 `stale_since`，CI 红灯（`process.exitCode = 1`），避免空数据顶掉线上。
- **部分游戏失败**：用其余游戏数据正常输出，状态记 `degraded` 并在日志与 `reason` 中列出失败游戏；同时对失败账号调用投稿接口做端点健康检查（`endpoint_check`），区分「账号/网络异常」与「动态接口不可用」。
- **结构性回归**（解析失败率 ≥ 20%、首屏覆盖率 < 90% 或抓取异常）才让 CI 红灯；轻度异常（> 5% 失败率或覆盖率 < 100%）只输出 `WARN`，避免个别新动态类型导致整条数据管线停摆。
- **卡池解析为空**：按 q4 隐藏卡池块并写 health 告警，不猜角色、不回填人工角色名。

### 覆盖率与告警

每个游戏抓取结束会输出一行统计，例如：

```
[crawl] game=原神 mid=401742377 pages=2 fetched=24 parsed=24 opus=15/15 coverage=100% inserted=15 停止原因=第 2 页命中已入库动态
```

- `opus=x/y`：Opus-only（`desc.text` 为空但 opus 有内容）条目中成功解析的条数 / 总条数。
- `coverage`：首屏条目成功解析并入库的比例。
- 告警与 CI 阈值见上节「兜底与陈旧保护」。

### Fixture 回归测试

真实响应的裁剪快照保存在 `data/fixtures/`：5 个首屏 `<gameKey>.json`（结构 `{ captured_at, mid, items }`，单文件 < 300KB）与 `hsr-banners.json`（HSR 前 6 页深度快照，72 条，< 1.5MB，含 4.7 跃迁/已开启公告；由 `npm run fixtures -- --pages 6 --game hsr --out hsr-banners.json` 生成）。`items` 仅保留 `id_str / type / modules.module_author / modules.module_dynamic / orig` 以控体积。

```bash
npm run fixtures        # 重新抓取 5 款游戏首屏，生成/覆盖 data/fixtures/*.json（默认 --pages 1）
npm test                # 离线运行 tests/*.test.ts（node:test + node:assert，通过 tsx）
```

`npm test`（当前 139 个用例）断言：原神 12 条 opus-only 动态 normalize 后文本与图片均非空；祈愿公告解析出 `['兹白', '莉奈娅']`、开池时间 `2026-11-24T18:00:00+08:00`；视频与转发条目不回归；5 个游戏 fixture 全部可解析；HSR 深度快照解析出 4.7 期（`2026-11-11T00:00:00+08:00` ~ `2026-12-22T15:00:00+08:00`，含星神★阿哈/银狼LV.999/火花/爻光）且已结束期次不显示；`compactRaw` 压缩后解析结果等价且幂等；原神下个节点语义（`next_version_kind='phase'`、label 含「第 2 期」）；另覆盖多信源裁决（`tests/pools.test.ts` / `sources-*.test.ts`）、三地址图片（`media.test.ts`）、静态 API（`api.test.ts`）与跨时区时间（`time.test.ts`）。测试无需联网与 Cookie。

## 首次部署

1. Fork / 克隆本仓库到你的 GitHub 账号
2. 仓库 Settings → Secrets and variables → Actions，新建 Secret：
   - 名称：`BILIBILI_COOKIE`
   - 值：你的 B 站完整 Cookie 字符串（含 SESSDATA 等）
3. Settings → Pages，Source 选择 **main 分支 / docs 目录**
4. 在 Actions 页手动运行一次「刷新二游资讯」工作流（workflow_dispatch），即可看到数据
5. 之后定时任务每天 **UTC 01:30 = 北京时间 09:30** 自动刷新（`.github/workflows/refresh.yml` 的 cron 用 UTC，不要按北京时间改；工作流 `env.TZ: Asia/Shanghai`，commit message 形如 `chore: 定时刷新资讯 2026-11-26 09:30 (CST)`）

## 本地开发

```bash
npm install
cp .env.example .env        # 填入 BILIBILI_COOKIE

npm run crawl:once          # 抓取一次，生成数据并本地化图片
npm run web:dev             # http://localhost:5173 （dev 有图片代理）
npm run web:build           # 构建到 docs/（纯静态，无代理）
npm run fixtures            # 更新首屏 fixture 快照
npm test                    # 离线回归测试（当前 139 个用例）
```

本地 dev 模式保留 Vite 图片代理便于调试；构建后的 `docs/` 是纯静态：配额内图片走本地文件并由 jsDelivr `docs/img/` 提供主地址，配额外图片保留官方 B 站原链并标 `external`。前端所有日期用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ... })` 固定北京时间，不跟随浏览器时区。

## 数据来源（全部蓝 V 核验）

| 游戏 | 厂商 | B站 UID | 认证信息 |
|---|---|---|---|
| 原神 | 米哈游 | 401742377 | 原神官方账号（蓝 V） |
| 绝区零 | 米哈游 | 1636034895 | 绝区零官方账号（蓝 V） |
| 崩坏：星穹铁道 | 米哈游 | 1340190821 | 崩坏：星穹铁道官方账号（蓝 V） |
| 崩坏：因缘精灵 | 米哈游 | 3546886017387331 | 崩坏：因缘精灵官方账号（蓝 V） |
| 明日方舟 | 鹰角网络 | 161775300 | 明日方舟官方账号（蓝 V） |
| 明日方舟：终末地 | 鹰角网络 | 1265652806 | 《明日方舟：终末地》官方账号（蓝 V） |
| 鸣潮 | 库洛游戏 | 1955897084 | 鸣潮官方账号（蓝 V） |
| 蔚蓝档案 | 悠星网络 | 3493265644980448 | 蔚蓝档案官方账号（蓝 V） |
| 蓝色星原：旅谣 | 蛮啾网络 | 3546569016085336 | 蓝色星原：旅谣官方账号（蓝 V） |
| 白银之城 | 乐元素 | 3546879304403742 | 白银之城官方账号（蓝 V） |
| 异环 | 完美世界 | 3546636978489848 | 《异环》官方账号（蓝 V） |
| 碧蓝航线 | 蛮啾网络（manjuu） | — | 国服 B 站官号 mid 未确认，`bili: false`；只走日服 / 国际服官方 JSON |

共 **12 款游戏**，其中《蓝色星原：旅谣》2026-11-26 正式公测，`stage` 已由 `prelaunch` 改为 `live` 并接入「弦定观测」卡池解析。每次运行都会对有 mid 的账号调用 `x/web-interface/card` 复核 `official_verify.type === 1`，异常会在日志里告警；碧蓝航线无 B 站 mid，跳过该核验。

### 网站图标与 Manifest

`apps/web/public/` 下的 `favicon.svg`、`favicon-32.png`、`apple-touch-icon.png`、`icon-192.png` 与 `icon-512.png` 是站点图标资源；`site.webmanifest` 提供 PWA 元数据，其中 `theme_color` / `background_color` 均为 `#181518`，并声明 192×192 与 512×512 两个 PNG 图标。图标采用深色圆角方块、琥珀渐变资讯卡与星火信号点，呼应站内主色 `#ffb454` 与「二游资讯 + 更新」主题。

## 刷新频率与体积控制

- Actions 每天北京时间 09:30（UTC 01:30）跑一次，也可手动触发
- `data/store.json` 每游戏保留最近 400 条 / 150 天内的动态；raw 字段压缩存储（约 10x），控制仓库体积
- 图片按 URL 的 SHA1 命名并缓存，重复图片不重复下载；新闻图只下沉**最新 150 条 × 每条 ≤2 张**，全局 ≤**200MB**（`apps/crawler/config/site.ts` 的 `IMAGE_QUOTA`，可用 `IMAGE_NEWS_MAX_ITEMS` / `IMAGE_PER_ITEM` / `IMAGE_MAX_BYTES` 覆盖），超配额长尾保留 B 站原链并标 `external`
- jsDelivr 对 `@main` 资源有约 **12 小时缓存**：需要立即可见时把 `CDN_REF` 切到具体 commit sha；主字段为 `https://cdn.jsdelivr.net/gh/YangZiyueZY/GameNewsPull@main/docs/img/xxx.jpg`，回退 GitHub Pages，站内相对路径兜底
- 站点全相对路径（`base: './'`），支持 `https://<user>.github.io/<repo>/` 子路径部署

## 厂商标签页 / 当前活动 / 角色生日

前端按厂商把 12 款游戏分成 8 个标签页，默认选中「米哈游」；切换标签会同步 `#publisher=<key>` 深链，支持左右方向键 / Home / End。标签顺序与厂商配置在 `apps/crawler/config/publishers.ts`。

每张游戏卡片新增两个数据块：

- **当前活动**：来自 `apps/crawler/config/curation.ts` 的人工种子 ∪ 官方动态自动识别（活动 / 限时 / 复刻 / 预下载 / 测试 / 预约等关键词），最多 3 条，按「进行中 → 即将开始 → 时间待定 → 最近结束」排序，附官方动态链接。没有活动数据的卡片不渲染该块。
- **角色生日**：从官方 `#角色# #生日快乐#` 动态学习 MM-DD，按「今天 / 未来 30 天 → 过去 30 天 → 其余」排序，最多 4 条；跨运行累积到 `data/birthdays.json`。绝区零等账号的生日动态多为互动抽奖、同一角色日期不一致，不做发布日推断；**没有生日数据的游戏完全隐藏该块**，不显示空占位。原神是当前唯一稳定可学习生日数据的游戏。

预约阶段的游戏（崩坏：因缘精灵 / 白银之城）使用 `stage: 'prelaunch'`：卡片显示「未开放下载 · 预约中」、官方账号入口与预热里程碑，隐藏版本统计与卡池；《蓝色星原：旅谣》已于 2026-11-26 公测，`stage: 'live'`，显示正式卡片与「弦定观测」卡池。

`feed.json` 已升级到 `schema_version: 4`：保留 v3 的顶层 `publishers` 与每款游戏的 `publisher_key / publisher_name / publisher_color / stage / official_account / download / release / events / birthdays` 等字段；顶层新增 `generated_at_utc`（与 `generated_at` 同为 UTC 绝对时刻，后者固定 `+08:00`），卡池 `up_banners[]` 新增 `pool_name / pool_type / pool_type_label / confidence / sources`（旧字段全部保留）。所有时间字段（`published_at` / `preview_start_at` / `facts_checked_at` / 健康 `checked_at` 等）为东八区 ISO，另并列 `checked_at_utc`；RSS `lastBuildDate` / `pubDate` 为 `+0800`，天数按东八区日历日计算。无网络时可用 `npm run feed:rebuild` 从 `data/store.json` 离线重建。

## 限定卡池

卡池角色由多信源引擎产出，不再靠手改配置：官方公告（hypergryph CMS / 鸣潮官网 / 碧蓝日服与国际服 / B 站正文等 L0）、社区聚合（PRTS / Akasha / 蔚蓝档案 Cargo / 异环 nteguide 等 L2/L3）与人工时段骨架（L4）一起进入 `apps/crawler/src/pools/` 的裁决器，按 L0–L4 分级做字段级合并，角色名经 `data/char-names.json` 与 roster 校验，并受人数上限 / 时长（1h–90 天）/ 噪声守卫约束。旧字段 `label / characters / start_at / end_at / status / days_remaining / source` 全部保留；`up_banners[]` 新增 `pool_name / pool_type / pool_type_label / confidence / sources`，武器池单列不进 `current_up_characters`。`apps/crawler/config/banners.ts` 只维护期次时段（label/start/end，结束时间未公布时为 `null`），**不再写角色名**。解析不到时 `up_banners: []`、前端隐藏卡池块并写 health 告警，不猜角色。

### 嵌入 API（给第三方站点/脚本用）

`docs/api/v1/` 提供公开**只读**静态 JSON：`index`（端点总览）、`news` / `news/latest`（资讯）、`games` / `games/<key>`（游戏状态与卡池）、`media`、`birthdays`、`feed`（全量镜像）。主入口是 jsDelivr（自带 `Access-Control-Allow-Origin: *`），回退 raw.githubusercontent；Pages 上是人类可读入口。**不提供服务端 API、不设鉴权**；统一响应信封（含 `api_version` / `schema_version` / `generated_at` / `generated_at_utc` / `count` / `cdn` / `items`）与图片对象结构详见 [docs/api/README.md](docs/api/README.md)，这里不重复。镜像同步写在 `apps/web/public/api/v1/`。

## 目录

```
.github/workflows/refresh.yml    定时刷新 + 提交（env.TZ: Asia/Shanghai）
apps/crawler/
  config/
    games.ts / publishers.ts    游戏 UID / 厂商（含碧蓝航线 bili:false）
    site.ts                     仓库/CDN/Pages 地址与 IMAGE_QUOTA 图片配额
    banners.ts                  卡池期次时段骨架（不再写角色名）
    curation.ts                 当前活动人工种子
  src/sources/
    bilibili/                   客户端（WBI 签名 / Cookie）
    hypergryph/ / prts/ / akasha/ / kuro/ / azurlane/ / bluearchive/ / nte/ / bili/
                                官方与社区信源适配器 + registry.ts / http.ts
  src/pools/                    types / roster / resolver（卡池分级裁决）
  src/pipeline/banners.ts       信源 → feed 卡池流水线
  src/extract/
    opus.ts                     Opus 统一内容模型（文本 / 图片 / 标题）
    banners.ts                  旧版祈愿公告解析（保留兼容）
    api.ts / rss.ts             API 端点与 RSS 输出（时间 +0800）
    normalize.ts                动态归一化（视频 / 图文 / 转发）
    feed.ts                     版本识别 / 下个节点 / 活动生日 / feed 构建
    calendar.ts                 活动状态 / 生日学习 / 下一次生日（纯函数）
  src/index.ts                  深度回填 + 生日簿落盘 + 覆盖率告警 + health 兜底
  src/rebuild.ts                离线重建 feed（feed:rebuild）
  src/store/json.ts             无状态 JSON 存储 + raw 压缩（compactRaw）
  src/utils/
    datetime.ts                 东八区时间源（toCstIso / cstDayKey / rfc822Cst）
    media.ts                    配额内图片本地化
    cdn.ts / cdnize.ts          CDN / Pages 回退 / 本地三地址生成
    wbi.ts                      B 站签名
apps/web/                       Vue 3 + Vite 前端（厂商标签页 / 活动 / 生日卡片）
  src/components/SmartImage.vue 图片三级降级（CDN → fallback → local）
  src/lib/format.ts             日期格式化固定 Asia/Shanghai
data/store.json                 持久状态（随 git 提交，raw 压缩）
data/health.json                抓取与卡池健康状态（ok / degraded / stale）
data/birthdays.json             跨运行累积的角色生日簿
data/char-names.json            角色名字典（多信源裁决用）
data/image-manifest.json        图片 URL → 本地副本元信息（抓取时落盘）
data/source-cache/              信源离线快照（offline 模式只读本地）
data/fixtures/                  首屏 + HSR 深度快照（fixture 回归测试用；新游无 fixture 自动跳过）
data/image-cache.json           图片下载缓存状态
scripts/snapshot-fixtures.ts    fixture 抓取脚本（--pages / --game / --out）
tests/                          opus / banners / 池裁决 / 图片 / API / 时间离线回归测试
docs/                           构建产物（Pages 托管源）
  feed.json / feed.rss          资讯 feed（schema_version 4）
  img/                          本地化图片（jsDelivr 主源）
  api/v1/                       静态嵌入 API（index/news/games/media/birthdays/feed）
```

## 注意

- `BILIBILI_COOKIE` 存于 GitHub Secrets，不要提交到仓库；Cookie 过期需更新 Secret（碧蓝航线无 B 站 mid，不走该路径）
- 抽取为规则实现，官方文案格式变化时需调整正则或信源适配器；角色/卡池解析不到时宁可隐藏，不猜测、不回填人工角色名
- 图片下载有硬配额（最新 150 条 × ≤2 张、全局 ≤200MB），超出的长尾保留外链并标 `external`；jsDelivr `@main` 约 12 小时缓存，需要立即可见时切 `CDN_REF` 到 commit sha
- 嵌入 API 是**静态 JSON 文件**，没有服务端、没有鉴权、没有写入或查询接口；第三方直接读 `docs/api/v1/`（信封与图片对象见 [docs/api/README.md](docs/api/README.md)）
- 仅供个人学习，内容版权归各游戏官方所有

## 2026-11-26 增量修复（卡池口径）

1. **当期限定角色只取当前批次**：current_up_characters 只统计 status=进行中 的角色池，且限制在「开始时间最晚的那一批（24h 内）」；名称归一化后去重（「千冶•刃」与「千冶·刃」视为同一人）。旧版本里缺结束时间的池子（如原神 7.1「莓色香颂」）不会再混进当期。
2. **同一卡池的多源记录合并**：新增两条合并规则——起止同小时桶 + 角色有交集 → 同一期；结束时间相同 + 恰好一方缺开始时间 + 角色有交集 → 同一期。星铁此前「Akasha 3 人池 + B 站 1 人池」各显示一张卡的问题已消除，且角色取并集（B 站只写 1 人时不会吞掉另外两名 UP）。
3. **武器池不再展示**：没有武器名的半成品一律从 up_banners 移除（前端也做了过滤，兼容旧 feed）。将来若要恢复，需要先补全武器名解析。
4. **《碧蓝航线》接入 B 站官号**：mid=233114659（「碧蓝航线」，蓝 V，387 万粉）。用 npx tsx scripts/fetch-one-game.ts azurlane 3 可单独补抓，不必跑全量 crawl。同时修了 feed.news 的截断顺序——现在先按发布时间倒序再取 500 条，否则新补抓的游戏会因排在 store.json 尾部而被截掉（表现为「卡片没有任何消息」）。
5. **《异环》新增「协定卡池」字段**：games[].pact_banners[]（与 up_banners 并列，前端单独渲染「协定卡池」块，API 同步输出）。数据来自异环官方 B 站动态里的「「X」限定棋盘 + 限定 S 级角色「Y」」；官方措辞是「限定棋盘」，本站按用户口径统一叫「协定卡池」；起点若只写了「版本更新后」，用原文版更日 05:00 近似并在 note 标注。

验证：npm test 139 用例全绿；上述五点在 docs/feed.json 与局域网预览中逐条核对通过。

### 2026-11-26 二次修正（展示口径）

- **当期限定角色**：只统计 `status=进行中` 的角色池，且限于「开始时间最晚的那一批」；已结束/缺时间的一律不进。
- **已结束期次最多 2 条**：`visiblePools()` 对每个游戏只保留最近 2 条已结束卡池（进行中/未开始不限），历史期次不再刷屏。
- **空壳卡池直接丢弃**：没有 UP 角色的角色池（如 Akasha 只给池名）、起止时间都为空的解析残片，一律不展示（同时写 `banner_warnings`）。武器池仍整体不展示。
- **时间补齐（有锚点才补）**：缺结束时间的池用「下一期开池时间」近似（间隔 ≤60 天，note 标注）；鸣潮「版本更新后」用同篇维护窗口结束时刻锚定；蔚蓝档案「维护结束后」按当日 14:00 近似；仍缺起点但结束时间在未来的池判为「进行中」。
- **同名跨源合并**：池名相同且时间不冲突即视为同一期（鸣潮官网公告缺时间、B 站公告缺角色，合成一个池），解决「同一角色两张卡」与「角色显示不全」。
- **蔚蓝档案**：只认中文招募池名（英文标题不再当池名），没有招募时间直接跳过。
- **异环**：`pact_banners` 只保留有角色、有时间的池；无 UP 无时间的残片（如「预言终幕时」）不再出现。

## 部署到 GitHub（Actions 每日定时抓取）

> 默认假设：仓库 `YangZiyueZY/GameNewsPull`、默认分支 `main`、Pages 源为 **main / docs**。
> fork 到别的仓库时无需改代码：工作流会把 `SITE_OWNER` / `SITE_REPO` 设成当前仓库，CDN 地址随之变化。

### 一次性配置（5 步）

1. 把仓库推到 GitHub（默认分支 `main`），确认 `data/`（含 `store.json`、`char-names.json`、`source-cache/`）与 `docs/` 都已提交。
2. **Settings → Secrets and variables → Actions → New repository secret**：新增 `BILIBILI_COOKIE`，值为完整 B 站 Cookie（含 `SESSDATA`，用于官方号动态接口的风控）。
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → main / docs**。
4. **Actions → 刷新二游资讯 → Run workflow** 手动跑一次（首次会做深度回填，耗时较长）。
5. 之后每天 **UTC 01:30 = 北京时间 09:30** 自动运行；也可随时手动触发。

### 每次运行做什么

| 步骤 | 命令 / 动作 | 说明 |
|---|---|---|
| 安装依赖 | `npm ci` | Node 22 + npm 缓存（`cache: npm`） |
| 回归测试 | `npm test` | 139 个离线用例（时区 / 卡池解析 / API 契约），失败则本次不产出 |
| 抓取与生成 | `npm run crawl:once` | 12 款游戏的 B 站官号 + 各信源 → `data/` 与 `docs/` |
| 保住构建产物 | 复制 `docs/img`、`docs/api` → `apps/web/public/` | 防止下一步 vite 清空 `docs/` 时把图片与 API 弄丢 |
| 构建站点 | `npm run web:build` | 产出 `docs/`（含 `docs/api/v1/*`） |
| 摘要 + 制品 | 打印 `generated_at` / health，上传 7 天制品 | 便于排查 |
| 提交推送 | `git add data/ docs/` + commit + push | **数据发布方式见下** |

### 数据如何提交 / 发布（默认方案）

- **提交回 main**：工作流把 `data/`（库存、健康、生日簿、角色字典、图片清单、信源快照）与 `docs/`（站点 + API JSON）直接 commit 到 `main`，commit message 形如 `chore: 定时刷新资讯 2026-11-26 20:35 (CST)`。
- **发布**：GitHub Pages 从 `main / docs` 直接托管，无需额外部署步骤；`https://<owner>.github.io/<repo>/`，API 在 `/api/v1/`。
- **并发与失败**：`concurrency: refresh`（不取消进行中的运行）；抓取全失败时保留上一版 `feed.json`/`feed.rss` 不覆盖，`data/health.json` 记 `stale` 并让 CI 红灯。
- **体积控制**：`data/image-manifest.json` 记录图片字节数，配额 `最新 150 条资讯 × 每条 ≤2 张 / 全局 ≤200MB`（`config/site.ts` 的 `IMAGE_QUOTA`）。

#### 可选：改成「发布制品」而不污染 git

如果不想每天提交二进制图片，可以把 Pages 源改为 *GitHub Actions*，并在工作流末尾加：

```yaml
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs
      - uses: actions/deploy-pages@v4
```

同时给 job 加 `permissions: { contents: read, pages: write, id-token: write }`，并去掉「提交并推送」这一步。
注意：`data/store.json` 是增量抓取的唯一“数据库”，**无论如何都要提交回仓库**，否则每次都会从零回填。

### 站内 API 文档

页面右上角的 **「API 文档」** 按钮会打开本项目「拉取 API」的速查面板：基址（CDN / raw / 站点）、端点表（读 `api/v1/index.json` 自描述）、响应信封、图片三地址、卡池字段与可直接复制的调用示例。
信源侧接口（Akasha、鹰角 CMS、PRTS、库洛、悠星、蛮啾、异环等）的端点与字段口径见 [plans/multi-source-banner-contract.md](plans/multi-source-banner-contract.md) 第 4 节「信源适配器」。
