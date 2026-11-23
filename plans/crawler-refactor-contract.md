# 重构接口契约（Implementation Contract）

> 供子智能体实现与测试对齐。实际实现见 apps/crawler/src/extract/opus.ts 与 banners.ts。

## 1. apps/crawler/src/extract/opus.ts

- readDynamicText(item)：opus.summary.text → desc.text → rich_text_nodes → 转发 orig；返回 trim 文本。
- readDynamicImages(item)：opus.pics[].url → draw.items[].src → 转发 orig；http→https、过滤空值、保序去重。
- readDynamicTitle(item)：opus.title 优先，否则正文首行（行内只有话题标签时拼接下一有效行）；上限 60 字符。
- readDynamicOpusTitle / isOpusOnlyItem / readDynamicPubTime / toHttpsUrl 辅助导出。

## 2. apps/crawler/src/extract/banners.ts

- AutoBannerPeriod { label, characters, start, end, version, source:'bilibili' }
- normalizeCharacterName(raw)：驹隙隐泉·兹白(岩) → 兹白（去括号后缀、取 · 最后一段、去「」）。
- parseBannerAnnouncements(items)：识别祈愿公告，角色 + 开池时间 + 版本号；跨公告按开池时间合并。
- buildBanners(gameKey, items)：config ∪ 官方公告；输出字段 label/phase/characters/start_at/end_at/status/days_remaining/note/source。

## 3. normalizeDynamic 行为

- 图文动态（含 opus 与旧 draw）：text 或 images 任一非空即返回条目；NewsItem 字段不变。
- 视频（AV/PGC）与转发（FORWARD）分支保持，转发读取 orig 的 opus 文本与图片。

## 4. index.ts 抓取统计

- CrawlStats { mid, pages, fetched, parsed, inserted, opusOnly, opusParsed, firstScreenTotal, firstScreenInStore }
- 停页条件：整页已入库 / 非首屏页命中已入库 id / 8 页 / 45 天 / 无更多分页；不再持久化 offset。
- 覆盖率 = 首屏成功解析条数 / 首屏条数；统计日志格式见 README「覆盖率与告警」。

## 5. 版本识别（feed.ts）

- 话题标签 #原神7.2版本# 优先；前瞻/即将类不算当前版本；卡池开池时间锚定 nextRelease；活动词表排除活动名。

## 6. 测试与 fixture

- data/fixtures/<gameKey>.json：{ captured_at, mid, items }，items 保留 id_str/type/module_author/module_dynamic/orig。
- tests/opus.test.ts、tests/banners.test.ts：node:test + node:assert，通过 tsx 运行（npm test）。
## 7. 第二轮变更（2026-11-24，遗留风险修复）

### 7.1 抓取深度（修 HSR 角色抓不到）
- 去掉「非首屏页命中已入库 id 即停」；停止条件只保留：整页已入库 / 8 页 / 45 天 / 无更多分页。
- 首次运行会回填约 45 天，之后每日第 1 页全已入库即停。

### 7.2 卡池解析补齐
- 时间区间分隔符新增 `-` `–` `—`（如 `2026/11/11 4.7版本更新后 - 2026/12/22 15:00`）。
- BOOST 文案新增 `限时提升|概率提升|概率限时提升`（HSR「跃迁成功概率限时提升」）。
- 无 config 的游戏（HSR）只保留「未结束或 7 天内结束」的期次，避免回填出 45 天历史期次。
- 验收：HSR 深度 fixture 解析出 4.7 期角色（含「星神★阿哈」）与 end=2026-12-22T15:00:00+08:00。

### 7.3 store 体积
- `Store.insertDynamic` 落盘前裁剪 raw：仅保留 `id_str/type/modules.module_author/modules.module_dynamic/orig.modules.module_dynamic`。
- 加载旧 store 时对历史行做同样迁移（flush 时写回）。
- 导出 `compactRaw(raw)` 供测试；断言压缩后 `normalizeDynamic(JSON.parse(compactRaw))` 与原对象 title/summary/images 一致。

### 7.4 下个版本语义
- 优先「话题标签/正文里比当前更高且有未来语境（更新后/即将/预计）的 X.Y版本」。
- 若无更高版本但有「未开始的卡池期次」，next 退化为该期次（label 形如 `7.2 第 2 期`），`days_to_next_version` 用其开始时间。
- 新增字段 `next_version_kind: 'version' | 'phase' | null`，前端 stat 标题由「下个版本」改为「下个节点」。

### 7.5 兜底与陈旧保护（单一数据源风险）
- `BiliClient.getDynamicFeed` 失败时按变体重试：无 features 参数 → 无 features 且 type=all；仍失败则抛错。
- 新增 `BiliClient.getSpaceVideos(mid)`（`/x/space/wbi/arc/search`）作为端点级兜底/健康检查。
- `runOnce`：若 5 个游戏全部抓取失败（fetched=0），**不覆盖** docs/public 的 feed.json/feed.rss，写 `data/health.json`（status/stale_since/reason），`exitCode=1`；部分失败仍输出并在 health 中记 degraded。
