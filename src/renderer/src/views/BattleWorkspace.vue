<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Box, Cable, Crosshair, PackageOpen, RefreshCw, Shield, Skull, UserRound } from '@lucide/vue'
import EntityInspector from '@/components/EntityInspector.vue'
import { useQaStore } from '@/stores/qa'
import type { GridPoint, QaEntity } from '@shared/contracts'

const store = useQaStore()
const placementMessage = ref('')
const placementBusy = ref(false)
const selectedEquipment = computed(() => store.catalog.equipment.find((item) => item.typeId === store.selectedEquipmentTypeId))
const gridViewport = ref<HTMLElement | null>(null)
const gridCellSize = ref(0)

const minX = computed(() => -Math.floor(store.battle.width / 2))
const maxY = computed(() => Math.floor((store.battle.height - 1) / 2))
const cells = computed<GridPoint[]>(() => {
  const result: GridPoint[] = []
  for (let row = 0; row < store.battle.height; row++) {
    for (let column = 0; column < store.battle.width; column++) {
      result.push({ x: minX.value + column, y: maxY.value - row })
    }
  }
  return result
})

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${store.battle.width}, ${gridCellSize.value}px)`,
  gridTemplateRows: `repeat(${store.battle.height}, ${gridCellSize.value}px)`,
  width: `${store.battle.width * gridCellSize.value}px`,
  height: `${store.battle.height * gridCellSize.value}px`
}))

function updateGridCellSize(): void {
  const viewport = gridViewport.value
  if (!viewport || store.battle.width <= 0 || store.battle.height <= 0) return
  const availableWidth = Math.max(0, viewport.clientWidth - 40 - 16)
  const availableHeight = Math.max(0, viewport.clientHeight - 40 - 16)
  gridCellSize.value = Math.max(32, Math.floor(Math.min(
    availableWidth / store.battle.width,
    availableHeight / store.battle.height,
    72
  )))
}

let gridResizeObserver: ResizeObserver | undefined

onMounted(() => {
  updateGridCellSize()
  if (!gridViewport.value) return
  gridResizeObserver = new ResizeObserver(updateGridCellSize)
  gridResizeObserver.observe(gridViewport.value)
})

onUnmounted(() => gridResizeObserver?.disconnect())

watch(() => [store.battle.width, store.battle.height], async () => {
  await nextTick()
  updateGridCellSize()
})

const allEntities = computed<QaEntity[]>(() => [
  {
    instanceId: store.battle.player.instanceId,
    typeId: 'MainCharacter',
    name: store.battle.player.name,
    kind: 'player',
    position: store.battle.player.position,
    currentHp: store.battle.player.currentHp,
    maxHp: store.battle.player.maxHp,
    buffs: store.battle.player.buffs
  },
  ...store.battle.entities
])

function entitiesAt(point: GridPoint): QaEntity[] {
  return allEntities.value.filter((entity) => entity.position.x === point.x && entity.position.y === point.y)
}

function selectEntity(entity: QaEntity): void {
  store.selectCell(entity.position)
  store.selectEntity(entity.instanceId)
}

async function placeEquipment(): Promise<void> {
  if (placementBusy.value || !selectedEquipment.value || !store.selectedCell) return
  placementBusy.value = true
  try {
    placementMessage.value = await store.placeEquipment() ? '装备已放置到选定格。' : (store.lastOperationMessage || '选定格不可放置装备。')
  } catch (error) {
    placementMessage.value = error instanceof Error ? error.message : '装备放置失败，请刷新后重试。'
  } finally { placementBusy.value = false }
}
</script>

<template>
  <section v-if="!store.runtimeReady" class="grid h-full place-items-center px-8 text-center" aria-labelledby="battle-empty-title">
    <div>
      <Cable :size="28" class="mx-auto text-[#c6a451]/65" aria-hidden="true" />
      <h1 id="battle-empty-title" class="display-font m-0 mt-4 text-[24px] text-[#eee7dc]">未连接战斗实例</h1>
      <p class="m-0 mt-2 text-[12px] text-white/38">连接 Unity Editor Play Mode 后载入战斗状态。</p>
      <button type="button" class="primary-button mt-5" @click="store.activeWorkspace = 'setup'">前往连接</button>
    </div>
  </section>

  <section v-else class="battle-workspace" aria-labelledby="battle-title">
    <h1 id="battle-title" class="sr-only">战斗工作台</h1>
    <aside class="flex min-h-0 min-w-0 flex-col border-r border-white/10 bg-[#171619]">
      <div class="shrink-0 border-b border-white/9 px-4 py-5">
        <p class="display-font m-0 text-[23px] text-[#eee7dc]" aria-hidden="true">战斗工作台</p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          v-for="entity in allEntities"
          :key="entity.instanceId"
          type="button"
          class="mb-1 flex h-[54px] w-full items-center gap-3 border border-transparent px-2 text-left hover:bg-white/4"
          :class="store.selectedEntityId === entity.instanceId ? 'border-[#c6a451]/28 bg-[#c6a451]/8' : ''"
          @click="selectEntity(entity)"
        >
          <span
            class="grid h-8 w-8 shrink-0 place-items-center border"
            :class="entity.kind === 'player' ? 'border-[#d6b85e]/55 bg-[#d6b85e]/10 text-[#f1d77e]' : entity.kind === 'enemy' ? 'border-[#c44536]/55 bg-[#c44536]/11 text-[#e86857]' : 'border-[#7167a8]/55 bg-[#7167a8]/12 text-[#b4aae4]'"
          >
            <UserRound v-if="entity.kind === 'player'" :size="15" aria-hidden="true" />
            <Skull v-else-if="entity.kind === 'enemy'" :size="15" aria-hidden="true" />
            <PackageOpen v-else :size="15" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12px] font-semibold text-white/72">{{ entity.name }}</span>
            <span class="mt-0.5 block utility-font text-[9px] text-white/28">{{ entity.position.x }}, {{ entity.position.y }}</span>
          </span>
          <span v-if="entity.currentHp !== undefined" class="utility-font text-[10px] text-white/40">{{ entity.currentHp }}/{{ entity.maxHp }}</span>
        </button>
      </div>

      <div class="shrink-0 border-t border-white/9 p-3">
        <label class="block text-[10px] text-white/38">
          放置装备
          <select v-model="store.selectedEquipmentTypeId" name="placement-equipment" aria-label="放置装备" class="field mt-1 w-full min-w-0 px-2 text-[11px]" :disabled="placementBusy || !store.catalog.equipment.length">
            <option v-if="!store.catalog.equipment.length" value="">没有可用装备</option>
            <option v-for="item in store.catalog.equipment" :key="item.typeId" :value="item.typeId">{{ item.name }} · {{ item.typeId }}</option>
          </select>
        </label>
        <div v-if="selectedEquipment" class="mt-2 min-w-0 text-[11px] text-white/65">
          <span class="block break-words">{{ selectedEquipment.name }}</span>
          <span class="utility-font mt-0.5 block break-all text-[10px] text-white/45" translate="no">{{ selectedEquipment.typeId }}</span>
        </div>
        <button type="button" class="primary-button mt-2 w-full" :disabled="placementBusy || !store.selectedCell || !selectedEquipment" @click="placeEquipment">
          <RefreshCw v-if="placementBusy" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
          <Box v-else :size="14" class="shrink-0" aria-hidden="true" />
          {{ placementBusy ? '放置中…' : `放置到 ${store.selectedCell ? `${store.selectedCell.x}, ${store.selectedCell.y}` : '未选格'}` }}
        </button>
        <p class="m-0 mt-2 min-h-4 text-center text-[10px] text-[#d7ba63]" aria-live="polite">{{ placementMessage }}</p>
      </div>
    </aside>

    <main class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#131215]">
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-white/8 px-4 text-[10px] text-white/36">
        <span class="utility-font">{{ store.battle.mapName }} · {{ store.battle.width }}×{{ store.battle.height }}</span>
        <span class="flex items-center gap-2"><Crosshair :size="13" aria-hidden="true" /> 选中格 {{ store.selectedCell ? `${store.selectedCell.x}, ${store.selectedCell.y}` : '—' }}</span>
      </div>

      <div ref="gridViewport" class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
        <div class="relative shrink-0 border border-[#c6a451]/28 bg-[#7b5e36] p-2 shadow-[0_24px_80px_rgb(0_0_0/0.38)] cut-corner">
          <div class="absolute inset-0 opacity-35 [background-image:radial-gradient(circle_at_30%_20%,#d4a95f_0,transparent_34%),linear-gradient(125deg,transparent_0_47%,rgb(40_24_24/.28)_48%_52%,transparent_53%)]" aria-hidden="true" />
          <div
            data-testid="battle-grid"
            class="relative grid border-l border-t border-[#2f2019]/55"
            :style="gridStyle"
          >
            <div
              v-for="cell in cells"
              :key="`${cell.x}:${cell.y}`"
              class="group relative min-h-0 border-b border-r border-[#2f2019]/55"
              :class="store.selectedCell?.x === cell.x && store.selectedCell?.y === cell.y ? 'bg-[#f0c85c]/16' : 'hover:bg-white/7'"
            >
              <button type="button" class="absolute inset-0 z-0" :aria-label="`选择格 ${cell.x}, ${cell.y}`" @click="store.selectCell(cell)" />
              <span class="pointer-events-none absolute bottom-1 right-1 utility-font text-[8px] text-[#3a281e]/60 group-hover:text-[#2b1c17]">{{ cell.x }},{{ cell.y }}</span>

              <span v-if="store.selectedCell?.x === cell.x && store.selectedCell?.y === cell.y" class="pointer-events-none absolute inset-1 z-10 border border-[#f3cd66] shadow-[0_0_14px_rgb(245_200_84/0.45)]" aria-hidden="true">
                <span class="absolute -left-1 -top-1 h-2 w-2 border-l-2 border-t-2 border-white" />
                <span class="absolute -right-1 -top-1 h-2 w-2 border-r-2 border-t-2 border-white" />
                <span class="absolute -bottom-1 -left-1 h-2 w-2 border-b-2 border-l-2 border-white" />
                <span class="absolute -bottom-1 -right-1 h-2 w-2 border-b-2 border-r-2 border-white" />
              </span>

              <div v-if="entitiesAt(cell).length" class="absolute inset-1 z-20 flex items-center justify-center gap-1">
                <button
                  v-for="entity in entitiesAt(cell)"
                  :key="entity.instanceId"
                  type="button"
                  class="relative grid h-[66%] max-h-11 min-h-7 aspect-square place-items-center border-2 shadow-[0_4px_12px_rgb(0_0_0/0.35)] transition-transform hover:scale-105"
                  :class="[
                    entity.kind === 'player' ? 'border-[#f0d26e] bg-[#3b3025] text-[#ffe28b]' : entity.kind === 'enemy' ? 'border-[#d64c3c] bg-[#462322] text-[#ff7867]' : 'border-[#8c7cc7] bg-[#2c293e] text-[#cabfff]',
                    store.selectedEntityId === entity.instanceId ? 'ring-2 ring-white/80 ring-offset-1 ring-offset-[#6b5032]' : ''
                  ]"
                  :aria-label="`选择 ${entity.name}`"
                  :title="entity.name"
                  @click="selectEntity(entity)"
                >
                  <UserRound v-if="entity.kind === 'player'" :size="18" aria-hidden="true" />
                  <Skull v-else-if="entity.kind === 'enemy'" :size="18" aria-hidden="true" />
                  <Shield v-else :size="17" aria-hidden="true" />
                  <span v-if="entity.currentHp !== undefined" class="absolute -bottom-2 rounded-full border border-black/65 bg-[#211719] px-1 utility-font text-[8px] leading-4 text-white">{{ entity.currentHp }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <EntityInspector />
  </section>
</template>

<style scoped>
.battle-workspace {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-columns: 210px minmax(0, 1fr) 340px;
}

@media (max-width: 1180px) {
  .battle-workspace { grid-template-columns: 190px minmax(0, 1fr) 320px; }
}

</style>
