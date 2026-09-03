<script setup lang="ts">
import { computed } from 'vue'
import { Cable, HeartPulse, Plus, ShieldCheck, Trash2, WalletCards } from '@lucide/vue'
import { useQaStore } from '@/stores/qa'

const store = useQaStore()
const player = computed(() => store.battle.player)

function normalize(): void {
  if (store.unsafeValues) return
  player.value.maxHp = Math.max(1, player.value.maxHp)
  player.value.currentHp = Math.min(Math.max(0, player.value.currentHp), player.value.maxHp)
  player.value.maxCost = Math.max(0, player.value.maxCost)
  player.value.currentCost = Math.min(Math.max(0, player.value.currentCost), player.value.maxCost)
}

function addBlessing(): void {
  const definition = store.catalog.blessings.find((item) => item.typeId === store.selectedBlessingTypeId)
  if (!definition || player.value.blessings.some((item) => item.typeId === definition.typeId)) return
  if (store.connectionStatus === 'connected') {
    void store.addBlessing(definition.typeId)
  } else {
    player.value.blessings.push({ ...definition, description: '由 QA 工具添加到当前运行会话。' })
  }
}

async function removeBlessing(typeId: string): Promise<void> {
  if (!window.confirm('从当前会话移除这个祝福？')) return
  if (store.connectionStatus === 'connected') {
    await store.removeBlessing(typeId)
  } else {
    player.value.blessings = player.value.blessings.filter((item) => item.typeId !== typeId)
  }
}
</script>

<template>
  <section v-if="!store.runtimeReady" class="grid h-full place-items-center px-8 text-center" aria-labelledby="player-empty-title">
    <div>
      <Cable :size="28" class="mx-auto text-[#c6a451]/65" aria-hidden="true" />
      <h1 id="player-empty-title" class="display-font m-0 mt-4 text-[24px] text-[#eee7dc]">未连接玩家实例</h1>
      <p class="m-0 mt-2 text-[12px] text-white/38">连接 Unity Editor Play Mode 后载入玩家状态。</p>
      <button type="button" class="primary-button mt-5" @click="store.activeWorkspace = 'setup'">前往连接</button>
    </div>
  </section>

  <section v-else class="h-full min-h-0 overflow-y-auto" aria-labelledby="player-title">
    <header class="border-b border-white/9 px-7 py-5">
      <p class="utility-font m-0 text-[10px] text-[#c6a451]/65">MAIN CHARACTER</p>
      <h1 id="player-title" class="display-font m-0 mt-1 text-[26px] text-[#eee7dc]">玩家状态</h1>
    </header>

    <div class="mx-auto grid max-w-[1120px] grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)] gap-8 px-7 py-7 max-[900px]:grid-cols-1">
      <div class="space-y-8">
        <section aria-labelledby="vitals-heading">
          <div class="flex items-center gap-3 border-b border-white/10 pb-3">
            <HeartPulse :size="18" class="text-[#d65a49]" aria-hidden="true" />
            <h2 id="vitals-heading" class="m-0 text-[14px] font-bold text-white/78">生命</h2>
          </div>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <label class="text-[11px] text-white/42">当前生命<input v-model.number="player.currentHp" type="number" name="player-page-current-hp" autocomplete="off" class="field mt-1 w-full px-3 utility-font" @blur="normalize" /></label>
            <label class="text-[11px] text-white/42">最大生命<input v-model.number="player.maxHp" type="number" name="player-page-max-hp" autocomplete="off" class="field mt-1 w-full px-3 utility-font" @blur="normalize" /></label>
          </div>
          <div class="mt-4 h-3 overflow-hidden border border-white/12 bg-black/35">
            <div class="h-full bg-[#b73e33]" :style="{ width: `${Math.min(100, Math.max(0, player.currentHp / Math.max(1, player.maxHp) * 100))}%` }" />
          </div>
        </section>

        <section aria-labelledby="cost-heading">
          <div class="flex items-center gap-3 border-b border-white/10 pb-3">
            <WalletCards :size="18" class="text-[#d1af52]" aria-hidden="true" />
            <h2 id="cost-heading" class="m-0 text-[14px] font-bold text-white/78">费用</h2>
          </div>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <label class="text-[11px] text-white/42">持有费用<input v-model.number="player.currentCost" type="number" name="player-page-current-cost" autocomplete="off" class="field mt-1 w-full px-3 utility-font" @blur="normalize" /></label>
            <label class="text-[11px] text-white/42">最大费用<input v-model.number="player.maxCost" type="number" name="player-page-max-cost" autocomplete="off" class="field mt-1 w-full px-3 utility-font" @blur="normalize" /></label>
          </div>
        </section>

        <label class="flex items-start gap-3 border-t border-white/9 pt-5 text-[11px] text-white/50">
          <input v-model="store.unsafeValues" type="checkbox" name="player-unsafe-values" class="mt-0.5 accent-[#c44536]" />
          <span>允许异常值<small class="mt-1 block text-white/28">用于负数、超上限等边界测试。</small></span>
        </label>
        <button type="button" class="primary-button min-w-36" @click="store.applyPlayer">应用玩家属性</button>
        <p v-if="store.lastOperationMessage" class="m-0 text-[10px] leading-5 text-[#d5b75f]" aria-live="polite">{{ store.lastOperationMessage }}</p>
      </div>

      <section aria-labelledby="blessings-heading">
        <div class="flex items-center gap-3 border-b border-white/10 pb-3">
          <ShieldCheck :size="18" class="text-[#9f92d6]" aria-hidden="true" />
          <h2 id="blessings-heading" class="m-0 text-[14px] font-bold text-white/78">持有祝福</h2>
          <span class="ml-auto utility-font text-[10px] text-white/32">{{ player.blessings.length }}</span>
        </div>

        <div class="mt-4 flex gap-2">
          <select v-model="store.selectedBlessingTypeId" name="blessing-type" class="field min-w-0 flex-1 px-3 text-[12px]" aria-label="选择祝福">
            <option v-for="blessing in store.catalog.blessings" :key="blessing.typeId" :value="blessing.typeId">{{ blessing.name }}</option>
          </select>
          <button type="button" class="icon-button shrink-0" title="添加祝福" aria-label="添加祝福" @click="addBlessing"><Plus :size="15" aria-hidden="true" /></button>
        </div>

        <div class="mt-4 space-y-2">
          <div v-for="blessing in player.blessings" :key="blessing.typeId" class="flex items-start gap-3 border border-white/10 bg-white/[0.025] p-3">
            <span class="grid h-9 w-9 shrink-0 place-items-center border border-[#7167a8]/50 bg-[#7167a8]/12 text-[#c6bdf0]"><ShieldCheck :size="16" aria-hidden="true" /></span>
            <div class="min-w-0 flex-1">
              <p class="m-0 text-[12px] font-semibold text-white/76">{{ blessing.name }}</p>
              <p class="m-0 mt-1 text-[10px] leading-5 text-white/35">{{ blessing.description }}</p>
              <p class="utility-font m-0 mt-1 text-[9px] text-white/22">{{ blessing.typeId }}</p>
            </div>
            <button type="button" class="icon-button !h-8 !w-8" :title="`移除 ${blessing.name}`" :aria-label="`移除 ${blessing.name}`" @click="removeBlessing(blessing.typeId)"><Trash2 :size="14" aria-hidden="true" /></button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
