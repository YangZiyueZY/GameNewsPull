---
name: 二游资讯-定期维护
description: 面向仓库运维人员与 AI 智能体：对「手写信源」做定期校正（卡池时段骨架、角色字典、活动种子、游戏配置、信源快照），并验证每日 GitHub Action 仍然正常出数。
---

# 二游资讯 · 定期手动维护 Skill

> 适用对象：本仓库（`YangZiyueZY/GameNewsPull`）的运维人员，或代为执行的 AI 智能体。
> 频率建议：**每月 1 次**；每次游戏大版本更新后补 1 次；CI 连续 3 天出现 `banner_warnings` 时立即执行。

## 0. 这个仓库的分工（先理解再动手）

| 数据来源 | 是否需要人工 | 说明 |
|---|---|---|
| 自动信源（鹰角 CMS / 库洛官网 / 碧蓝日服·国际服 / Akasha / PRTS / B 站官号 / ntegude / 异环官网） | ❌ 不需要 | 每天 09:30 Action 自动抓取、合并、提交 |
| 角色字典 `data/char-names.json` | ⚠️ 半自动 | 每次抓取会**自动扩写**；人工只需校正冲突名/别名/形态名 |
| 卡池时段骨架 `apps/crawler/config/banners.ts` | ✅ 需要 | 官方多数不公布结束时间，需人工补 `start/end`；**禁止写角色名** |
| 活动种子 `apps/crawler/config/curation.ts` | ✅ 需要 | 人工维护的活动/预热里程碑 |
| 游戏与厂商配置 `config/games.ts` / `config/publishers.ts` | ✅ 需要 | 新游戏上线、mid 变更、stage 切换（prelaunch ↔ live） |
| 测试快照 `data/fixtures/sources/*.json` | ✅ 需要 | 信源格式变化后重新裁剪；它是「解析契约」，不是生产数据 |

## 1. 执行前检查

1. 本地：`npm ci`，`.env` 里 `BILIBILI_COOKIE` 有效（B 站风控必需）。
2. 拉最新：`git pull --rebase`（Action 每天会提交数据，本地落后会很常见）。
3. 基线：`npm test` 必须全绿；不是全绿先别改数据。

## 2. 体检（看每天自动跑出来的结果）

```bash
npm run feed:rebuild        # 用库存 + 信源缓存离线重建，不联网、不下载图片
npm test                    # 解析契约 + 卡池口径，139+ 用例
```

然后看 `data/health.json` 三个字段：

- `status`：`ok / degraded / stale`。`stale` = 当天 B 站整体抓取失败（站点仍在用库存渲染）。
- `banner_sources[]`：每个信源本轮候选数。**某源突然变 0 或骤降 → 大概率网站改版**。
- `banner_warnings[]`：解析失败、守卫丢弃、信源骤降告警都在这里。

逐游戏核对 `docs/feed.json`：

| 检查项 | 期望 |
|---|---|
| `data.games[].current_up_characters` | 只含**当前**限定池 UP，不含上一版本角色 |
| `up_banners[]` | 进行中全部 + 最多 2 条已结束；无空角色池、无武器池 |
| `pact_banners[]` | 仅异环「协定卡池」（限定棋盘） |
| 每条卡池 | `confidence: high` 优先；`low` 表示只有单一非官方源 |

## 3. 手写信源校正（核心工作）

### 3.1 卡池时段骨架 `apps/crawler/config/banners.ts`

- 只维护 `label / start / end`，**不要写 `characters`**（角色一律由信源引擎产出，手写会导致新一轮「明河」事故）。
- 官方公布结束时间后补 `end`；没公布就留 `null`（引擎会用「下一期开池时间」近似）。
- 新开一期：追加一条，`start` 用东八区 ISO（`2026-12-02T12:00:00+08:00`）。

### 3.2 角色字典 `data/char-names.json`

- 自动扩写只补「新角色」，**不会修错**：同名不同人、形态名（泳装/礼服）、英文/日文写法不一致都需要人工校正。
- 新增条目格式：`{ "cn": "国服中文名", "en": "英文名", "jp": "日文名", "aliases": ["别名"] }`。
- 判定口径：某游戏字典 **< 8 条**时，引擎会跳过角色名校验并强制降置信度；补到 8 条以上才会真正生效。

### 3.3 活动种子 `apps/crawler/config/curation.ts`

- 人工活动与官方动态并存；失效活动删掉，避免长期挂在「进行中」。

### 3.4 游戏/厂商 `config/games.ts` / `config/publishers.ts`

- 新游上线：`stage: 'prelaunch' → 'live'`、补 `release.date`、`download`。
- 国服官号 mid 变更时改 `mid`（并保留 `official.url`）。
- 没有国服官号的游戏（如碧蓝航线）设 `bili: false`，走日服/国际服 JSON。

### 3.5 测试快照 `data/fixtures/sources/*.json`

- 只在**信源格式变化**时更新：抓一份真实响应 → 裁剪到最小可复现 → 覆盖同名文件 → `npm test`。
- 注意：`data/source-cache/` 是运行时缓存（已 gitignore，每天被覆盖），**不要把测试快照放那里**。

## 4. 提交与验证

```bash
npm test && npm run feed:rebuild && npm run web:build
git add data/ docs/ apps/ tests/ skill/
git commit -m "chore(maintenance): 校正手写信源 YYYY-MM-DD"
git push
```

推送后到 GitHub → Actions → **刷新二游资讯** → Run workflow，确认：

1. 测试步骤绿；2. 抓取日志里有 `[banners] 信源 N 个: …` 与各源候选数；3. 提交步骤产生一条 `(CST)` 心跳提交。

## 5. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 某游戏 `up_banners: []` | 该源这轮没解析到 | 看 `banner_warnings`；单源游戏（终末地/异环）优先查官网是否改版 |
| 卡池齐但 `confidence: low` | 只有单一非官方源 | 补第二源，或把官方源适配器修好 |
| 角色显示「待核实」 | 字典覆盖不足或单源 | 补字典到 8 条以上 / 增加信源 |
| 出现「时间待公布」空卡 | 解析残片 | 不应出现：`visiblePools()` 会丢弃无时间池；若出现说明规则被绕过 |
| `health.status: stale` | B 站整体抓取失败 | 检查 `BILIBILI_COOKIE` 是否过期；站点仍会用库存渲染 |

## 6. 红线

- 不要手改 `docs/`（构建产物）与 `data/store.json`（抓取数据库）。
- 不要提交 `.env`、Cookie、任何密钥。
- 不要在 `config/banners.ts` 写角色名；不要为了「让页面好看」放宽 `visiblePools` 的过滤规则。
