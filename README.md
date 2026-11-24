# 二游资讯 · 静态资讯站

基于 B 站**蓝 V 官方账号**的二游资讯聚合站，覆盖 11 款二次元游戏、7 家厂商（米哈游 / 鹰角网络 / 库洛游戏 / 悠星网络 / 蛮啾网络 / 乐元素 / 完美世界）。站点按厂商标签页组织，每张游戏卡片展示版本节点、当前活动、角色生日、限定卡池与官方影像。

**定位：纯静态项目。** 数据由 GitHub Actions 定时抓取并提交到仓库，站点托管在 GitHub Pages，无需服务器、无需数据库、无需代理。

## 工作原理

```
GitHub Actions (定时)  →  抓取B站官方API  →  生成 data/store.json
                       →  下载图片到 public/img
                       →  输出 feed.json / feed.rss 到 docs/
                       →  写 data/health.json（抓取健康状态）
                       →  git commit & push
                                              ↓
                                   GitHub Pages 托管 docs/
```

- **存储**：`data/store.json`（随 git 提交持久化，替代数据库；raw 字段压缩存储，约 10x 体积缩减）
- **图片**：抓取时下载到 `apps/web/public/img/`，前端用相对路径，无需服务端代理
- **部署源**：`docs/` 目录（在仓库 Settings → Pages 中选择 "main / docs"）
- **健康状态**：`data/health.json` 记录每次抓取的 `ok / degraded / stale` 状态与原因，供 CI 与排障使用

## 数据抓取管线

抓取入口为 `npm run crawl:once`（脚本：`apps/crawler/src/index.ts`），每次冷启动按以下顺序执行：

1. **官方账号核验**：对每个游戏调用 `x/web-interface/card`，核对 `official_verify.type === 1`（蓝 V），异常记录告警日志。
2. **增量翻页 + 一次性深度回填**：从 page 0 拉取 `x/polymer/web-dynamic/v1/feed/space`（WBI 签名 + Cookie），每页间隔 800ms；**新账号首轮做一次性深度回填**，最多翻 8 页 / 回溯 45 天，即使首屏已全部入库也继续翻——卡池公告常落在第 3~4 页（如 HSR 4.7 跃迁公告），提前停止会永久漏抓。回填完成后写 `backfill:<mid>` 状态，此后按增量早停（整页已入库即止）；不再使用持久化的 `offset:<mid>:<page>` 游标，避免陈旧游标导致静默漏抓。
3. **Opus 统一解析**（`src/extract/opus.ts`）：B 站官方账号已把图文动态切到 Opus 结构——正文在 `modules.module_dynamic.major.opus.summary.text`、图片在 `major.opus.pics[]`，而 `desc.text` 为空。统一内容模型按 `opus.summary → desc.text → rich_text_nodes → major.draw → 转发 orig` 的优先级读取文本与图片，http 图片自动升级为 https、按 URL 去重保序；`normalizeDynamic()` 只要文本或图片任一非空即保留条目，不再整类丢弃。视频（`DYNAMIC_TYPE_AV/PGC`）与转发（`DYNAMIC_TYPE_FORWARD`）走各自分支，转发会读取 orig 的 Opus 正文与图片。
4. **卡池角色自动合并**（`src/extract/banners.ts`）：从祈愿公告解析角色名（`驹隙隐泉·兹白(岩)` → `兹白`）、开池时间（`2026/11/24 18:00` → `2026-11-24T18:00:00+08:00`）与版本号。`buildBanners()` 采用 **config ∪ 官方公告** 并集策略：`config/banners.ts` 是骨架，决定期次与人工维护的时段；官方公告补充新角色并标记 `source: 'config+bilibili'`（无 config 时为 `bilibili`），人工项不会被删除。HSR 卡池解析已修复：支持「跃迁」关键词、带区间分隔的开池时间（`11月11日 - 12月22日 15:00`）与高稀有度角色列举，避免 4 星角色/光锥混入；无人工 config 时只保留未结束（或 7 天内刚结束）的期次并重新编号，避免 4.6 已结束期次残留。
5. **版本识别与「下个节点」**（`src/extract/feed.ts`）：优先取话题标签 `#原神7.2版本#` 作为当前版本，前瞻/即将类话题不算当前版本；活动词表（联动、特别节目、千星、音乐会、嘉年华、版本前瞻等）避免把活动名误判成版本名。当没有更高版本号时，`next_version_kind` 为 `phase`，「下个节点」退化为**未开始的卡池期次**（如 `7.2 第 2 期`，开池时间 11-24 18:00），而不是空白或错误的高版本；`data.store` 与 feed 中保留 `next_version_kind` 字段（`version` / `phase` / `null`），前端统计块标题据此显示为「下个节点」。
6. **raw 压缩与入库**：`compactRaw()`（`src/store/json.ts`）在入库与历史行迁移时把每条原始 JSON 压缩到解析必需字段（发布者、desc、opus、draw、archive、orig 的正文/图片/视频字段），实测单条从约 10KB 降到 0.7KB（**约 10x**），且保证 `normalizeDynamic(JSON.parse(compactRaw(raw)))` 与原对象的 title/summary/images/type/url 完全一致、压缩幂等。`data/store.json` 每游戏保留最近 400 条 / 150 天内的动态。
7. **输出与本地化**：`src/utils/media.ts` 将图片按 URL SHA1 缓存并下载到本地；写出 `apps/web/public/feed.json` 与 `docs/feed.json`、`docs/feed.rss`；最后写 `data/health.json`。

### 兜底与陈旧保护（data/health.json）

每次抓取都写 `data/health.json`，字段含 `status`（`ok` / `degraded` / `stale`）、`checked_at`、`stale_since`、`reason`、`failed_games`、`endpoint_check`、`store_count`、`feed_generated_at` 等：

- **全部游戏抓取失败**（fetched=0）：**不覆盖** `feed.json` / `feed.rss`，保留上一次成功产出的内容，状态记 `stale` 并递增 `stale_since`，CI 红灯（`process.exitCode = 1`），避免空数据顶掉线上。
- **部分游戏失败**：用其余游戏数据正常输出，状态记 `degraded` 并在日志与 `reason` 中列出失败游戏；同时对失败账号调用投稿接口做端点健康检查（`endpoint_check`），区分「账号/网络异常」与「动态接口不可用」。
- **结构性回归**（解析失败率 ≥ 20%、首屏覆盖率 < 90% 或抓取异常）才让 CI 红灯；轻度异常（> 5% 失败率或覆盖率 < 100%）只输出 `WARN`，避免个别新动态类型导致整条数据管线停摆。

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

`npm test`（38 个用例）断言：原神 12 条 opus-only 动态 normalize 后文本与图片均非空；祈愿公告解析出 `['兹白', '莉奈娅']`、开池时间 `2026-11-24T18:00:00+08:00`；视频与转发条目不回归；5 个游戏 fixture 全部可解析；HSR 深度快照解析出 4.7 期（`2026-11-11T00:00:00+08:00` ~ `2026-12-22T15:00:00+08:00`，含星神★阿哈/银狼LV.999/火花/爻光）且已结束期次不显示；`compactRaw` 压缩后解析结果等价且幂等；原神下个节点语义（`next_version_kind='phase'`、label 含「第 2 期」）。测试无需联网与 Cookie。

## 首次部署

1. Fork / 克隆本仓库到你的 GitHub 账号
2. 仓库 Settings → Secrets and variables → Actions，新建 Secret：
   - 名称：`BILIBILI_COOKIE`
   - 值：你的 B 站完整 Cookie 字符串（含 SESSDATA 等）
3. Settings → Pages，Source 选择 **main 分支 / docs 目录**
4. 在 Actions 页手动运行一次「刷新二游资讯」工作流（workflow_dispatch），即可看到数据
5. 之后定时任务每天 UTC 01:00 / 07:00 / 13:00 / 19:00（北京时间 09/15/21/03 点）自动刷新

## 本地开发

```bash
npm install
cp .env.example .env        # 填入 BILIBILI_COOKIE

npm run crawl:once          # 抓取一次，生成数据并本地化图片
npm run web:dev             # http://localhost:5173 （dev 有图片代理）
npm run web:build           # 构建到 docs/（纯静态，无代理）
npm run fixtures            # 更新首屏 fixture 快照
npm test                    # 离线回归测试（38 个用例）
```

本地 dev 模式会用 Vite 中间件代理 B 站图片；构建后的 `docs/` 是纯静态，所有图片已是本地文件。

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

每次运行都会调用 `x/web-interface/card` 复核 `official_verify.type === 1`，异常会在日志里告警。

### 网站图标与 Manifest

`apps/web/public/` 下的 `favicon.svg`、`favicon-32.png`、`apple-touch-icon.png`、`icon-192.png` 与 `icon-512.png` 是站点图标资源；`site.webmanifest` 提供 PWA 元数据，其中 `theme_color` / `background_color` 均为 `#181518`，并声明 192×192 与 512×512 两个 PNG 图标。图标采用深色圆角方块、琥珀渐变资讯卡与星火信号点，呼应站内主色 `#ffb454` 与「二游资讯 + 更新」主题。

## 刷新频率与体积控制

- Actions 每 6 小时跑一次，也可手动触发
- `data/store.json` 每游戏保留最近 400 条 / 150 天内的动态；raw 字段压缩存储（约 10x），控制仓库体积
- 图片按 URL 的 SHA1 命名并缓存，重复图片不重复下载
- 站点全相对路径（`base: './'`），支持 `https://<user>.github.io/<repo>/` 子路径部署

## 厂商标签页 / 当前活动 / 角色生日

前端按厂商把 11 款游戏分成 7 个标签页，默认选中「米哈游」；切换标签会同步 `#publisher=<key>` 深链，支持左右方向键 / Home / End。标签顺序与厂商配置在 `apps/crawler/config/publishers.ts`。

每张游戏卡片新增两个数据块：

- **当前活动**：来自 `apps/crawler/config/curation.ts` 的人工种子 ∪ 官方动态自动识别（活动 / 限时 / 复刻 / 预下载 / 测试 / 预约等关键词），最多 3 条，按「进行中 → 即将开始 → 时间待定 → 最近结束」排序，附官方动态链接。没有活动数据的卡片不渲染该块。
- **角色生日**：从官方 `#角色# #生日快乐#` 动态学习 MM-DD，按「今天 / 未来 30 天 → 过去 30 天 → 其余」排序，最多 4 条；跨运行累积到 `data/birthdays.json`。绝区零等账号的生日动态多为互动抽奖、同一角色日期不一致，不做发布日推断；**没有生日数据的游戏完全隐藏该块**，不显示空占位。原神是当前唯一稳定可学习生日数据的游戏。

预约阶段的游戏（崩坏：因缘精灵 / 蓝色星原：旅谣 / 白银之城）使用 `stage: 'prelaunch'`：卡片显示「未开放下载 · 预约中」、官方账号入口与预热里程碑，隐藏版本统计与卡池；官方已公布档期时 `release.date` 会写入真实日期，但直到正式上线前仍保持预约态。

`feed.json` 已升级到 `schema_version: 3`：顶层新增 `publishers`，每款游戏新增 `publisher_key / publisher_name / publisher_color / stage / official_account / download / release / events / birthdays`，旧字段全部保留。无网络时可用 `npm run feed:rebuild` 从 `data/store.json` 离线重建。

## 限定卡池

官方祈愿公告已能自动解析卡池角色与开池时间，并与人工配置做并集合并（见「数据抓取管线」第 4 点），新角色无需手改配置即可进站。但 B 站公告通常**不公布结束时间**，因此期次时段仍由 `apps/crawler/config/banners.ts` 人工维护，状态与「剩余 N 天」由程序自动计算；`source` 字段标明角色来自 `config`、`bilibili` 还是 `config+bilibili`。无人工 config 的游戏（如 HSR）只显示未结束期次。

## 目录

```
.github/workflows/refresh.yml   定时刷新 + 提交 + 触发 Pages 部署
apps/crawler/
  config/                       游戏 UID / 厂商 / 活动与生日种子 / 卡池配置
  src/sources/bilibili/         客户端（WBI 签名 / Cookie）
  src/extract/
    opus.ts                     Opus 统一内容模型（文本 / 图片 / 标题）
    banners.ts                  祈愿公告解析 + config∪官方合并
    normalize.ts                动态归一化（视频 / 图文 / 转发）
    feed.ts                     版本识别 / 下个节点 / 活动生日 / feed+RSS 构建
    calendar.ts                 活动状态 / 生日学习 / 下一次生日（纯函数）
  src/index.ts                  深度回填 + 生日簿落盘 + 覆盖率告警 + health 兜底
  src/rebuild.ts                离线重建 feed（feed:rebuild）
  src/store/json.ts             无状态 JSON 存储 + raw 压缩（compactRaw）
  src/utils/media.ts            图片本地化
apps/web/                       Vue 3 + Vite 前端（厂商标签页 / 活动 / 生日卡片）
data/store.json                 持久状态（随 git 提交，raw 压缩）
data/health.json                抓取健康状态（ok / degraded / stale）
data/birthdays.json             跨运行累积的角色生日簿
data/fixtures/                  首屏 + HSR 深度快照（fixture 回归测试用；新游无 fixture 自动跳过）
scripts/snapshot-fixtures.ts    fixture 抓取脚本（--pages / --game / --out）
tests/                          opus / banners / 压缩 / 下个节点 / 活动生日离线回归测试
docs/                           构建产物（Pages 托管源）
```

## 注意

- `BILIBILI_COOKIE` 存于 GitHub Secrets，不要提交到仓库；Cookie 过期需更新 Secret
- 抽取为规则实现，官方文案格式变化时需调整正则
- 仅供个人学习，内容版权归各游戏官方所有
