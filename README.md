# 二游资讯 · 静态资讯站

基于 B 站**蓝 V 官方账号**的二游资讯聚合站，覆盖原神 / 绝区零 / 明日方舟：终末地 / 崩坏：星穹铁道 / 异环。

**定位：纯静态项目。** 数据由 GitHub Actions 定时抓取并提交到仓库，站点托管在 GitHub Pages，无需服务器、无需数据库、无需代理。

## 工作原理

```
GitHub Actions (定时)  →  抓取B站官方API  →  生成 data/store.json
                       →  下载图片到 public/img
                       →  输出 feed.json / feed.rss 到 docs/
                       →  git commit & push
                                              ↓
                                   GitHub Pages 托管 docs/
```

- **存储**：`data/store.json`（随 git 提交持久化，替代数据库）
- **图片**：抓取时下载到 `apps/web/public/img/`，前端用相对路径，无需服务端代理
- **部署源**：`docs/` 目录（在仓库 Settings → Pages 中选择 "main / docs"）

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
```

本地 dev 模式会用 Vite 中间件代理 B 站图片；构建后的 `docs/` 是纯静态，所有图片已是本地文件。

## 数据来源（全部蓝 V 核验）

| 游戏 | B站 UID | 认证信息 |
|---|---|---|
| 原神 | 401742377 | 原神官方账号 |
| 绝区零 | 1636034895 | 绝区零官方账号 |
| 明日方舟：终末地 | 1265652806 | 《明日方舟：终末地》官方账号 |
| 崩坏：星穹铁道 | 1340190821 | 崩坏：星穹铁道官方账号 |
| 异环 | 3546636978489848 | 《异环》官方账号 |

每次运行都会调用 `x/web-interface/card` 复核 `official_verify.type === 1`，异常会在日志里告警。

## 刷新频率与体积控制

- Actions 每 6 小时跑一次，也可手动触发
- `data/store.json` 每游戏保留最近 400 条 / 150 天内的动态，控制仓库体积
- 图片按 URL 的 SHA1 命名并缓存，重复图片不重复下载
- 站点全相对路径（`base: './'`），支持 `https://<user>.github.io/<repo>/` 子路径部署

## 限定卡池

B 站官方动态只公布卡池角色、**不公布结束时间**，因此时段在 `apps/crawler/config/banners.ts` 人工维护，状态与「剩余 N 天」由程序自动计算。未配置的游戏会从最近的祈愿/调频动态兜底抽取角色名。

## 目录

```
.github/workflows/refresh.yml   定时刷新 + 提交 + 触发 Pages 部署
apps/crawler/
  config/                       游戏 UID / 卡池配置
  src/sources/bilibili/         客户端（WBI 签名 / Cookie）
  src/extract/                  归一化 / 版本与卡池抽取 / feed+RSS
  src/store/json.ts             无状态 JSON 存储
  src/utils/media.ts            图片本地化
apps/web/                       Vue 3 + Vite 前端
data/store.json                 持久状态（随 git 提交）
docs/                           构建产物（Pages 托管源）
```

## 注意

- `BILIBILI_COOKIE` 存于 GitHub Secrets，不要提交到仓库；Cookie 过期需更新 Secret
- 抽取为规则实现，官方文案格式变化时需调整正则
- 仅供个人学习，内容版权归各游戏官方所有
