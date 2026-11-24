<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { PublisherView } from './types';

const props = withDefaults(defineProps<{
  publishers: PublisherView[];
  modelValue: string;
  counts?: Record<string, number>;
}>(), { counts: () => ({}) });

const emit = defineEmits<{ (e: 'update:modelValue', key: string): void }>();

const listEl = ref<HTMLElement | null>(null);
const tabEls = ref<Record<string, HTMLElement | null>>({});

function setTabRef(key: string, el: unknown) {
  tabEls.value[key] = el instanceof HTMLElement ? el : null;
}

function select(key: string, focus = false) {
  if (!key) return;
  emit('update:modelValue', key);
  if (focus) nextTick(() => tabEls.value[key]?.focus());
}

/** 让激活标签留在可视区（只滚标签栏，不带动页面） */
function revealActive() {
  const list = listEl.value;
  const el = tabEls.value[props.modelValue];
  if (!list || !el) return;
  const left = el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2;
  const max = list.scrollWidth - list.clientWidth;
  list.scrollTo({ left: Math.max(0, Math.min(left, max)), behavior: 'smooth' });
}

watch(() => props.modelValue, () => nextTick(revealActive));
onMounted(() => nextTick(revealActive));

function onKeydown(e: KeyboardEvent) {
  const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const list = props.publishers;
  if (!list.length) return;
  e.preventDefault();
  const current = list.findIndex((p) => p.key === props.modelValue);
  let idx = current < 0 ? 0 : current;
  if (e.key === 'ArrowRight') idx = (idx + 1) % list.length;
  else if (e.key === 'ArrowLeft') idx = (idx - 1 + list.length) % list.length;
  else if (e.key === 'Home') idx = 0;
  else idx = list.length - 1;
  select(list[idx].key, true);
}
</script>

<template>
  <nav class="tabbar" aria-label="厂商筛选">
    <div
      ref="listEl"
      class="tablist"
      role="tablist"
      aria-label="游戏厂商"
      @keydown="onKeydown"
    >
      <button
        v-for="p in publishers"
        :key="p.key"
        :ref="(el) => setTabRef(p.key, el)"
        :id="`tab-${p.key}`"
        class="tab"
        role="tab"
        type="button"
        :aria-selected="p.key === modelValue"
        :aria-controls="p.key === modelValue ? `panel-${p.key}` : undefined"
        :tabindex="p.key === modelValue ? 0 : -1"
        @click="select(p.key)"
      >
        <span class="tab-dot" :style="{ background: p.color }" aria-hidden="true"></span>
        <span class="tab-name">{{ p.name }}</span>
        <span v-if="counts[p.key] != null" class="tab-count">{{ counts[p.key] }}</span>
      </button>
    </div>
  </nav>
</template>
