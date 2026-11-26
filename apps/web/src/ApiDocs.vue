<script setup lang="ts">
// 本项目「拉取 API」文档面板：展示 docs/api/v1 的端点、信封、图片对象、卡池字段与示例。
// 数据优先读线上自描述的 index.json（每天构建一次），取不到就退回内置清单，保证离线也能查。
import { computed, onMounted, ref } from 'vue';

interface Endpoint { path: string; description?: string; count?: number | null; url?: string; raw_url?: string }
interface ApiIndex {
  api_version?: string;
  schema_version?: number;
  generated_at?: string;
  generated_at_utc?: string;
  counts?: { games?: number; news?: number; media?: number };
  endpoints?: Endpoint[];
  cdn?: { images?: string; api?: string };
}

const emit = defineEmits<{ (e: 'close'): void }>();

const loading = ref(true);
const error = ref('');
const index = ref<ApiIndex | null>(null);
const copied = ref('');

const FALLBACK_ENDPOINTS: Endpoint[] = [
  { path: 'index.json', description: '端点自描述 + 计数 + 生成时间' },
  { path: 'news.json', description: '全量资讯（含图片对象）' },
  { path: 'news/latest.json', description: '最新 50 条（嵌入首选）' },
  { path: 'games.json', description: '全部游戏状态 + 当期卡池' },
  { path: 'games/<key>.json', description: '单款游戏（如 games/endfield.json）' },
  { path: 'media.json', description: '官方影像（PV / 前瞻 / 短片）' },
  { path: 'birthdays.json', description: '角色生日（按游戏聚合）' },
  { path: 'feed.json', description: '全量 feed 镜像（与站点 feed.json 同构）' },
];

const endpoints = computed<Endpoint[]>(() => {
  const list = index.value?.endpoints ?? [];
  return list.length ? list : FALLBACK_ENDPOINTS;
});

const cdnBase = computed(() => index.value?.cdn?.api || 'https://cdn.jsdelivr.net/gh/YangZiyueZY/GameNewsPull@main/docs/api/v1');
const rawBase = 'https://raw.githubusercontent.com/YangZiyueZY/GameNewsPull/main/docs/api/v1';
const pageBase = 'https://yangziyuezy.github.io/GameNewsPull/';

const generated = computed(() => index.value?.generated_at || '（读取中）');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(new URL('api/v1/index.json', document.baseURI).href + '?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    index.value = (await res.json()) as ApiIndex;
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function copy(text: string, tag: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
  }
  copied.value = tag;
  window.setTimeout(() => { if (copied.value === tag) copied.value = ''; }, 1600);
}

const envelope = computed(() => JSON.stringify({
  api_version: 'v1',
  schema_version: index.value?.schema_version ?? 4,
  generated_at: index.value?.generated_at ?? '2026-11-26T20:35:00+08:00',
  generated_at_utc: index.value?.generated_at_utc ?? '2026-11-26T12:35:00.000Z',
  count: 50,
  cdn: { images: cdnBase.value.replace('/api/v1', '/img'), api: cdnBase.value },
  items: [],
}, null, 2));

const imageSample = JSON.stringify([{
  url: cdnBase.value.replace('/api/v1', '/img') + '/ab12cd34ef56.jpg',
  fallback: pageBase + 'img/ab12cd34ef56.jpg',
  local: 'img/ab12cd34ef56.jpg',
}], null, 2);

const codeSample = computed(() => [
  "const BASE = '" + cdnBase.value + "';",
  '// 最新 50 条',
  "const { items } = await fetch(BASE + '/news/latest.json').then(r => r.json());",
  '// 单款游戏的当期卡池',
  "const { game } = await fetch(BASE + '/games/endfield.json').then(r => r.json());",
  'console.log(game.up_banners);',
].join('\n'));

onMounted(load);
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal modal-api" role="dialog" aria-modal="true" aria-label="本项目 API 文档">
      <div class="modal-header">
        <h3>本项目 API · v1（嵌入用）</h3>
        <button type="button" @click="emit('close')" aria-label="关闭">✕</button>
      </div>
      <div class="api-body">
        <p class="api-lead">
          本站的<strong>拉取 API</strong>：构建时生成的只读静态 JSON，<strong>无需鉴权、无需 Key</strong>。
          主入口走 jsDelivr（自带 <code>Access-Control-Allow-Origin: *</code>），回退 GitHub 原始地址。
        </p>
        <p v-if="loading" class="api-hint">正在读取 index.json…</p>
        <p v-else-if="error" class="api-warn">读取 index.json 失败（{{ error }}），下面显示内置端点清单。</p>

        <div class="api-stat" v-if="index">
          <span>版本 v{{ index.api_version || '1' }}</span>
          <span>schema {{ index.schema_version }}</span>
          <span>游戏 {{ index.counts?.games ?? '—' }}</span>
          <span>资讯 {{ index.counts?.news ?? '—' }}</span>
          <span>影像 {{ index.counts?.media ?? '—' }}</span>
          <span>生成于 {{ generated }}（北京时间）</span>
        </div>

        <h4>基址</h4>
        <ul class="api-bases">
          <li>
            <span class="api-tag">CDN（推荐）</span>
            <code>{{ cdnBase }}/</code>
            <button type="button" class="api-copy" @click="copy(cdnBase + '/', 'cdn')">{{ copied === 'cdn' ? '已复制' : '复制' }}</button>
          </li>
          <li>
            <span class="api-tag">原始回退</span>
            <code>{{ rawBase }}/</code>
            <button type="button" class="api-copy" @click="copy(rawBase + '/', 'raw')">{{ copied === 'raw' ? '已复制' : '复制' }}</button>
          </li>
          <li>
            <span class="api-tag">站点</span>
            <code>{{ pageBase }}</code>
          </li>
        </ul>

        <h4>端点</h4>
        <table class="api-table">
          <thead><tr><th>路径</th><th>说明</th><th>条数</th></tr></thead>
          <tbody>
            <tr v-for="ep in endpoints" :key="ep.path">
              <td><code>{{ ep.path }}</code></td>
              <td>{{ ep.description || '—' }}</td>
              <td>{{ ep.count ?? '—' }}</td>
            </tr>
          </tbody>
        </table>

        <h4>响应信封</h4>
        <pre class="api-code">{{ envelope }}</pre>

        <h4>图片字段（三地址，取不到就降级）</h4>
        <pre class="api-code">{{ imageSample }}</pre>
        <p class="api-note"><code>url</code> 优先 CDN；失败按 <code>fallback</code> → 站内相对 <code>local</code> 降级。超出本地化配额的长尾图片仍是 B 站原链，条目的 <code>image_status</code> 为 <code>external</code>。</p>

        <h4>卡池字段（games[].up_banners[]）</h4>
        <table class="api-table">
          <thead><tr><th>字段</th><th>类型</th><th>含义</th></tr></thead>
          <tbody>
            <tr><td><code>label</code></td><td>string</td><td>期次/阶段标签（如「4.7 版本」「第一期」）</td></tr>
            <tr><td><code>pool_name</code></td><td>string</td><td>官方池名（如「锻砧、行囊与蜜糖」）</td></tr>
            <tr><td><code>pool_type</code></td><td>string</td><td>limited_character / rerun_character / standard_character / fes / pact / other</td></tr>
            <tr><td><code>characters</code></td><td>string[]</td><td>UP 角色（已过角色名单校验与去重）</td></tr>
            <tr><td><code>start_at / end_at</code></td><td>string｜null</td><td>东八区 ISO 时间；官方未公布时为 null</td></tr>
            <tr><td><code>status</code></td><td>string</td><td>进行中 / 未开始 / 已结束 / 时间待定</td></tr>
            <tr><td><code>confidence</code></td><td>high｜low</td><td>low = 仅单一非官方信源，页面标「待核实」</td></tr>
            <tr><td><code>sources</code></td><td>array</td><td>采用的信源（id / tier / url），便于回溯</td></tr>
          </tbody>
        </table>
        <p class="api-note"><code>pact_banners</code> 与 <code>up_banners</code> 同级：异环「协定卡池」单独放这里，不混入角色限定池。</p>

        <h4>调用示例</h4>
        <pre class="api-code">{{ codeSample }}</pre>
        <button type="button" class="api-copy api-copy-wide" @click="copy(codeSample, 'code')">{{ copied === 'code' ? '已复制' : '复制示例代码' }}</button>

        <p class="api-foot">数据每天北京时间 09:30 由 GitHub Actions 构建一次；jsDelivr 对 <code>@main</code> 有最长 12 小时缓存，需要「立即最新」请改用 <code>@&lt;commit-sha&gt;</code>。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-api { max-width: 46rem; width: min(92vw, 46rem); }
.api-body { padding: .6rem 1.1rem 1.2rem; overflow-y: auto; max-height: 72vh; }
.api-lead { font-size: .8125rem; color: var(--text-dim, #b9b3b0); line-height: 1.7; margin: .2rem 0 .8rem; }
.api-lead code, .api-body code { font-size: .78rem; }
.api-hint { font-size: .8rem; color: var(--text-dim, #b9b3b0); }
.api-warn { font-size: .8rem; color: #ffb454; }
.api-stat { display: flex; flex-wrap: wrap; gap: .4rem .9rem; font-size: .75rem; color: var(--text-dim, #b9b3b0); margin-bottom: .6rem; }
.api-body h4 { margin: 1.1rem 0 .45rem; font-size: .82rem; letter-spacing: .04em; color: var(--primary, #ffb454); }
.api-bases { list-style: none; padding: 0; margin: 0; display: grid; gap: .35rem; }
.api-bases li { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .76rem; }
.api-tag { flex: 0 0 auto; padding: .1rem .45rem; border: 1px solid var(--border, #3a3438); border-radius: 2rem; font-size: .7rem; color: var(--text-dim, #b9b3b0); }
.api-bases code { word-break: break-all; }
.api-copy { flex: 0 0 auto; padding: .15rem .5rem; border: 1px solid var(--border, #3a3438); border-radius: .3rem; background: transparent; color: var(--primary, #ffb454); font-size: .7rem; cursor: pointer; }
.api-copy:hover { background: rgba(255, 180, 84, .08); }
.api-copy-wide { margin-top: .4rem; }
.api-table { width: 100%; border-collapse: collapse; font-size: .76rem; }
.api-table th, .api-table td { text-align: left; padding: .32rem .45rem; border-bottom: 1px solid var(--border, #2c272b); vertical-align: top; }
.api-table th { font-weight: 600; color: var(--text-dim, #b9b3b0); font-size: .72rem; }
.api-code { margin: 0; padding: .6rem .7rem; background: #141114; border: 1px solid var(--border, #2c272b); border-radius: .4rem; overflow-x: auto; font-size: .72rem; line-height: 1.6; white-space: pre; }
.api-note { font-size: .74rem; color: var(--text-dim, #b9b3b0); line-height: 1.65; margin: .45rem 0 0; }
.api-foot { font-size: .72rem; color: var(--text-dim, #b9b3b0); margin-top: 1rem; line-height: 1.6; }
</style>