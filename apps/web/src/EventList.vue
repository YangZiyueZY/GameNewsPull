<script setup lang="ts">
import { computed } from 'vue';
import type { EventItem } from './types';
import { fmtDay, remainText } from './lib/format';

const props = withDefaults(defineProps<{
  events?: EventItem[];
  stage?: 'live' | 'prelaunch';
}>(), { events: () => [], stage: 'live' });

const ORDER: Record<string, number> = { 进行中: 0, 即将开始: 1, 时间待定: 2, 已结束: 3 };

const title = computed(() => (props.stage === 'prelaunch' ? '预热进度' : '当前活动'));

const sorted = computed(() =>
  [...props.events].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)),
);

function statusClass(status?: string) {
  if (status === '进行中') return 'is-active';
  if (status === '即将开始') return 'is-soon';
  if (status === '已结束') return 'is-ended';
  return 'is-tbd';
}

function rightText(ev: EventItem) {
  if (ev.status === '进行中') return remainText(ev.days_remaining);
  if (ev.status === '即将开始') return ev.start_at ? `${fmtDay(ev.start_at)} 开始` : '即将开始';
  if (ev.status === '已结束') return '已结束';
  return '时间待公布';
}
</script>

<template>
  <div v-if="sorted.length" class="block events-block">
    <div class="section-title">
      {{ title }}
      <span class="section-count">{{ sorted.length }}</span>
    </div>
    <ul class="events">
      <li v-for="ev in sorted" :key="ev.id" class="event" :class="statusClass(ev.status)">
        <div class="event-row">
          <span class="event-status">{{ ev.status }}</span>
          <component
            :is="ev.url ? 'a' : 'span'"
            class="event-title"
            :href="ev.url || undefined"
            :target="ev.url ? '_blank' : undefined"
            :rel="ev.url ? 'noopener' : undefined"
          >{{ ev.title }}</component>
          <span class="event-right">{{ rightText(ev) }}</span>
        </div>
        <div v-if="ev.note" class="event-note">{{ ev.note }}</div>
      </li>
    </ul>
  </div>
</template>
