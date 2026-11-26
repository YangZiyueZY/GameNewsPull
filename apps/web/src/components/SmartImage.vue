<script setup lang="ts">
// 图片三级降级：CDN（jsDelivr）→ GitHub Pages / raw → 站内相对路径。
// 为什么不用 <picture>：三个地址是「同一张图的不同托管点」，不是格式/尺寸变体，
// 只有真正加载失败（@error）才换下一个，所以用一个自维护的下标序列即可。
import { computed, ref, watch } from 'vue';
import { img as assetHref } from '../lib/format';

const props = withDefaults(defineProps<{
  /** jsDelivr 主地址（feed 的主字段） */
  cdn?: string | null;
  /** GitHub Pages / raw 回退地址（<字段>_fallback） */
  fallback?: string | null;
  /** 站内相对路径（<字段>_local） */
  local?: string | null;
  /** alt 文案；也是占位块的首字来源 */
  alt?: string;
}>(), { cdn: '', fallback: '', local: '', alt: '' });

const failedIndex = ref(-1);

// 去掉空值并去重：外链场景下三者可能是同一个地址，避免对同一 URL 反复失败
const sources = computed(() => {
  const out: string[] = [];
  for (const raw of [props.cdn, props.fallback, props.local]) {
    const href = assetHref(raw || '');
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
});

// 切换图片（换条目）时重置尝试序列，否则会沿用上一条的失败下标
watch(sources, () => { failedIndex.value = -1; });

const index = computed(() => (failedIndex.value < 0 ? 0 : failedIndex.value));
const current = computed(() => sources.value[index.value] ?? '');
const exhausted = computed(() => sources.value.length === 0 || index.value >= sources.value.length);
// 只有给了 alt 才在占位块里显示首字：卡片图标本身已有底色首字，别叠出两个字母
const initial = computed(() => (props.alt || '').trim().slice(0, 1));

function onError() {
  failedIndex.value = index.value + 1;
}
</script>

<template>
  <img
    v-if="!exhausted && current"
    class="smart-image"
    :src="current"
    :alt="alt"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    @error="onError"
  />
  <div v-else class="smart-image-fallback" role="img" :aria-label="alt || '暂无图片'">
    <span v-if="initial" aria-hidden="true">{{ initial }}</span>
  </div>
</template>

<style scoped>
/* 尺寸交给调用方（.game-icon img / .thumb img / .brand-mark img 等既有选择器）决定，
   这里只兜「万能规则」：不撑破容器、按容器比例裁切。 */
.smart-image {
  display: block;
  max-width: 100%;
  object-fit: cover;
}

/* 全部地址都失败时的占位：填满父容器，保证原 img 的布局尺寸不被撑塌 */
.smart-image-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 1em;
  color: var(--muted, #8b8b8b);
  background: var(--surface-2, rgba(255, 255, 255, 0.06));
  font-size: 0.95em;
  line-height: 1;
  user-select: none;
}
</style>
