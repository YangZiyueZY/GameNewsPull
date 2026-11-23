<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

const feed = ref<any>(null);
const loading = ref(true);
const error = ref('');
const activeMedia = ref<any>(null);
const sourcesFor = ref<any>(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('./feed.json?t=' + Date.now());
    if (!res.ok) throw new Error('数据加载失败');
    feed.value = await res.json();
  } catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);

const games = computed(() => feed.value?.data?.games || []);
const media = computed(() => feed.value?.media?.items || []);
const news = computed(() => feed.value?.news || []);

function mediaFor(game: string) {
  return media.value.filter((m: any) => m.game_name === game).slice(0, 4);
}
function newsFor(game: string) {
  return news.value.filter((n: any) => n.game_name === game).slice(0, 8);
}
function fmtDate(s: string) {
  if (!s) return '';
  const d = new Date(s);
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function days(n: number | null) {
  return n == null ? '时间待公布' : `${n} 天`;
}
function initials(name: string) { return name.slice(0, 1); }
function img(url?: string | null) {
  if (!url) return '';
  // 本地化图片（相对路径）直接用；远程图片仅在 dev 走代理
  if (/^https?:\/\//.test(url)) {
    return location.port === '5173' ? '/img?u=' + encodeURIComponent(url) : url;
  }
  // base:'./' 下相对路径需以 ./ 开头
  return url.startsWith('./') || url.startsWith('/') ? url : './' + url;
}
</script>

<template>
  <div class="page">
    <header class="header">
      <div>
        <h1>二游资讯</h1>
        <p class="subtitle">基于 B 站官方账号的版本动态、活动与限时招募汇总</p>
      </div>
      <a class="rss-link" href="./feed.rss" target="_blank">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
        RSS 订阅
      </a>
    </header>

    <div v-if="loading" class="loading">正在加载资讯数据…</div>
    <div v-else-if="error" class="error">
      <h2>数据加载失败</h2>
      <p>{{ error }}</p>
      <button @click="load" style="padding:.5rem 1rem;border:1px solid var(--border);border-radius:.5rem;background:var(--bg-nested);color:var(--fg)">重试</button>
    </div>

    <template v-else>
      <div class="grid">
        <article v-for="g in games" :key="g.key" class="card">
          <header class="card-header">
            <div class="game-title">
              <div class="game-icon">
                <span>{{ initials(g.game_name) }}</span>
                <img v-if="g.icon_url" :src="img(g.icon_url)" alt="" loading="lazy"
                     @error="(e) => ((e.target as HTMLImageElement).hidden = true)" />
              </div>
              <div style="min-width:0">
                <div class="game-name">{{ g.game_name }}</div>
                <div class="game-version">{{ g.current_version }}</div>
              </div>
            </div>
            <div class="stats">
              <div class="stat"><div>下个节点</div><div>{{ g.next_version }}</div></div>
              <div class="stat"><div>距离更新</div><div :style="{color: g.days_to_next_version != null ? 'var(--primary)' : 'var(--muted)'}">{{ days(g.days_to_next_version) }}</div></div>
              <div class="stat"><div>已开启</div><div>{{ g.current_version_days }} 天</div></div>
            </div>
          </header>
          <div class="card-body">
            <div v-if="g.preview_title" class="preview-box">
              <div class="section-title">前瞻</div>
              <a v-if="g.preview_replay_url" :href="g.preview_replay_url" target="_blank" rel="noopener" class="preview-link">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/></svg><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ g.preview_title }}</span>
              </a>
              <div v-else style="font-size:.8125rem">{{ g.preview_title }}</div>
              <div v-if="g.preview_start_at" class="preview-date">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                {{ fmtDate(g.preview_start_at) }}
              </div>
            </div>

            <template v-if="mediaFor(g.game_name).length">
              <div class="section-title">官方影像</div>
              <div class="media-featured">
                <button class="thumb" @click="activeMedia = mediaFor(g.game_name)[0]" style="border:0;padding:0">
                  <img v-if="mediaFor(g.game_name)[0].poster_url" :src="img(mediaFor(g.game_name)[0].poster_url)" alt="" loading="lazy" />
                </button>
                <div class="info">
                  <div style="display:flex;align-items:center;gap:.4rem">
                    <span class="media-badge">{{ mediaFor(g.game_name)[0].category_label }}</span>
                    <span style="font-size:.75rem;color:var(--muted)">{{ fmtDate(mediaFor(g.game_name)[0].published_at) }}</span>
                  </div>
                  <a :href="mediaFor(g.game_name)[0].url" target="_blank" rel="noopener" class="media-title">{{ mediaFor(g.game_name)[0].title }}</a>
                  <div class="media-meta">{{ mediaFor(g.game_name)[0].duration }}</div>
                  <div style="display:flex;gap:.35rem;margin-top:.35rem">
                    <button v-for="(m,i) in mediaFor(g.game_name)" :key="m.id" @click="activeMedia = m"
                      :style="{width:'2.5rem',height:'1.5rem',borderRadius:'.25rem',border:'1px solid var(--border)',background:m.poster_url?`url(${img(m.poster_url)}) center/cover`:'var(--bg-nested)',opacity:activeMedia?.id===m.id?1:.6}"
                      :title="m.title"></button>
                  </div>
                </div>
              </div>
            </template>

            <div>
              <div class="section-title">版本内容</div>
              <div style="font-size:.8125rem;margin-top:.25rem">{{ g.current_content?.slice(0,3).join('、') || '暂未获取' }}</div>
            </div>

            <div v-if="g.up_banners?.length">
              <div class="section-title">限定卡池</div>
              <div class="banners">
                <div v-for="b in g.up_banners" :key="b.label + b.characters.join('/')"
                     class="banner" :class="{ 'is-ended': b.status === '已结束', 'is-soon': b.status === '未开始' }">
                  <div class="banner-row">
                    <span class="banner-label">{{ b.label }}</span>
                    <span class="banner-chars">
                      <span v-for="c in b.characters" :key="c" class="char-chip">{{ c }}</span>
                    </span>
                    <span class="banner-remain">
                      <template v-if="b.status === '进行中' && b.days_remaining != null">剩余 {{ b.days_remaining }} 天</template>
                      <template v-else-if="b.status === '已结束'">已结束</template>
                      <template v-else-if="b.status === '未开始'">{{ b.start_at ? fmtDate(b.start_at) + ' 开始' : '即将开始' }}</template>
                      <template v-else>时间待公布</template>
                    </span>
                  </div>
                  <div v-if="b.end_at" class="banner-time">至 {{ fmtDate(b.end_at) }}</div>
                  <div v-else-if="b.note" class="banner-time">{{ b.note }}</div>
                </div>
              </div>
            </div>
            <div v-else-if="g.current_up_characters?.length">
              <div class="section-title">当期推荐</div>
              <div style="font-size:.8125rem;margin-top:.25rem;color:var(--primary)">{{ g.current_up_characters.join('、') }}</div>
            </div>

            <div v-if="newsFor(g.game_name).length">
              <div class="section-title">最新动态</div>
              <div class="news-list">
                <a v-for="n in newsFor(g.game_name)" :key="n.id" :href="n.url" target="_blank" rel="noopener" class="news-item">
                  <div class="news-top">
                    <span class="news-type">{{ n.type === 'video' ? '视频' : n.type === 'forward' ? '转发' : '动态' }}</span>
                    <span class="news-date">{{ fmtDate(n.published_at) }}</span>
                  </div>
                  <div class="news-title">{{ n.title }}</div>
                </a>
              </div>
            </div>
          </div>
          <footer class="card-footer">
            <span>数据更新于 {{ fmtDate(feed.generated_at) }}</span>
            <button class="source-btn" @click="sourcesFor = g">信源 {{ g.sources?.length || 0 }} 条 ›</button>
          </footer>
        </article>
      </div>
      <div class="footer">数据来自各游戏 B 站官方账号 · 仅供玩家参考 · 以官方公告为准</div>
    </template>

    <div v-if="activeMedia" class="modal-backdrop" @click.self="activeMedia = null">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ activeMedia.game_name }} · {{ activeMedia.title }}</h3>
          <button @click="activeMedia = null">✕</button>
        </div>
        <div class="modal-body">
          <iframe :src="activeMedia.player_url + '&autoplay=1'" allowfullscreen scrolling="no" frameborder="0"></iframe>
        </div>
      </div>
    </div>

    <div v-if="sourcesFor" class="modal-backdrop" @click.self="sourcesFor = null">
      <div class="modal" style="max-width:32rem">
        <div class="modal-header"><h3>{{ sourcesFor.game_name }} · 信源</h3><button @click="sourcesFor = null">✕</button></div>
        <div style="padding:1rem 1.25rem;overflow-y:auto">
          <a v-for="(s,i) in sourcesFor.sources" :key="i" :href="s.url" target="_blank" rel="noopener"
            style="display:block;padding:.5rem 0;border-bottom:1px solid var(--border);font-size:.8125rem">
            {{ s.title }} ↗
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
