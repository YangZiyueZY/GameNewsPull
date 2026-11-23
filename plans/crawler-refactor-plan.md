# 二游资讯 · 抓取逻辑重构方案

> 日期：2026-11-23 · 状态：已执行（用户确认后进入编码阶段）
> 实现说明：docs/ 是 Vite 构建产物目录，构建会清空，因此方案文档放在仓库根 plans/。

## 0. 结论（TL;DR）

官方确实更新了，但抓取“看不见”——不是网络/反爬问题，而是解析层把整类动态丢弃了。

B 站官方账号已把图文动态统一切到 Opus 格式：文本落在 modules.module_dynamic.major.opus.summary.text，图片落在 major.opus.pics，而 modules.module_dynamic.desc.text 为空。
旧 normalizeDynamic() 只读 desc.text / major.draw / major.archive，因此这类动态 text 与 images 均为空，被 return null 丢掉（normalize.ts:78）。

实测首屏（2026-11-23）：

| 游戏 | 首屏条数 | Opus-only（desc.text 为空） | 被丢弃 | 未入库 |
|---|---|---|---|---|
| 原神 | 13 | 12 | 12 | 12 |
| 绝区零 | 12 | 9 | 9 | 9 |
| 终末地 | 13 | 8 | 8 | 12 |
| 星穹铁道 | 13 | 5 | 5 | 5 |
| 异环 | 13 | 7 | 7 | 7 |

原神新增角色的直接证据（均在首屏，均被旧逻辑丢弃）：

- 1273842634488545282（11-23 18:00）祈愿公告：限定5星角色「驹隙隐泉·兹白(岩)」「博闻异旅·莉奈娅(岩)」，时间 2026/11/24 18:00 ~ 2026/12/15 14:59
- 1273471549368696833（11-22）兹白角色预告：「华黍由仪」祈愿将于11月24日18:00开启
- 1273378778045743106（11-22）莉奈娅角色预告：「呀吼吼博物志」活动祈愿将于2026年11月24日18:00开启

而 config/banners.ts 中第 2 期只人工写了 ['莉奈娅']，且 buildBanners() 只要有 config 就完全不走官方抽取（source: 'config'），所以新增的兹白永远进不了站点 —— 这正是“下一版本角色新增了一个，但抓取没有拉取到”。

## 1. 根因分层

| 层级 | 问题 | 位置 | 影响 |
|---|---|---|---|
| P0 解析 | 不识别 Opus 结构，图文动态整条丢弃 | extract/normalize.ts | 12/13 原神官方动态丢失（含全部卡池/角色公告） |
| P0 抽取 | 卡池角色只来自人工 config，官方公告不参与合并 | extract/feed.ts + config/banners.ts | 新角色必须人工补，漏补即缺失 |
| P1 抓取 | 固定翻 3 页 + 持久化 offset，版本日前爆发式发帖易漏；offset 跨运行复用 | src/index.ts | 沉默漏数，无告警 |
| P1 版本 | 版本号只靠「」正则，把联动活动当成版本 | extract/feed.ts | 版本状态错误，next_version 显示“暂未公布” |
| P2 兜底 | 单一数据源，B 站接口变更/风控无替代源 | — | 单点故障 |

## 2. 修复方案（已实现）

### 2.1 解析层：统一内容模型（P0）
新增 extract/opus.ts：readDynamicText / readDynamicImages / readDynamicTitle / isOpusOnlyItem。
优先级：major.opus.summary.text/title → desc.text → rich_text_nodes → major.draw → major.archive → 转发 orig；图片 opus.pics → draw.items → orig；http→https、保序去重。
normalizeDynamic() 改为基于统一模型判定，只要文本或图片任一非空即保留。

### 2.2 抽取层：结构化卡池/角色（P0）
新增 extract/banners.ts：parseBannerAnnouncements / normalizeCharacterName / buildBanners。
- 解析祈愿公告：限定5星角色「A(岩)」「B(岩)」、 「X」祈愿将于 Y 开启、本期活动祈愿时间为 A ~ B；
- 名称归一化：驹隙隐泉·兹白(岩) → 兹白；
- buildBanners 改为 config ∪ 官方合并：config 决定期次与时段，官方公告补充角色（并集，不删人工项），无 config 时用官方结果，source 标记 config / bilibili / config+bilibili。

### 2.3 抓取层：增量游标 + 覆盖率（P1）
- 删除 offset:<mid>:<page> 持久化分页状态；
- 每次从 page 0 翻页，停止条件：整页已入库 / 非首屏页命中已入库 id / 8 页 / 45 天 / 无更多分页；
- 每游戏输出 pages/fetched/parsed/opus/coverage/inserted 统计；解析失败率 >5% 或覆盖率 <100% 输出 WARN，结构性回归（≥20% / <90% / 抓取异常）在 --once/CI 下 exitCode=1。

### 2.4 版本识别（P1）
- 优先 #原神7.2版本# 话题标签（前瞻/即将类不算当前版本）；
- 用卡池公告开池时间锚定下个版本开始时间；
- 活动词表扩充（联动、特别节目、千星、音乐会、嘉年华、前瞻、表情包等），避免把活动当版本。

### 2.5 兜底（P2，后续）
保留扩展点：官网/米游社公告 API 作为第二数据源，失败时降级合并；本期未实现。

## 3. 验证方式与结果

1. 离线回归：data/fixtures/ 保存 2026-11-23 首屏真实响应，tests/opus.test.ts + tests/banners.test.ts 共 12 条断言（npm test 全绿，无需联网）。
2. 线上集成：npm run crawl:once 后
   - data/store.json 含 1273842634488545282 / 1273471549368696833 / 1273378778045743106；
   - docs/feed.json 中 genshin 第 2 期 characters = ['莉奈娅','兹白']，end_at = 2026-12-15T14:59:00+08:00，source = config+bilibili；
   - 5 款游戏 coverage=100%，opus=68/68，首轮新增 72 条。
3. 幂等性：第二次 crawl:once 全部“第 1 页全部已入库”，inserted=0。
4. 页面构建：npm run web:build 产出 docs/ 正常。

## 4. 风险与回滚

- 解析改动会让 feed 条目数明显增加（原神 7 → 22 条），store 已有 150 天/400 条/游戏裁剪；
- 卡池合并保留人工项，官方结果只做并集；
- 回滚：git revert 本次提交即可；data/store.json 为追加式，不受影响。
