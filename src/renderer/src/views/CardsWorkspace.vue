<script setup lang="ts">
import { ref } from 'vue'
import { ArrowDownAZ, ArrowUpAZ, MousePointer2, Search, X } from '@lucide/vue'
import CardTile from '@/components/CardTile.vue'
import { useQaStore } from '@/stores/qa'
import type { CardCategory, QaCard, Rarity } from '@shared/contracts'

const store = useQaStore()
const pendingCardTypeId = ref('')

async function obtainCard(card: QaCard): Promise<void> {
  if (card.category === 'equipment') {
    store.selectedEquipmentTypeId = card.typeId
    store.activeWorkspace = 'battle'
    store.showNotice(
      store.runtimeReady
        ? `已选择装备“${card.name}”，请在地图上选择格子后放置。`
        : `已选择装备“${card.name}”，进入战斗并加载地图后即可放置。`,
      'info'
    )
    return
  }
  pendingCardTypeId.value = card.typeId
  try {
    await store.addOwnedCard(card.typeId)
  } finally {
    pendingCardTypeId.value = ''
  }
}

async function removeCard(card: QaCard): Promise<void> {
  pendingCardTypeId.value = card.typeId
  try {
    await store.removeOwnedCard(card.typeId)
  } finally {
    pendingCardTypeId.value = ''
  }
}

const categories: Array<{ value: CardCategory; label: string }> = [
  { value: 'equipment', label: '装备' },
  { value: 'placement', label: '放置' },
  { value: 'directional', label: '定向' },
  { value: 'target', label: '目标' },
  { value: 'effect', label: '效果' }
]

const rarities: Array<{ value: Rarity; label: string }> = [
  { value: 'common', label: '普通' },
  { value: 'rare', label: '稀有' },
  { value: 'epic', label: '史诗' },
  { value: 'legendary', label: '传说' }
]
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-labelledby="cards-title">
    <div class="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-white/9 px-6 py-5">
      <div>
        <h1 id="cards-title" class="display-font m-0 text-[26px] text-[#eee7dc]">卡牌目录</h1>
      </div>

      <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-3 max-[640px]:w-full max-[640px]:flex-none">
        <label class="relative w-full max-w-[340px]">
          <span class="sr-only">搜索卡牌</span>
          <Search class="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-white/30" :size="15" aria-hidden="true" />
          <input v-model="store.cardSearch" class="input input-sm w-full pl-9 pr-3 text-[13px]" type="search" name="card-search" placeholder="名称、TypeId、标签…" autocomplete="off" />
        </label>

        <div class="flex shrink-0 items-center gap-2" role="group" aria-labelledby="card-sort-label">
          <span id="card-sort-label" class="text-[12px] font-semibold text-white/65">排序</span>
          <select v-model="store.sortKey" name="card-sort" class="select select-sm w-32 px-3 text-[12px]" aria-label="排序字段">
            <option value="typeId">按 TypeId</option>
            <option value="category">按类型</option>
            <option value="cost">按费用</option>
            <option value="rarity">按稀有度</option>
          </select>
          <button
            type="button"
            class="btn btn-neutral btn-square btn-sm"
            :title="store.sortDirection === 'asc' ? '切换为降序' : '切换为升序'"
            :aria-label="store.sortDirection === 'asc' ? '切换为降序' : '切换为升序'"
            @click="store.sortDirection = store.sortDirection === 'asc' ? 'desc' : 'asc'"
          >
            <ArrowDownAZ v-if="store.sortDirection === 'asc'" :size="16" aria-hidden="true" />
            <ArrowUpAZ v-else :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <div class="flex shrink-0 flex-wrap items-start gap-x-6 gap-y-3 border-b border-white/8 bg-[#171619] px-6 py-3" role="group" aria-labelledby="card-filter-label">
      <span id="card-filter-label" class="flex h-7 items-center text-[12px] font-semibold text-white/65">筛选</span>
      <fieldset class="flex flex-wrap items-center gap-2">
        <legend class="float-left mr-2 text-[11px] font-bold text-white/42">类型</legend>
        <label v-for="item in categories" :key="item.value" class="flex h-7 cursor-pointer items-center gap-1.5 border border-white/10 px-2 text-[11px] text-white/58 has-[:checked]:border-[#c6a451]/48 has-[:checked]:bg-[#c6a451]/9 has-[:checked]:text-[#edcf70]">
          <input v-model="store.selectedCategories" class="checkbox checkbox-xs checkbox-primary" type="checkbox" name="card-category" :value="item.value" />
          {{ item.label }}
        </label>
      </fieldset>

      <fieldset class="flex flex-wrap items-center gap-2">
        <legend class="float-left mr-2 text-[11px] font-bold text-white/42">持有状态</legend>
        <label class="flex h-7 items-center gap-1.5 border border-white/10 px-2 text-[11px] text-white/58 has-[:checked]:border-[#55a58d]/70 has-[:checked]:bg-[#55a58d]/12 has-[:checked]:text-[#8ed9c3] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40">
          <input v-model="store.selectedOwnedOnly" class="checkbox checkbox-xs checkbox-success" type="checkbox" name="card-owned" :disabled="!store.cardInventoryAvailable" />
          已持有
        </label>
      </fieldset>

      <fieldset class="flex flex-wrap items-center gap-2">
        <legend class="float-left mr-2 text-[11px] font-bold text-white/42">费用</legend>
        <label v-for="cost in [0, 1, 2, 3, 4, 5]" :key="cost" class="grid h-7 w-7 cursor-pointer place-items-center border border-white/10 text-[11px] text-white/58 has-[:checked]:border-[#c6a451]/48 has-[:checked]:bg-[#c6a451]/9 has-[:checked]:text-[#edcf70]">
          <input v-model="store.selectedCosts" class="sr-only" type="checkbox" name="card-cost" :value="cost" />
          {{ cost }}
        </label>
      </fieldset>

      <fieldset class="flex flex-wrap items-center gap-2">
        <legend class="float-left mr-2 text-[11px] font-bold text-white/42">稀有度</legend>
        <label v-for="item in rarities" :key="item.value" class="flex h-7 cursor-pointer items-center gap-1.5 border border-white/10 px-2 text-[11px] text-white/58 has-[:checked]:border-[#7167a8]/70 has-[:checked]:bg-[#7167a8]/14 has-[:checked]:text-[#c8c1ee]">
          <input v-model="store.selectedRarities" class="checkbox checkbox-xs checkbox-accent" type="checkbox" name="card-rarity" :value="item.value" />
          {{ item.label }}
        </label>
      </fieldset>

      <button v-if="store.activeFilterCount" type="button" class="ml-auto flex h-7 items-center gap-1.5 text-[11px] text-white/42 hover:text-white/72" @click="store.clearFilters">
        <X :size="13" aria-hidden="true" />
        清除 {{ store.activeFilterCount }} 项
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/45">
        <span>显示 {{ store.filteredCards.length }} / {{ store.catalog.cards.length }}</span>
        <span v-if="store.connectionStatus === 'connected' && store.cardInventoryAvailable" class="flex items-center gap-1.5 text-white/65" title="装备卡左键前往战斗放置，右键删除战场装备">
          <MousePointer2 :size="13" aria-hidden="true" />左键获取 · 右键删除
        </span>
        <span v-if="store.connectionStatus !== 'connected'">离线目录</span>
        <span v-else-if="!store.cardInventoryAvailable">当前场景没有可用的卡牌库存</span>
      </div>

      <div v-if="store.filteredCards.length" class="grid grid-cols-[repeat(auto-fill,minmax(166px,1fr))] gap-x-4 gap-y-5 pb-8">
        <CardTile
          v-for="card in store.filteredCards"
          :key="card.typeId"
          :card="card"
          :owned-count="store.ownedCardCounts[card.typeId] ?? 0"
          :inventory-available="store.connectionStatus === 'connected' && store.cardInventoryAvailable"
          :busy="pendingCardTypeId === card.typeId"
          @obtain="obtainCard(card)"
          @remove="removeCard(card)"
        />
      </div>
      <div v-else-if="store.catalog.cards.length === 0" class="grid h-56 place-items-center border border-dashed border-white/12 text-center">
        <div>
          <p class="m-0 text-sm text-white/58">尚未同步卡牌目录</p>
          <p class="m-0 mt-2 text-[11px] text-white/30">连接 Unity Editor 后读取当前项目的真实目录。</p>
          <button type="button" class="btn btn-primary btn-sm mt-4" @click="store.activeWorkspace = 'setup'">前往连接</button>
        </div>
      </div>
      <div v-else class="grid h-56 place-items-center border border-dashed border-white/12 text-center">
        <div>
          <p class="m-0 text-sm text-white/58">没有符合条件的卡牌</p>
          <button type="button" class="mt-3 text-xs text-[#d6b85f] hover:text-[#f0d77e]" @click="store.clearFilters">清除筛选</button>
        </div>
      </div>
    </div>
  </section>
</template>
