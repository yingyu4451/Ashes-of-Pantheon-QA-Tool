<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Box, Cable, Crosshair, Move, PackageOpen, RefreshCw, Shield, Skull, UserRound, X } from '@lucide/vue'
import EntityInspector from '@/components/EntityInspector.vue'
import EquipmentPicker from '@/components/EquipmentPicker.vue'
import { useQaStore } from '@/stores/qa'
import type { GridPoint, QaEntity } from '@shared/contracts'

const store = useQaStore()
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
    moveTargetId: store.battle.player.moveTargetId,
    size: store.battle.player.size,
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
  if (moving.value?.phase === 'targeting') { void finishMove(entity.position); return }
  store.selectCell(entity.position)
  store.selectEntity(entity.instanceId)
}

function selectMapEntity(entity: QaEntity): void {
  if (suppressClick) { suppressClick = false; return }
  selectEntity(entity)
}

type MoveGesture = { entity: QaEntity; phase: 'holding' | 'dragging' | 'targeting'; pointerId: number; x: number; y: number; originX: number; originY: number; startedAt: number }
const moving = ref<MoveGesture | null>(null)
const holdProgress = ref(0)
const dropCell = ref<GridPoint | null>(null)
const windowWidth = ref(window.innerWidth)
const windowHeight = ref(window.innerHeight)
function resizeWindow(): void { windowWidth.value = window.innerWidth; windowHeight.value = window.innerHeight; cancelMove() }
let animationFrame = 0
let captured: HTMLElement | null = null
let suppressClick = false
const movementAllowed = computed(() => store.runtimeReady && store.connectionStatus === 'connected' && store.battle.movement?.allowed && !store.movingTargetId)
const movementReason = computed(() => store.movingTargetId ? '正在同步游戏位置…' : store.battle.movement?.reason || '请更新 Bridge 并刷新战斗数据。')

function validDrop(point: GridPoint | null): boolean {
  const entity = moving.value?.entity
  if (!point || !entity) return false
  const size = entity.size ?? { x: 1, y: 1 }
  const minY = -Math.floor(store.battle.height / 2)
  if (point.x < minX.value || point.y < minY || point.x + size.x > minX.value + store.battle.width || point.y + size.y > minY + store.battle.height) return false
  return !allEntities.value.some((other) => {
    if (other.moveTargetId === entity.moveTargetId) return false
    const otherSize = other.size ?? { x: 1, y: 1 }
    return point.x < other.position.x + otherSize.x && point.x + size.x > other.position.x
      && point.y < other.position.y + otherSize.y && point.y + size.y > other.position.y
  })
}

function locateCell(x: number, y: number): GridPoint | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-battle-cell]')
  return element ? { x: Number(element.dataset.x), y: Number(element.dataset.y) } : null
}

function cancelMove(): void {
  cancelAnimationFrame(animationFrame)
  const pointerId = moving.value?.pointerId
  if (moving.value && moving.value.phase !== 'holding') suppressClick = true
  moving.value = null
  dropCell.value = null
  holdProgress.value = 0
  if (pointerId !== undefined && captured?.hasPointerCapture(pointerId)) captured.releasePointerCapture(pointerId)
  captured = null
}

function updateHold(now: number): void {
  const gesture = moving.value
  if (!gesture || gesture.phase !== 'holding') return
  holdProgress.value = Math.min(100, Math.floor((now - gesture.startedAt) / 600 * 100))
  if (holdProgress.value >= 100) {
    gesture.phase = 'dragging'
    dropCell.value = { ...gesture.entity.position }
    suppressClick = true
  } else animationFrame = requestAnimationFrame(updateHold)
}

function startHold(event: PointerEvent, entity: QaEntity): void {
  suppressClick = false
  if (event.button !== 0 || !event.isPrimary || moving.value || !movementAllowed.value || !entity.moveTargetId) return
  const frozen = { ...entity, position: { ...entity.position }, size: entity.size ? { ...entity.size } : undefined }
  moving.value = { entity: frozen, phase: 'holding', pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, startedAt: performance.now() }
  captured = event.currentTarget as HTMLElement
  captured.setPointerCapture(event.pointerId)
  store.selectEntity(entity.instanceId)
  store.selectCell(entity.position)
  animationFrame = requestAnimationFrame(updateHold)
}

function movePointer(event: PointerEvent): void {
  const gesture = moving.value
  if (!gesture || gesture.pointerId !== event.pointerId) return
  if (gesture.phase === 'holding' && Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY) > 6) { cancelMove(); return }
  if (gesture.phase !== 'dragging') return
  gesture.x = event.clientX
  gesture.y = event.clientY
  dropCell.value = locateCell(event.clientX, event.clientY)
}

async function finishMove(point: GridPoint | null): Promise<void> {
  const gesture = moving.value
  if (!gesture) return
  const target = point ? { ...point } : null
  const valid = validDrop(target)
  cancelMove()
  if (!valid || !target) { store.showNotice('已取消移动：请选择地图内的空格。', 'info'); return }
  if (target.x === gesture.entity.position.x && target.y === gesture.entity.position.y) return
  await store.moveEntity(gesture.entity, target)
}

function releasePointer(event: PointerEvent): void {
  if (moving.value?.pointerId !== event.pointerId) return
  if (moving.value.phase === 'dragging') void finishMove(locateCell(event.clientX, event.clientY))
  else cancelMove()
}

function chooseCell(point: GridPoint): void {
  if (moving.value?.phase === 'targeting') void finishMove(point)
  else store.selectCell(point)
}

function targetSelected(): void {
  const entity = store.selectedEntity
  if (!entity?.moveTargetId || !movementAllowed.value) return
  moving.value = { entity: { ...entity, position: { ...entity.position } }, phase: 'targeting', pointerId: -1, x: 0, y: 0, originX: 0, originY: 0, startedAt: 0 }
  dropCell.value = { ...entity.position }
}

function movementKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { cancelMove(); return }
  if (moving.value?.phase !== 'targeting' || !dropCell.value) return
  if (event.key === 'Enter') { event.preventDefault(); void finishMove(dropCell.value); return }
  const offset: Record<string, GridPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: 1 }, ArrowDown: { x: 0, y: -1 } }
  const delta = offset[event.key]
  if (delta) { event.preventDefault(); dropCell.value = { x: dropCell.value.x + delta.x, y: dropCell.value.y + delta.y } }
}

watch([allEntities, movementAllowed, () => store.connectedInstanceId], () => {
  if (!moving.value) return
  const current = allEntities.value.find((item) => item.moveTargetId === moving.value!.entity.moveTargetId)
  if (!movementAllowed.value || !current || current.position.x !== moving.value.entity.position.x || current.position.y !== moving.value.entity.position.y) cancelMove()
})
onMounted(() => { window.addEventListener('blur', cancelMove); window.addEventListener('keydown', movementKey); window.addEventListener('resize', resizeWindow) })
onUnmounted(() => { cancelMove(); window.removeEventListener('blur', cancelMove); window.removeEventListener('keydown', movementKey); window.removeEventListener('resize', resizeWindow) })

async function placeEquipment(): Promise<void> {
  if (placementBusy.value || !selectedEquipment.value || !store.selectedCell) return
  placementBusy.value = true
  try {
    await store.placeEquipment()
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '装备放置失败，请刷新后重试。', 'error')
  } finally { placementBusy.value = false }
}
</script>

<template>
  <section v-if="!store.runtimeReady" class="grid h-full place-items-center px-8 text-center" aria-labelledby="battle-empty-title">
    <div>
      <Cable :size="28" class="mx-auto text-[#c6a451]/65" aria-hidden="true" />
      <h1 id="battle-empty-title" class="display-font m-0 mt-4 text-[24px] text-[#eee7dc]">未连接战斗实例</h1>
      <p class="m-0 mt-2 text-[12px] text-white/38">连接 Unity Editor Play Mode 后载入战斗状态。</p>
      <button type="button" class="btn btn-primary btn-sm mt-5" @click="store.activeWorkspace = 'setup'">前往连接</button>
    </div>
  </section>

  <section v-else class="battle-workspace" :class="moving ? 'select-none' : ''" aria-labelledby="battle-title">
    <h1 id="battle-title" class="sr-only">战斗工作台</h1>
    <aside class="flex min-h-0 min-w-0 flex-col border-r border-white/10 bg-[#171619]" aria-label="场上对象">
      <div class="shrink-0 border-b border-white/9 px-4 py-5">
        <p class="display-font m-0 text-[23px] text-[#eee7dc]" aria-hidden="true">战斗工作台</p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          v-for="entity in allEntities"
          :key="entity.instanceId"
          type="button"
          class="mb-1 flex min-h-[64px] w-full items-center gap-2 border border-transparent px-2 py-2 text-left hover:bg-white/4"
          :class="store.selectedEntityId === entity.instanceId ? 'border-[#c6a451]/28 bg-[#c6a451]/8' : ''"
          :aria-label="`${entity.name} ${entity.typeId}，位置 ${entity.position.x}, ${entity.position.y}`"
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
            <span v-if="entity.kind === 'equipment'" class="utility-font mt-0.5 block truncate text-[9px] text-white/45" :title="entity.typeId" translate="no">{{ entity.typeId }}</span>
            <span class="mt-0.5 block utility-font text-[9px] text-white/28">{{ entity.position.x }}, {{ entity.position.y }}</span>
          </span>
          <span v-if="entity.currentHp !== undefined" class="utility-font text-[10px] text-white/40">{{ entity.currentHp }}/{{ entity.maxHp }}</span>
        </button>
      </div>

      <div class="shrink-0 border-t border-white/9 p-3">
        <p class="m-0 mb-1 text-[10px] text-white/45">放置装备</p>
        <EquipmentPicker v-model="store.selectedEquipmentTypeId" :options="store.catalog.equipment" :disabled="placementBusy" />
        <div v-if="selectedEquipment" class="mt-2 min-w-0 text-[11px] text-white/65">
          <span class="block break-words">{{ selectedEquipment.name }}</span>
          <span class="utility-font mt-0.5 block break-all text-[10px] text-white/45" translate="no">{{ selectedEquipment.typeId }}</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm mt-2 w-full" title="将选中装备放置到选中格" :disabled="placementBusy || !store.selectedCell || !selectedEquipment" @click="placeEquipment">
          <RefreshCw v-if="placementBusy" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
          <Box v-else :size="14" class="shrink-0" aria-hidden="true" />
          {{ placementBusy ? '放置中…' : `放置到 ${store.selectedCell ? `${store.selectedCell.x}, ${store.selectedCell.y}` : '未选格'}` }}
        </button>
      </div>
    </aside>

    <section class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#131215]" aria-labelledby="battle-map-title">
      <div class="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/8 px-4 py-2 text-[10px] text-white/50">
        <div class="min-w-0">
          <h2 id="battle-map-title" class="m-0 text-[14px] font-bold text-white/80">战斗地图</h2>
          <p class="utility-font m-0 mt-1 truncate">{{ store.battle.mapName }} · {{ store.battle.width }}×{{ store.battle.height }}</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="flex items-center gap-2"><Crosshair :size="13" aria-hidden="true" /> 选中格 {{ store.selectedCell ? `${store.selectedCell.x}, ${store.selectedCell.y}` : '—' }}</span>
          <button v-if="moving?.phase === 'targeting'" type="button" class="btn btn-ghost btn-square btn-sm" aria-label="取消移动" title="取消移动" @click="cancelMove"><X :size="16" aria-hidden="true" /></button>
          <button v-else type="button" class="btn btn-ghost btn-square btn-sm" :disabled="!movementAllowed || !store.selectedEntity?.moveTargetId || Boolean(moving)" aria-label="移动所选对象" :title="movementAllowed ? '移动所选对象' : movementReason" @click="targetSelected"><Move :size="16" aria-hidden="true" /></button>
        </div>
      </div>
      <div v-if="store.movingTargetId || moving?.phase === 'targeting'" class="shrink-0 border-b border-white/10 px-4 py-2 text-[11px] text-secondary" role="status" aria-live="polite">{{ store.movingTargetId ? '正在同步游戏位置…' : `${moving?.entity.name} → ${dropCell?.x}, ${dropCell?.y}` }}</div>

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
              data-battle-cell
              :data-x="cell.x"
              :data-y="cell.y"
              class="group relative min-h-0 border-b border-r border-[#2f2019]/55"
              :class="store.selectedCell?.x === cell.x && store.selectedCell?.y === cell.y ? 'bg-[#f0c85c]/16' : 'hover:bg-white/7'"
            >
              <button type="button" class="absolute inset-0 z-0" :aria-label="`选择格 ${cell.x}, ${cell.y}`" @click="chooseCell(cell)" />
              <span v-if="moving?.phase !== 'holding' && dropCell?.x === cell.x && dropCell?.y === cell.y" class="pointer-events-none absolute inset-0 z-30 border-2" :class="validDrop(cell) ? 'border-success bg-success/20' : 'border-error bg-error/25'" aria-hidden="true" />
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
                  class="relative grid h-[66%] max-h-11 min-h-7 aspect-square touch-none select-none place-items-center border-2 shadow-[0_4px_12px_rgb(0_0_0/0.35)] transition-transform hover:scale-105"
                  :class="[
                    entity.kind === 'player' ? 'border-[#f0d26e] bg-[#3b3025] text-[#ffe28b]' : entity.kind === 'enemy' ? 'border-[#d64c3c] bg-[#462322] text-[#ff7867]' : 'border-[#8c7cc7] bg-[#2c293e] text-[#cabfff]',
                    store.selectedEntityId === entity.instanceId ? 'ring-2 ring-white/80 ring-offset-1 ring-offset-[#6b5032]' : '',
                    moving?.entity.moveTargetId === entity.moveTargetId && moving?.phase === 'dragging' ? 'opacity-40' : '',
                    movementAllowed && entity.moveTargetId ? 'cursor-grab' : ''
                  ]"
                  :aria-label="`选择 ${entity.name}`"
                  :title="movementAllowed && entity.moveTargetId ? `${entity.name} · 长按拖动` : entity.name"
                  :data-grid-position="`${entity.position.x},${entity.position.y}`"
                  @pointerdown="startHold($event, entity)"
                  @pointermove="movePointer"
                  @pointerup="releasePointer"
                  @pointercancel="cancelMove"
                  @lostpointercapture="cancelMove"
                  @contextmenu.prevent="cancelMove"
                  @click="selectMapEntity(entity)"
                >
                  <UserRound v-if="entity.kind === 'player'" :size="18" aria-hidden="true" />
                  <Skull v-else-if="entity.kind === 'enemy'" :size="18" aria-hidden="true" />
                  <Shield v-else :size="17" aria-hidden="true" />
                  <span v-if="moving?.phase === 'holding' && moving.entity.moveTargetId === entity.moveTargetId" class="pointer-events-none absolute -top-7 left-1/2 z-40 h-5 w-14 -translate-x-1/2 overflow-hidden rounded-sm border border-secondary bg-base-200" role="progressbar" aria-label="长按移动进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="holdProgress">
                    <span class="absolute bottom-0 left-0 h-1 w-full origin-left bg-secondary" :style="{ transform: `scaleX(${holdProgress / 100})` }" />
                    <span class="utility-font relative block text-center text-[10px] leading-4 text-secondary">{{ holdProgress }}%</span>
                  </span>
                  <span v-if="entity.currentHp !== undefined" class="absolute -bottom-2 rounded-full border border-black/65 bg-[#211719] px-1 utility-font text-[8px] leading-4 text-white">{{ entity.currentHp }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <EntityInspector />
    <Teleport to="body">
      <div v-if="moving?.phase === 'dragging'" data-testid="move-preview" class="pointer-events-none fixed left-0 top-0 z-[80] flex max-w-60 items-center gap-2 rounded border bg-base-200/95 px-3 py-2 shadow-xl" :class="validDrop(dropCell) ? 'border-success text-success' : 'border-error text-error'" :style="{ transform: `translate(${Math.max(8, Math.min(moving.x + 14, windowWidth - 248))}px, ${Math.max(8, Math.min(moving.y + 14, windowHeight - 48))}px)` }" aria-hidden="true">
        <Move :size="18" /><span class="max-w-48 truncate text-[12px]">{{ moving.entity.name }}</span><span class="utility-font text-[11px]">{{ dropCell ? `${dropCell.x}, ${dropCell.y}` : '不可放置' }}</span>
      </div>
    </Teleport>
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
