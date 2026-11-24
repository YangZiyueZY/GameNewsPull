<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Game, MediaItem, NewsItem } from './types';
import EventList from './EventList.vue';
import BirthdayList from './BirthdayList.vue';
import { cleanTitle, fmtDate, img, initials } from './lib/format';
import { publisherOf } from './lib/publishers';

const props = withDefaults(defineProps<{
  game: Game;
  /** 由 App 预过滤（契约外增量 props，均带默认值） */
  media?: MediaItem[];
  news?: NewsItem[];
  generatedAt?: string;
}>(), { media: () => [], news: () => [], generatedAt: '' });

const emit = defineEmits<{
  (e: 'play-media', media: MediaItem): void;
  (e: 'show-sources', game: Game): void;
}>();

const isPrelaunch = computed(() => {
  if (props.game.stage) return props.game.stage === 'prelaunch';
  return props.game.download?.available === false;
});

const pub = computed(() => publisherOf(props.game));
const stageLabel = computed(() => (isPrelaunch.value ? '预约中' : '已上线'));

const mediaList = computed(() => (props.media || []).slice(0, 4));
const newsList = computed(() =>
  (props.news || []).slice(0, 6).map((n) => ({ ...n, displayTitle: cleanTitle(n.title, props.game.game_name) })),
);
const events = computed(() => props.game.events || []);
const birthdays = computed(() => props.game.birthdays || []);

const activeThumb = ref(0);
watch(() => props.game.key, () => { activeThumb.value = 0; });

const featuredIndex = computed(() => (activeThumb.value < mediaList.value.length ? activeThumb.value : 0));
const featured = computed(() => mediaList.value[featuredIndex.value] || null);

const versionContent = computed(() => {
  if (isPrelaunch.value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of props.game.current_content || []) {
    const text = cleanTitle(raw, props.game.game_name);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
});
const banners = computed(() => props.game.up_banners || []);
const official = computed(() => props.game.official_account || null);
const releaseLabel = computed(() => props.game.release?.label || '上线时间待官方公布');
const releaseDays = computed(() => props.game.release?.days_until ?? null);

function sourceCount() {
  return props.game.sources?.length || 0;
}

function daysText(n: number | null | undefined) {
  return n == null ? '时间待公布' : `${n} 天`;
}

function bannerTime(b: { end_at?: string | null; note?: string | null }) {
  if (b.end_at) return '至 ' + fmtDate(b.end_at);
  if (b.note) return b.note;
  return '';
}
</script>

<template>
  <article class="card" :class="isPrelaunch ? 'card-prelaunch' : 'card-live'" :data-game="game.key">
    <header class="card-header">
      <div class="game-title">
        <div class="game-icon">
          <span>{{ initials(game.game_name) }}</span>
          <img
            v-if="game.icon_url"
            :src="img(game.icon_url)"
            alt=""
            loading="lazy"
            @error="(e) => ((e.target as HTMLImageElement).hidden = true)"
          />
        </div>
        <div class="title-main">
          <h3 class="game-name">{{ game.game_name }}</h3>
          <div class="game-sub">
            <span class="pub-dot" :style="{ background: pub.color }" aria-hidden="true"></span>
            <span class="pub-name">{{ pub.name }}</span>
            <span class="stage-badge" :class="isPrelaunch ? 'is-pre' : 'is-live'">{{ stageLabel }}</span>
          </div>
        </div>
      </div>

      <!-- 正式游戏：三项统计 -->
      <div v-if="!isPrelaunch" class="stats">
        <div class="stat">
          <div class="stat-label">当前版本</div>
          <div class="stat-value">{{ game.current_version || '—' }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">下个节点</div>
          <div class="stat-value">{{ game.next_version || '—' }}</div>
        </div>
        <div class="stat" :class="{ 'is-accent': game.days_to_next_version != null }">
          <div class="stat-label">距离更新</div>
          <div class="stat-value">{{ daysText(game.days_to_next_version) }}</div>
        </div>
      </div>

      <!-- 预约游戏：状态条（隐藏统计 / 版本 / 卡池） -->
      <div v-else class="launch-strip">
        <div class="launch-line">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" />
          </svg>
          <span>未开放下载</span>
          <span class="launch-sep">·</span>
          <span class="launch-pill">预约中</span>
        </div>
        <div class="launch-release">
          <span class="launch-release-label">{{ releaseLabel }}</span>
          <span v-if="releaseDays != null" class="launch-release-days">约 {{ releaseDays }} 天后</span>
        </div>
        <a
          v-if="official?.url"
          class="official-btn"
          :href="official.url"
          target="_blank"
          rel="noopener"
        >
          官方账号
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M7 17 17 7" /><path d="M9 7h8v8" />
          </svg>
        </a>
      </div>
    </header>

    <div class="card-body">
      <!-- 前瞻（正式游戏） -->
      <div v-if="!isPrelaunch && game.preview_title" class="preview-box">
        <div class="section-title">前瞻</div>
        <a v-if="game.preview_replay_url" :href="game.preview_replay_url" target="_blank" rel="noopener" class="preview-link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0" aria-hidden="true">
            <rect x="2" y="7" width="20" height="14" rx="2" /><path d="m17 2-5 5-5-5" />
          </svg>
          <span class="preview-text">{{ game.preview_title }}</span>
        </a>
        <div v-else class="preview-plain">{{ game.preview_title }}</div>
        <div v-if="game.preview_start_at" class="preview-date">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          {{ fmtDate(game.preview_start_at) }}
        </div>
      </div>

      <!-- 官方影像 -->
      <div v-if="featured" class="block">
        <div class="section-title">
          官方影像
          <span class="section-count">{{ mediaList.length }}</span>
        </div>
        <div class="media-featured">
          <button class="thumb" type="button" @click="emit('play-media', featured)">
            <img v-if="featured.poster_url" :src="img(featured.poster_url)" alt="" loading="lazy" />
            <span class="thumb-play" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </button>
          <div class="media-info">
            <div class="media-top">
              <span class="media-badge">{{ featured.category_label }}</span>
              <span class="media-date">{{ fmtDate(featured.published_at) }}</span>
              <span v-if="featured.duration" class="media-duration">{{ featured.duration }}</span>
            </div>
            <a :href="featured.url" target="_blank" rel="noopener" class="media-title">{{ featured.title }}</a>
            <div class="media-thumbs">
              <button
                v-for="(m, i) in mediaList"
                :key="m.id"
                type="button"
                class="mini-thumb"
                :class="{ 'is-active': i === featuredIndex }"
                :style="m.poster_url ? { backgroundImage: `url(${img(m.poster_url)})` } : undefined"
                :title="m.title"
                @click="activeThumb = i"
              ></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 版本内容 -->
      <div v-if="versionContent.length" class="block">
        <div class="section-title">版本内容</div>
        <div class="version-content">
          <span v-for="c in versionContent" :key="c" class="version-chip">{{ c }}</span>
        </div>
      </div>

      <!-- 限定卡池 -->
      <div v-if="!isPrelaunch && banners.length" class="block">
        <div class="section-title">限定卡池</div>
        <div class="banners">
          <div
            v-for="b in banners"
            :key="b.label + (b.characters || []).join('/')"
            class="banner"
            :class="{ 'is-ended': b.status === '已结束', 'is-soon': b.status === '未开始' }"
          >
            <div class="banner-row">
              <span class="banner-label">{{ b.label }}</span>
              <span class="banner-chars">
                <span v-for="c in b.characters || []" :key="c" class="char-chip">{{ c }}</span>
              </span>
              <span class="banner-remain">
                <template v-if="b.status === '进行中' && b.days_remaining != null">剩余 {{ b.days_remaining }} 天</template>
                <template v-else-if="b.status === '已结束'">已结束</template>
                <template v-else-if="b.status === '未开始'">{{ b.start_at ? fmtDate(b.start_at) + ' 开始' : '即将开始' }}</template>
                <template v-else>时间待公布</template>
              </span>
            </div>
            <div v-if="bannerTime(b)" class="banner-time">{{ bannerTime(b) }}</div>
          </div>
        </div>
      </div>
      <div v-else-if="!isPrelaunch && (game.current_up_characters || []).length" class="block">
        <div class="section-title">当期推荐</div>
        <div class="up-chars">{{ (game.current_up_characters || []).join('、') }}</div>
      </div>

      <!-- 当前活动 / 预热进度 -->
      <EventList :events="events" :stage="isPrelaunch ? 'prelaunch' : 'live'" />

      <!-- 角色生日：无数据整块隐藏 -->
      <BirthdayList :birthdays="birthdays" />

      <!-- 最新动态 -->
      <div v-if="newsList.length" class="block">
        <div class="section-title">
          最新动态
          <span class="section-count">{{ newsList.length }}</span>
        </div>
        <div class="news-list">
          <a v-for="n in newsList" :key="n.id" :href="n.url" target="_blank" rel="noopener" class="news-item">
            <div class="news-top">
              <span class="news-type">{{ n.type === 'video' ? '视频' : n.type === 'forward' ? '转发' : '动态' }}</span>
              <span class="news-date">{{ fmtDate(n.published_at) }}</span>
            </div>
            <div class="news-title">{{ n.displayTitle }}</div>
          </a>
        </div>
      </div>
    </div>

    <footer class="card-footer">
      <span class="footer-time">更新于 {{ generatedAt ? fmtDate(generatedAt) : '—' }}</span>
      <button class="source-btn" type="button" @click="emit('show-sources', game)">
        信源 {{ sourceCount() }} 条 ›
      </button>
    </footer>
  </article>
</template>
