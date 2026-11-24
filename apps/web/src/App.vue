<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Feed, Game, MediaItem, NewsItem } from './types';
import PublisherTabs from './PublisherTabs.vue';
import GameCard from './GameCard.vue';
import { buildPublishers, publisherKeyOf } from './lib/publishers';
import { fmtDate, fmtDay } from './lib/format';

const feed = ref<Feed | null>(null);
const loading = ref(true);
const error = ref('');
const activeMedia = ref<MediaItem | null>(null);
const sourcesFor = ref<Game | null>(null);
const activeTab = ref('mihoyo');
const isDemo = ref(false);

const demoMode = new URLSearchParams(location.search).get('demo') === 'v3';

// public/favicon.svg 在运行时按文档地址解析：
// 构建后为 ./favicon.svg（支持 github.io/<repo>/ 子路径），dev 为 /favicon.svg。
// 不用模板里的静态相对路径，避免 Vite 把它当成 src/ 下的模块资源。
const logoUrl = typeof document === 'undefined' ? './favicon.svg' : new URL('favicon.svg', document.baseURI).href;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('./feed.json?t=' + Date.now());
    if (!res.ok) throw new Error(`数据加载失败（HTTP ${res.status}）`);
    const raw = (await res.json()) as Feed;
    if (demoMode) {
      // 演示数据按需动态引入，正常路径不会加载该 chunk
      const mod = await import('./data/demo');
      feed.value = mod.applyDemo(raw);
      isDemo.value = true;
    } else {
      feed.value = raw;
      isDemo.value = false;
    }
    ensureTab();
  } catch (e: any) {
    error.value = e?.message || '未知错误';
  } finally {
    loading.value = false;
  }
}

const games = computed<Game[]>(() => feed.value?.data?.games || []);
const publishers = computed(() => buildPublishers(feed.value));

const counts = computed(() => {
  const map: Record<string, number> = {};
  for (const g of games.value) {
    const k = publisherKeyOf(g);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
});

/** 只展示有游戏的厂商，避免空标签页 */
const visiblePublishers = computed(() => publishers.value.filter((p) => (counts.value[p.key] || 0) > 0));

const activePublisher = computed(() => publishers.value.find((p) => p.key === activeTab.value) || null);
const activeGames = computed(() => games.value.filter((g) => publisherKeyOf(g) === activeTab.value));

const media = computed<MediaItem[]>(() => feed.value?.media?.items || []);
const news = computed<NewsItem[]>(() => feed.value?.news || []);

function groupBy(items: Array<MediaItem | NewsItem>) {
  const map = new Map<string, any[]>();
  for (const it of items) {
    const keys = new Set<string>();
    if (it.game_key) keys.add('k:' + it.game_key);
    if (it.game_name) keys.add('n:' + it.game_name);
    for (const k of keys) {
      const arr = map.get(k) || [];
      arr.push(it);
      map.set(k, arr);
    }
  }
  return map;
}

const mediaGroups = computed(() => groupBy(media.value));
const newsGroups = computed(() => groupBy(news.value));

function mediaFor(g: Game): MediaItem[] {
  return (mediaGroups.value.get('k:' + g.key) || mediaGroups.value.get('n:' + g.game_name) || []).slice(0, 4);
}
function newsFor(g: Game): NewsItem[] {
  return (newsGroups.value.get('k:' + g.key) || newsGroups.value.get('n:' + g.game_name) || []).slice(0, 6);
}

/** 默认 mihoyo；无该厂商时选第一个 */
function ensureTab() {
  const keys = visiblePublishers.value.map((p) => p.key);
  const fromHash = readHash();
  if (fromHash && keys.includes(fromHash)) activeTab.value = fromHash;
  else activeTab.value = keys.includes('mihoyo') ? 'mihoyo' : keys[0] || 'mihoyo';
  // 首次载入即同步 #publisher=xxx（replaceState，不产生历史记录）
  syncHash(activeTab.value);
}

function readHash(): string | null {
  const m = /publisher=([\w-]+)/.exec(location.hash || '');
  return m ? m[1] : null;
}

function syncHash(key: string) {
  if (!key) return;
  const next = `${location.pathname}${location.search}#publisher=${key}`;
  if (location.hash !== `#publisher=${key}`) history.replaceState(null, '', next);
}

watch(activeTab, (k) => syncHash(k));

function onHashChange() {
  const key = readHash();
  if (key && visiblePublishers.value.some((p) => p.key === key) && key !== activeTab.value) {
    activeTab.value = key;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (activeMedia.value) activeMedia.value = null;
  else if (sourcesFor.value) sourcesFor.value = null;
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKeydown);
  load();
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('keydown', onKeydown);
});

const overview = computed(() => {
  const parts = [`${games.value.length} 款游戏`, `${visiblePublishers.value.length} 家厂商`];
  if (feed.value?.generated_at) parts.push(`更新于 ${fmtDate(feed.value.generated_at)}`);
  return parts;
});
</script>

<template>
  <div class="page">
    <header class="header">
      <div class="brand">
        <a class="brand-mark" href="./" aria-label="二游资讯首页">
          <img :src="logoUrl" alt="" width="38" height="38" />
        </a>
        <div class="brand-text">
          <h1>二游资讯<span class="brand-dot">.</span></h1>
          <div class="overview">
            <template v-for="(part, i) in overview" :key="part">
              <span v-if="i" class="overview-sep" aria-hidden="true">·</span>
              <span>{{ part }}</span>
            </template>
            <span v-if="isDemo" class="demo-tag">演示数据</span>
          </div>
        </div>
      </div>
      <a class="rss-link" href="./feed.rss" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1" />
        </svg>
        RSS 订阅
      </a>
    </header>

    <PublisherTabs
      v-if="!loading && !error && visiblePublishers.length"
      v-model="activeTab"
      :publishers="visiblePublishers"
      :counts="counts"
    />

    <div v-if="loading" class="state">
      <div class="spinner" aria-hidden="true"></div>
      <p>正在加载资讯数据…</p>
    </div>

    <div v-else-if="error" class="state state-error">
      <h2>数据加载失败</h2>
      <p>{{ error }}</p>
      <button class="retry-btn" type="button" @click="load">重试</button>
    </div>

    <template v-else>
      <section
        class="tabpanel"
        role="tabpanel"
        :id="`panel-${activeTab}`"
        :aria-labelledby="`tab-${activeTab}`"
        tabindex="0"
      >
        <div class="panel-head" :class="{ 'is-single': activeGames.length === 1 }">
          <h2>
            <span class="panel-dot" :style="{ background: activePublisher?.color || 'var(--primary)' }" aria-hidden="true"></span>
            {{ activePublisher?.name || '全部游戏' }}
          </h2>
          <span class="panel-count">{{ activeGames.length }} 款游戏</span>
        </div>

        <div v-if="activeGames.length" class="grid" :class="{ 'is-single': activeGames.length === 1 }">
          <GameCard
            v-for="g in activeGames"
            :key="g.key"
            :game="g"
            :media="mediaFor(g)"
            :news="newsFor(g)"
            :generated-at="feed?.generated_at"
            @play-media="activeMedia = $event"
            @show-sources="sourcesFor = $event"
          />
        </div>
        <div v-else class="empty">该厂商暂未收录游戏</div>
      </section>

      <div class="footer">
        数据来自各游戏 B 站官方账号 · 仅供玩家参考 · 以官方公告为准 · 生成于 {{ fmtDay(feed?.generated_at) }}
      </div>
    </template>

    <div v-if="activeMedia" class="modal-backdrop" @click.self="activeMedia = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="activeMedia.title">
        <div class="modal-header">
          <h3>{{ activeMedia.game_name }} · {{ activeMedia.title }}</h3>
          <button type="button" @click="activeMedia = null" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">
          <iframe :src="activeMedia.player_url + '&autoplay=1'" allowfullscreen scrolling="no" frameborder="0" :title="activeMedia.title"></iframe>
        </div>
      </div>
    </div>

    <div v-if="sourcesFor" class="modal-backdrop" @click.self="sourcesFor = null">
      <div class="modal modal-sources" role="dialog" aria-modal="true" :aria-label="`${sourcesFor.game_name} 信源`">
        <div class="modal-header">
          <h3>{{ sourcesFor.game_name }} · 信源</h3>
          <button type="button" @click="sourcesFor = null" aria-label="关闭">✕</button>
        </div>
        <div class="sources-body">
          <a v-if="sourcesFor.official_account?.url" class="source-row is-official" :href="sourcesFor.official_account.url" target="_blank" rel="noopener">
            <span class="source-type">官方账号</span>
            <span class="source-title">{{ sourcesFor.official_account.name }} · space/{{ sourcesFor.official_account.mid }} ↗</span>
          </a>
          <a v-for="(s, i) in sourcesFor.sources || []" :key="i" class="source-row" :href="s.url" target="_blank" rel="noopener">
            <span class="source-title">{{ s.title }} ↗</span>
          </a>
          <p v-if="!(sourcesFor.sources || []).length" class="sources-empty">暂无信源记录</p>
        </div>
      </div>
    </div>
  </div>
</template>
