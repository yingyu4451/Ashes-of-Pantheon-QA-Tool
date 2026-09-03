<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Crosshair, Footprints, PackageOpen, Sparkles, Target } from '@lucide/vue'
import type { Component, CSSProperties } from 'vue'
import type { QaCard } from '@shared/contracts'

const props = defineProps<{ card: QaCard }>()

const tooltipVisible = ref(false)
const tooltipPosition = ref({ x: 0, y: 0 })
let hoverTimer: ReturnType<typeof setTimeout> | undefined

const categoryIcon: Record<QaCard['category'], Component> = {
  equipment: PackageOpen,
  placement: Crosshair,
  directional: Footprints,
  target: Target,
  effect: Sparkles
}

const categoryLabel: Record<QaCard['category'], string> = {
  equipment: '装备',
  placement: '放置',
  directional: '定向',
  target: '目标',
  effect: '效果'
}

const rarityLabel: Record<QaCard['rarity'], string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说'
}

const frameStyle = computed<CSSProperties>(() => {
  const variant = props.card.frameVariant ?? 0
  const x = variant % 2 === 0 ? '0%' : '100%'
  const y = variant < 2 ? '0%' : '100%'
  return {
    backgroundImage: 'url(/assets/card-frame.png)',
    backgroundPosition: `${x} ${y}`,
    backgroundSize: '200% 200%'
  }
})

const tooltipStyle = computed<CSSProperties>(() => ({
  left: `${Math.min(tooltipPosition.value.x + 16, window.innerWidth - 326)}px`,
  top: `${Math.min(tooltipPosition.value.y + 18, window.innerHeight - 190)}px`
}))

function beginHover(event: PointerEvent): void {
  tooltipPosition.value = { x: event.clientX, y: event.clientY }
  hoverTimer = setTimeout(() => {
    tooltipVisible.value = true
  }, 1000)
}

function updatePointer(event: PointerEvent): void {
  tooltipPosition.value = { x: event.clientX, y: event.clientY }
}

function endHover(): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = undefined
  tooltipVisible.value = false
}

function showKeyboardTooltip(event: FocusEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  tooltipPosition.value = { x: rect.right, y: rect.top + 20 }
  tooltipVisible.value = true
}

onBeforeUnmount(endHover)
</script>

<template>
  <article
    class="group min-w-0 content-virtualized"
    @pointerenter="beginHover"
    @pointermove="updatePointer"
    @pointerleave="endHover"
  >
    <button
      type="button"
      class="relative block aspect-[0.72] w-full min-w-0 overflow-hidden border border-black/70 bg-[#242126] text-left shadow-[0_10px_22px_rgb(0_0_0/0.25)] transition-transform duration-150 hover:-translate-y-0.5 focus-visible:-translate-y-0.5 cut-corner"
      :aria-label="`${card.name}，${rarityLabel[card.rarity]}，费用 ${card.cost}`"
      @focus="showKeyboardTooltip"
      @blur="endHover"
    >
      <span class="absolute inset-0 bg-no-repeat brightness-[0.68] contrast-[1.08]" :style="frameStyle" aria-hidden="true" />
      <span class="absolute inset-[11%_14%_16%] overflow-hidden bg-[#17161a] shadow-[inset_0_0_20px_rgb(0_0_0/0.65)]" aria-hidden="true">
        <img v-if="card.imageUrl" :src="card.imageUrl" alt="" width="320" height="320" loading="lazy" class="h-[58%] w-full object-cover opacity-75" />
      </span>
      <span class="absolute inset-[11%_14%_16%] flex flex-col bg-[#17161a]/55 p-3">
        <span class="flex items-start justify-between gap-2">
          <span class="grid h-8 w-8 place-items-center border border-[#c6a451]/42 bg-black/35 text-[#e1be59] cut-corner">
            <component :is="categoryIcon[card.category]" :size="16" aria-hidden="true" />
          </span>
          <span class="grid h-8 min-w-8 place-items-center rounded-full border border-[#d8b95f]/65 bg-[#2b2520] px-2 utility-font text-[13px] font-bold text-[#f2d77f]">
            {{ card.cost }}
          </span>
        </span>

        <span class="mt-auto">
          <span class="display-font block text-[19px] leading-tight text-[#f2eee6]">{{ card.name }}</span>
          <span class="mt-1 block truncate utility-font text-[9px] text-white/36">{{ card.typeId }}</span>
          <span class="mt-3 flex items-center justify-between border-t border-white/10 pt-2 text-[10px] text-white/48">
            <span>{{ categoryLabel[card.category] }}</span>
            <span>{{ rarityLabel[card.rarity] }}</span>
          </span>
        </span>
      </span>
      <span class="absolute inset-0 opacity-0 ring-1 ring-inset ring-[#d6b655] transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <div
        v-if="tooltipVisible"
        class="pointer-events-none fixed z-50 w-[300px] border border-[#c6a451]/55 bg-[#171318]/98 p-4 shadow-[0_16px_45px_rgb(0_0_0/0.55)] cut-corner"
        :style="tooltipStyle"
        role="tooltip"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="display-font m-0 text-[18px] text-[#f1e9dd]">{{ card.name }}</p>
            <p class="utility-font mt-1 break-all text-[10px] text-white/38" translate="no">{{ card.typeId }}</p>
          </div>
          <span class="utility-font text-[11px] text-[#e0bd59]">费用 {{ card.cost }}</span>
        </div>
        <div class="hairline my-3" />
        <p class="m-0 text-[13px] leading-6 text-white/72">{{ card.description }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <span v-for="tag in card.tags" :key="tag" class="border border-white/12 px-2 py-1 text-[10px] text-white/48">{{ tag }}</span>
        </div>
      </div>
    </Teleport>
  </article>
</template>
