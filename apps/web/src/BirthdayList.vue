<script setup lang="ts">
import { computed } from 'vue';
import type { BirthdayItem } from './types';
import { relDay } from './lib/format';

const props = withDefaults(defineProps<{ birthdays?: BirthdayItem[] }>(), { birthdays: () => [] });

function isToday(b: BirthdayItem) {
  return b.state === 'today' || (b.days_until ?? null) === 0;
}

function stateOf(b: BirthdayItem) {
  if (b.state) return b.state;
  if (isToday(b)) return 'today';
  // data-core 的 state 字段未到达时的兜底：60 天以上视为「较远」，只显示日期
  if ((b.days_until ?? 0) > 60) return 'far';
  return 'upcoming';
}

/** today → 刚刚过去 → 即将到来 → 较远；同组内按 days_until 升序，保持数据层顺序 */
const RANK: Record<string, number> = { today: 0, recent: 1, upcoming: 2, far: 3 };

const sorted = computed(() =>
  props.birthdays
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      // 数据层已按「今天/未来 30 天 → 过去 30 天（最近发生优先）→ 其余」排好；
      // 这里只按状态分组做稳定排序，避免把「2 天前」排到「10 天前」后面。
      const rx = RANK[stateOf(x.b)] ?? 2;
      const ry = RANK[stateOf(y.b)] ?? 2;
      return rx - ry || x.i - y.i;
    })
    .map((x) => x.b),
);

/** 生日剩余 / 已过文案 */
function whenText(b: BirthdayItem) {
  const state = stateOf(b);
  if (state === 'today') return '今天';
  if (state === 'recent') {
    const d = b.days_since;
    if (d == null) return '刚过';
    if (d === 1) return '昨天';
    return `${d} 天前`;
  }
  if (state === 'far') return '';
  return relDay(b.days_until);
}
</script>

<template>
  <div v-if="sorted.length" class="block birthdays-block">
    <div class="section-title">
      角色生日
      <span class="section-count">{{ sorted.length }}</span>
    </div>
    <ul class="birthdays">
      <li
        v-for="b in sorted"
        :key="b.character + b.month_day"
        class="birthday"
        :class="{ 'is-today': isToday(b), 'is-recent': stateOf(b) === 'recent' }"
      >
        <span class="bd-name">{{ b.character }}</span>
        <span class="bd-date">{{ b.month_day }}</span>
        <span v-if="whenText(b)" class="bd-when">{{ whenText(b) }}</span>
        <a v-if="b.url" class="bd-link" :href="b.url" target="_blank" rel="noopener" title="官方生日贺图">贺图 ↗</a>
      </li>
    </ul>
  </div>
</template>
