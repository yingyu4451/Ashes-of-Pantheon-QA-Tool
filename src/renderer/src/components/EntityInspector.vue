<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from '@lucide/vue'
import { useQaStore } from '@/stores/qa'
import type { QaBuff, QaEntity, QaIntentStep } from '@shared/contracts'

const store = useQaStore()
const activeTab = ref<'properties' | 'blessings' | 'buffs' | 'intents'>('properties')
const newBuffStacks = ref(1)
const newBuffDuration = ref(1)
const blessingBusy = ref(false)
const propertiesBusy = ref(false)

const entity = computed(() => store.selectedEntity)
const enemy = computed<QaEntity | null>(() => {
  if (entity.value?.kind !== 'enemy') return null
  return store.battle.entities.find((item) => item.instanceId === entity.value?.instanceId) ?? null
})
const tabs = computed<Array<{ id: typeof activeTab.value; label: string }>>(() => [
  { id: 'properties', label: '属性' },
  ...(entity.value?.kind === 'player' ? [{ id: 'blessings' as const, label: '祝福' }] : []),
  { id: 'buffs', label: 'BUFF' },
  ...(enemy.value ? [{ id: 'intents' as const, label: '意图' }] : [])
])
const selectedBlessing = computed(() => store.catalog.blessings.find((item) => item.typeId === store.selectedBlessingTypeId))
const canAddBlessing = computed(() => !blessingBusy.value && Boolean(selectedBlessing.value)
  && !store.battle.player.blessings.some((item) => item.typeId === store.selectedBlessingTypeId))

function navigateTabs(event: KeyboardEvent): void {
  const index = tabs.value.findIndex((tab) => tab.id === activeTab.value)
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.value.length
    : event.key === 'ArrowLeft' ? (index + tabs.value.length - 1) % tabs.value.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : -1
  if (next < 0) return
  event.preventDefault()
  activeTab.value = tabs.value[next]!.id
  ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

async function addBlessing(): Promise<void> {
  if (!canAddBlessing.value || !selectedBlessing.value) return
  blessingBusy.value = true
  try {
    if (store.connectionStatus === 'connected') await store.addBlessing(selectedBlessing.value.typeId)
    else if (store.connectionStatus === 'demo') store.battle.player.blessings.push({ ...selectedBlessing.value })
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '祝福添加失败，请刷新后重试。', 'error')
  } finally { blessingBusy.value = false }
}

async function removeBlessing(typeId: string): Promise<void> {
  if (blessingBusy.value || !window.confirm('从当前会话移除这个祝福？')) return
  blessingBusy.value = true
  try {
    if (store.connectionStatus === 'connected') await store.removeBlessing(typeId)
    else if (store.connectionStatus === 'demo') store.battle.player.blessings = store.battle.player.blessings.filter((item) => item.typeId !== typeId)
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '祝福移除失败，请刷新后重试。', 'error')
  } finally { blessingBusy.value = false }
}

const targetBuffs = computed<QaBuff[]>(() => {
  if (entity.value?.kind === 'player') return store.battle.player.buffs
  return enemy.value?.buffs ?? []
})

watch(entity, () => {
  if (!tabs.value.some((tab) => tab.id === activeTab.value)) activeTab.value = 'properties'
})

function commitHealth(): void {
  const target = entity.value?.kind === 'player' ? store.battle.player : enemy.value
  if (!target || target.currentHp === undefined || target.maxHp === undefined) return
  if (!store.unsafeValues) {
    target.maxHp = Math.max(1, target.maxHp)
    target.currentHp = Math.min(Math.max(0, target.currentHp), target.maxHp)
  }
}

async function addBuff(): Promise<void> {
  const definition = store.catalog.buffs.find((item) => item.typeId === store.selectedBuffTypeId)
  const target = entity.value
  if (!definition || !target || target.kind === 'equipment') return
  if (store.connectionStatus === 'connected') {
    await store.addBuff(target.instanceId, definition.typeId, newBuffStacks.value, newBuffDuration.value)
    return
  }
  targetBuffs.value.push({
    instanceId: `buff-${Date.now()}`,
    typeId: definition.typeId,
    name: definition.name,
    stacks: definition.supportsStacks ? Math.max(1, newBuffStacks.value) : 1,
    remainingTurns: definition.supportsDuration ? Math.max(1, newBuffDuration.value) : undefined,
    description: '由 QA 工具添加的运行时状态。'
  })
}

async function removeBuff(instanceId: string): Promise<void> {
  if (!window.confirm('从当前对象移除这个 BUFF？')) return
  if (store.connectionStatus === 'connected' && entity.value) {
    await store.removeBuff(entity.value.instanceId, instanceId)
    return
  }
  const index = targetBuffs.value.findIndex((item) => item.instanceId === instanceId)
  if (index >= 0) targetBuffs.value.splice(index, 1)
}

function moveIntent(index: number, direction: -1 | 1): void {
  if (!enemy.value?.intents) return
  const destination = index + direction
  if (destination < 0 || destination >= enemy.value.intents.length) return
  const [item] = enemy.value.intents.splice(index, 1)
  if (item) enemy.value.intents.splice(destination, 0, item)
}

function addIntent(): void {
  const definition = store.catalog.intents.find((item) => item.typeId === store.selectedIntentTypeId)
  if (!definition || !enemy.value) return
  const parameters = Object.fromEntries(definition.parameters.map((parameter) => [parameter, 1]))
  const intent: QaIntentStep = {
    instanceId: `intent-${Date.now()}`,
    typeId: definition.typeId,
    name: definition.name,
    summary: '使用默认参数',
    parameters
  }
  enemy.value.intents ??= []
  enemy.value.intents.push(intent)
}

function removeIntent(index: number): void {
  if (!window.confirm('从行动序列删除这个意图？')) return
  enemy.value?.intents?.splice(index, 1)
}

function clearIntents(): void {
  if (!enemy.value?.intents?.length || !window.confirm('清空当前怪物的全部行动意图？')) return
  enemy.value.intents = []
}

async function applyProperties(): Promise<void> {
  if (propertiesBusy.value) return
  propertiesBusy.value = true
  try {
    commitHealth()
    if (entity.value?.kind === 'player') {
      if (!store.unsafeValues) {
        store.battle.player.maxCost = Math.max(0, store.battle.player.maxCost)
        store.battle.player.currentCost = Math.min(Math.max(0, store.battle.player.currentCost), store.battle.player.maxCost)
      }
      await store.applyPlayer()
    } else if (enemy.value) await store.applyEnemy(enemy.value)
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '属性修改失败，请刷新后重试。', 'error')
  } finally { propertiesBusy.value = false }
}

async function applyIntentSequence(): Promise<void> {
  if (enemy.value) await store.applyIntents(enemy.value)
}
</script>

<template>
  <aside class="flex h-full min-h-0 min-w-0 flex-col border-l border-white/10 bg-[#19181b]" aria-label="对象检查器">
    <template v-if="entity">
      <div class="shrink-0 border-b border-white/9 px-4 pb-4 pt-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="utility-font m-0 truncate text-[10px] text-[#c6a451]/60">{{ entity.typeId }}</p>
            <h2 class="display-font m-0 mt-1 truncate text-[21px] text-[#eee7dc]">{{ entity.name }}</h2>
          </div>
          <span class="border border-white/12 px-2 py-1 text-[10px] text-white/45">
            {{ entity.position.x }}, {{ entity.position.y }}
          </span>
        </div>
      </div>

      <div class="tabs grid shrink-0 auto-cols-fr grid-flow-col border-b border-white/9" role="tablist" aria-label="对象详情">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :id="`entity-${tab.id}-tab`"
          :aria-controls="`entity-${tab.id}-panel`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          class="tab h-10 border-b-2 text-[12px] hover:bg-white/3"
          :class="activeTab === tab.id ? 'tab-active border-[#c44536] bg-white/3 text-white/82' : 'border-transparent text-white/42 hover:text-white/65'"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
          @keydown="navigateTabs"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel" :id="`entity-${activeTab}-panel`" :aria-labelledby="`entity-${activeTab}-tab`">
        <div v-if="activeTab === 'properties'" class="space-y-5">
          <template v-if="entity.kind === 'player'">
            <div class="grid grid-cols-2 gap-3">
              <label class="text-[11px] text-white/43">
                当前生命
                <input v-model.number="store.battle.player.currentHp" type="number" name="player-current-hp" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" @blur="commitHealth" />
              </label>
              <label class="text-[11px] text-white/43">
                最大生命
                <input v-model.number="store.battle.player.maxHp" type="number" name="player-max-hp" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" @blur="commitHealth" />
              </label>
              <label class="text-[11px] text-white/43">
                当前费用
                <input v-model.number="store.battle.player.currentCost" type="number" name="player-current-cost" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" />
              </label>
              <label class="text-[11px] text-white/43">
                最大费用
                <input v-model.number="store.battle.player.maxCost" type="number" name="player-max-cost" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" />
              </label>
            </div>
          </template>

          <template v-else-if="enemy">
            <div class="grid grid-cols-2 gap-3">
              <label class="text-[11px] text-white/43">
                当前生命
                <input v-model.number="enemy.currentHp" type="number" name="enemy-current-hp" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" @blur="commitHealth" />
              </label>
              <label class="text-[11px] text-white/43">
                最大生命
                <input v-model.number="enemy.maxHp" type="number" name="enemy-max-hp" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" @blur="commitHealth" />
              </label>
            </div>
            <label class="block text-[11px] text-white/43">
              攻击力
              <input v-model.number="enemy.attack" type="number" name="enemy-attack" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[13px]" />
            </label>
          </template>

          <template v-else>
            <dl class="m-0 space-y-3 text-[12px]">
              <div class="flex justify-between gap-4 border-b border-white/8 pb-3">
                <dt class="text-white/38">实例</dt>
                <dd class="m-0 truncate utility-font text-white/65">{{ entity.instanceId }}</dd>
              </div>
              <div class="flex justify-between gap-4 border-b border-white/8 pb-3">
                <dt class="text-white/38">格位</dt>
                <dd class="m-0 utility-font text-white/65">{{ entity.position.x }}, {{ entity.position.y }}</dd>
              </div>
            </dl>
          </template>

          <label v-if="entity.kind !== 'equipment'" class="flex items-start gap-3 border-t border-white/9 pt-4 text-[11px] text-white/50">
            <input v-model="store.unsafeValues" type="checkbox" name="entity-unsafe-values" class="checkbox checkbox-xs checkbox-primary mt-0.5" />
            <span>
              允许异常值
              <small class="mt-1 block leading-5 text-white/30">关闭时，生命值保持在 0 到最大值之间。</small>
            </span>
          </label>

          <button v-if="entity.kind !== 'equipment'" type="button" class="btn btn-primary btn-sm w-full" title="提交当前对象属性" :disabled="propertiesBusy" @click="applyProperties">
            <RefreshCw v-if="propertiesBusy" :size="14" class="animate-spin" aria-hidden="true" />
            <Save v-else :size="14" aria-hidden="true" />{{ propertiesBusy ? '应用中…' : '应用属性' }}
          </button>
        </div>

          <section v-else-if="activeTab === 'blessings' && entity.kind === 'player'" aria-labelledby="blessings-heading">
            <div class="flex items-center gap-2">
              <ShieldCheck :size="16" class="text-[#9f92d6]" aria-hidden="true" />
              <h3 id="blessings-heading" class="m-0 text-[13px] font-bold text-white/78">持有祝福</h3>
              <span class="ml-auto utility-font text-[11px] text-white/45">{{ store.battle.player.blessings.length }}</span>
            </div>
            <div class="mt-3 flex min-w-0 gap-2">
              <select v-model="store.selectedBlessingTypeId" name="blessing-type" class="select select-sm min-w-0 flex-1 px-2 text-[12px]" aria-label="选择祝福" :disabled="blessingBusy || !store.catalog.blessings.length">
                <option v-if="!store.catalog.blessings.length" value="">没有可用祝福</option>
                <option v-for="blessing in store.catalog.blessings" :key="blessing.typeId" :value="blessing.typeId">{{ blessing.name }} · {{ blessing.typeId }}</option>
              </select>
              <button type="button" class="btn btn-neutral btn-square btn-sm shrink-0" title="添加祝福" aria-label="添加祝福" :disabled="!canAddBlessing" @click="addBlessing">
                <RefreshCw v-if="blessingBusy" :size="15" class="animate-spin" aria-hidden="true" />
                <Plus v-else :size="15" aria-hidden="true" />
              </button>
            </div>
            <div v-if="selectedBlessing" class="mt-2 min-w-0 text-[11px] text-white/65">
              <span class="block break-words">{{ selectedBlessing.name }}</span>
              <span class="utility-font mt-0.5 block break-all text-[10px] text-white/45" translate="no">{{ selectedBlessing.typeId }}</span>
            </div>
            <ul v-if="store.battle.player.blessings.length" class="m-0 mt-3 space-y-2 p-0">
              <li v-for="blessing in store.battle.player.blessings" :key="blessing.typeId" class="flex list-none items-start gap-2 border border-white/10 bg-white/[0.025] p-3">
                <div class="min-w-0 flex-1">
                  <p class="m-0 break-words text-[12px] font-semibold text-white/80">{{ blessing.name }}</p>
                  <p class="utility-font m-0 mt-1 break-all text-[10px] text-white/45" translate="no">{{ blessing.typeId }}</p>
                  <p class="m-0 mt-1 break-words text-[11px] leading-5 text-white/50">{{ blessing.description }}</p>
                </div>
                <button type="button" class="btn btn-neutral btn-square btn-sm !h-8 !w-8 shrink-0" :title="`移除 ${blessing.name}`" :aria-label="`移除 ${blessing.name}`" :disabled="blessingBusy" @click="removeBlessing(blessing.typeId)"><Trash2 :size="14" aria-hidden="true" /></button>
              </li>
            </ul>
            <p v-else class="m-0 py-5 text-center text-[11px] text-white/40">当前没有祝福</p>
          </section>

        <div v-else-if="activeTab === 'buffs'" class="space-y-4">
          <div v-if="entity.kind !== 'equipment'" class="space-y-2 border-b border-white/9 pb-4">
            <label class="block text-[11px] text-white/43">
              BUFF
              <select v-model="store.selectedBuffTypeId" name="buff-type" class="select select-sm mt-1 w-full px-2 text-[12px]">
                <option v-for="buff in store.catalog.buffs" :key="buff.typeId" :value="buff.typeId">{{ buff.name }} · {{ buff.typeId }}</option>
              </select>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="text-[11px] text-white/43">
                层数
                <input v-model.number="newBuffStacks" type="number" name="buff-stacks" min="1" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[12px]" />
              </label>
              <label class="text-[11px] text-white/43">
                回合
                <input v-model.number="newBuffDuration" type="number" name="buff-duration" min="1" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[12px]" />
              </label>
            </div>
            <button type="button" class="btn btn-primary btn-sm w-full" title="添加选中的 BUFF" @click="addBuff">
              <Plus :size="14" aria-hidden="true" />
              添加 BUFF
            </button>
          </div>

          <div v-if="targetBuffs.length" class="space-y-2">
            <div v-for="buff in targetBuffs" :key="buff.instanceId" class="flex items-center gap-3 border border-white/10 bg-white/[0.025] p-3">
              <div class="grid h-8 w-8 shrink-0 place-items-center border border-[#7167a8]/45 bg-[#7167a8]/12 utility-font text-[11px] text-[#c6bdf2]">{{ buff.stacks }}</div>
              <div class="min-w-0 flex-1">
                <p class="m-0 truncate text-[12px] font-semibold text-white/76">{{ buff.name }}</p>
                <p class="utility-font m-0 mt-0.5 truncate text-[9px] text-white/31">{{ buff.typeId }}<template v-if="buff.remainingTurns"> · {{ buff.remainingTurns }} 回合</template></p>
              </div>
              <button type="button" class="btn btn-neutral btn-square btn-sm !h-8 !w-8" :aria-label="`移除 ${buff.name}`" :title="`移除 ${buff.name}`" @click="removeBuff(buff.instanceId)">
                <Trash2 :size="14" aria-hidden="true" />
              </button>
            </div>
          </div>
          <p v-else class="py-8 text-center text-[12px] text-white/30">当前没有 BUFF</p>
        </div>

        <div v-else-if="activeTab === 'intents' && enemy" class="space-y-4">
          <div class="flex gap-2 border-b border-white/9 pb-4">
            <select v-model="store.selectedIntentTypeId" name="intent-type" class="select select-sm min-w-0 flex-1 px-2 text-[12px]" aria-label="选择意图">
              <option v-for="intent in store.catalog.intents" :key="intent.typeId" :value="intent.typeId">{{ intent.name }}</option>
            </select>
            <button type="button" class="btn btn-neutral btn-square btn-sm shrink-0" title="添加意图" aria-label="添加意图" @click="addIntent">
              <Plus :size="15" aria-hidden="true" />
            </button>
          </div>

          <ol class="m-0 space-y-2 p-0">
            <li v-for="(intent, index) in enemy.intents" :key="intent.instanceId" class="relative list-none border border-white/11 bg-white/[0.025] p-3">
              <div class="flex items-start gap-2">
                <label class="mt-0.5 grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full border text-[9px] utility-font" :class="enemy.loopStartIndex === index ? 'border-[#c44536] bg-[#c44536] text-white' : 'border-white/18 text-white/35'" :title="`从第 ${index + 1} 步开始循环`">
                  <input v-model.number="enemy.loopStartIndex" class="sr-only" type="radio" name="intent-loop-start" :value="index" />
                  {{ index + 1 }}
                </label>
                <div class="min-w-0 flex-1">
                  <p class="m-0 truncate text-[12px] font-semibold text-white/78">{{ intent.name }}</p>
                  <p class="m-0 mt-1 text-[10px] text-white/36">{{ intent.summary }}</p>
                </div>
                <div class="grid shrink-0 grid-cols-2 gap-1">
                  <button type="button" class="btn btn-neutral btn-square btn-sm !h-7 !w-7" title="上移" aria-label="上移意图" :disabled="index === 0" @click="moveIntent(index, -1)"><ArrowUp :size="12" aria-hidden="true" /></button>
                  <button type="button" class="btn btn-neutral btn-square btn-sm !h-7 !w-7" title="下移" aria-label="下移意图" :disabled="index === (enemy.intents?.length ?? 0) - 1" @click="moveIntent(index, 1)"><ArrowDown :size="12" aria-hidden="true" /></button>
                  <button type="button" class="btn btn-neutral btn-square btn-sm !col-span-2 !h-7 !w-full" title="删除" aria-label="删除意图" @click="removeIntent(index)"><Trash2 :size="12" aria-hidden="true" /></button>
                </div>
              </div>
              <div v-if="Object.keys(intent.parameters).length" class="mt-3 grid grid-cols-2 gap-2 border-t border-white/8 pt-3">
                <label v-for="(_value, key) in intent.parameters" :key="key" class="text-[10px] text-white/34">
                  {{ key }}
                  <input v-model.number="intent.parameters[key]" type="number" :name="`intent-${intent.instanceId}-${key}`" autocomplete="off" class="input input-sm mt-1 w-full px-2 utility-font text-[11px]" />
                </label>
              </div>
            </li>
          </ol>

          <div class="flex gap-2">
            <button type="button" class="btn btn-neutral btn-sm flex-1" title="清空当前意图序列" @click="clearIntents">
              <RotateCcw :size="14" aria-hidden="true" />
              清空
            </button>
            <button type="button" class="btn btn-primary btn-sm flex-1" title="提交当前怪物意图序列" @click="applyIntentSequence">应用序列</button>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="grid h-full place-items-center px-8 text-center text-[12px] leading-6 text-white/32">
      从战斗地图选择一个对象
    </div>
  </aside>
</template>
