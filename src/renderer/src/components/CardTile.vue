<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { Crosshair, Footprints, PackageOpen, Sparkles, Target } from '@lucide/vue'
import type { Component, CSSProperties } from 'vue'
import type { QaCard } from '@shared/contracts'

const props = defineProps<{
  card: QaCard
  ownedCount: number
  inventoryAvailable: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ obtain: []; remove: [] }>()

const tooltipVisible = ref(false)
const tooltipId = useId()
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

const tooltipStyle = computed<CSSProperties>(() => {
  const top = Math.max(8, Math.min(tooltipPosition.value.y + 18, window.innerHeight - 280))
  return {
    left: `${Math.max(8, Math.min(tooltipPosition.value.x + 16, window.innerWidth - 308))}px`,
    top: `${top}px`,
    maxHeight: `${window.innerHeight - top - 8}px`
  }
})

const interactionLabel = computed(() => props.card.category === 'equipment'
  ? '左键前往战斗放置，右键删除战场装备'
  : '左键获得 1 张，右键删除 1 张')

const cardLabel = computed(() => [
  props.card.name,
  rarityLabel[props.card.rarity],
  `费用 ${props.card.cost}`,
  props.inventoryAvailable ? `拥有 ${props.ownedCount} 张` : '持有数量不可用',
  interactionLabel.value
].join('，'))

function obtainCard(): void {
  if (!props.inventoryAvailable || props.busy) return
  emit('obtain')
}

function removeCard(): void {
  if (!props.inventoryAvailable || props.busy) return
  emit('remove')
}

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
      :class="[
        !inventoryAvailable || busy ? 'cursor-default' : 'cursor-pointer active:scale-[0.99]',
        inventoryAvailable && card.category === 'equipment' ? 'hover:shadow-[0_10px_26px_rgb(198_164_81/0.16)]' : ''
      ]"
      :aria-label="cardLabel"
      :aria-describedby="tooltipVisible ? tooltipId : undefined"
      :aria-disabled="!inventoryAvailable || busy"
      @focus="showKeyboardTooltip"
      @blur="endHover"
      @click="obtainCard"
      @contextmenu.prevent="removeCard"
      @keydown.delete.prevent="removeCard"
      @keydown.esc="endHover"
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
          <span data-testid="card-cost" class="grid h-8 min-w-8 shrink-0 place-items-center rounded-full border border-[#d8b95f]/65 bg-[#2b2520] px-2 utility-font text-[13px] font-bold text-[#f2d77f]" :title="`费用 ${card.cost}`">
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
      <span
        v-if="inventoryAvailable && ownedCount > 0"
        data-testid="card-owned-count"
        class="absolute left-3 top-2 z-20 flex h-6 max-w-[45%] items-center gap-1 rounded-sm border border-[#64cbb4]/80 bg-[#173c35] px-1.5 text-[10px] font-bold text-[#a1f0dc] shadow-[0_3px_12px_rgb(0_0_0/0.65)]"
        :title="`持有 ${ownedCount} 张`"
        aria-hidden="true"
      >
        <span class="shrink-0">持有</span><span class="utility-font min-w-0 truncate">×{{ ownedCount }}</span>
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="tooltipVisible"
        class="pointer-events-none fixed z-50 w-[300px] max-w-[calc(100vw-16px)] overflow-y-auto border border-[#c6a451]/55 bg-[#171318]/98 p-4 shadow-[0_16px_45px_rgb(0_0_0/0.55)] cut-corner"
        :style="tooltipStyle"
        role="tooltip"
        :id="tooltipId"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="display-font m-0 break-words text-[18px] text-[#f1e9dd]">{{ card.name }}</p>
            <p class="utility-font mt-1 break-all text-[10px] text-white/38" translate="no">{{ card.typeId }}</p>
          </div>
          <span class="utility-font shrink-0 text-[11px] text-[#e0bd59]">费用 {{ card.cost }}</span>
        </div>
        <div class="hairline my-3" />
        <p class="m-0 text-[13px] leading-6 text-white/72">{{ card.description }}</p>
        <p class="m-0 mt-3 border-t border-white/10 pt-3 text-[11px] leading-5 text-[#a1f0dc]">{{ inventoryAvailable ? interactionLabel : '当前无法增删卡牌' }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <span v-for="tag in card.tags" :key="tag" class="border border-white/12 px-2 py-1 text-[10px] text-white/48">{{ tag }}</span>
        </div>
      </div>
    </Teleport>
  </article>
</template>
