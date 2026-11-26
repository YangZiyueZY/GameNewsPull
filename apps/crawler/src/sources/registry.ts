// 信源适配器注册表：所有卡池信源在这里汇总（resolver 按 tier 裁决，注册顺序不影响结果）。
// 新增信源：实现 SourceAdapter → 在此追加 → 在 data/source-cache 放裁剪 fixture 供离线测试。
import type { SourceAdapter } from '../pools/types.ts';
import { hypergryphCmsAdapter } from './hypergryph/cms.ts';
import { prtsSmwAdapter } from './prts/smw.ts';
import { akashaAdapter } from './akasha/calendar.ts';
import { kuroSiteAdapter } from './kuro/site.ts';
import { bluearchiveCargoAdapter } from './bluearchive/cargo.ts';
import { azurlaneJpAdapter, azurlaneEnAdapter } from './azurlane/news.ts';
import { nteGuideAdapter } from './nte/guide.ts';
import { biliDynamicsAdapter } from './bili/pools.ts';

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  // —— L0 官方一手 ——
  hypergryphCmsAdapter,     // 终末地 / 明日方舟 官网公告 CMS
  kuroSiteAdapter,          // 鸣潮官网公告 JSON
  azurlaneJpAdapter,        // 碧蓝航线日服公告（含维护窗口换算）
  azurlaneEnAdapter,        // 碧蓝航线国际服 WP REST
  biliDynamicsAdapter,      // B 站官方正文（蓝色星原「弦定观测」/ 鸣潮「唤取」/ BA「招募」/ 星铁「跃迁」）
  // —— L2 社区结构化 ——
  prtsSmwAdapter,           // 明日方舟常驻轮换（SMW ask + 卡池一览）
  akashaAdapter,            // 原神 / 星铁 / 绝区零 卡池日历
  bluearchiveCargoAdapter,  // 蔚蓝档案 日服/国际服（仅作校验，note 标 server）
  nteGuideAdapter,          // 异环角色名单（只提供 roster，不提供当期池）
];