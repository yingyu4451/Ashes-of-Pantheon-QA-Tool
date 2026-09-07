<script setup lang="ts">
import { BookOpen, Boxes, Settings } from '@lucide/vue'
import type { Component } from 'vue'
import type { WorkspaceId } from '@shared/contracts'

defineProps<{ active: WorkspaceId }>()
const emit = defineEmits<{ select: [workspace: WorkspaceId] }>()

const items: Array<{ id: WorkspaceId; label: string; icon: Component }> = [
  { id: 'battle', label: '战斗', icon: Boxes },
  { id: 'cards', label: '卡牌', icon: BookOpen },
  { id: 'setup', label: '连接', icon: Settings }
]
</script>

<template>
  <nav class="flex h-full w-[86px] shrink-0 flex-col border-r border-white/10 bg-[#171619] max-[640px]:fixed max-[640px]:inset-x-0 max-[640px]:bottom-0 max-[640px]:z-[60] max-[640px]:h-[64px] max-[640px]:w-full max-[640px]:flex-row max-[640px]:border-r-0 max-[640px]:border-t" aria-label="主导航">
    <div class="flex h-[78px] items-center justify-center border-b border-white/8 max-[640px]:hidden">
      <div class="grid h-10 w-10 place-items-center border border-[#c6a451]/50 bg-[#211d20] text-[#e5c566] cut-corner" aria-label="Ashes of Pantheon QA Tool">
        <span class="display-font text-[22px]">A</span>
      </div>
    </div>

    <div class="flex flex-1 flex-col gap-1 p-2 pt-4 max-[640px]:flex-row max-[640px]:gap-0 max-[640px]:p-0">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="group relative flex h-[62px] flex-col items-center justify-center gap-1 border border-transparent text-[12px] text-white/48 transition-colors hover:bg-white/4 hover:text-white/80 max-[640px]:h-full max-[640px]:flex-1"
        :class="active === item.id ? 'border-[#c6a451]/28 bg-[#c6a451]/8 text-[#efd47a]' : ''"
        :aria-current="active === item.id ? 'page' : undefined"
        @click="emit('select', item.id)"
      >
        <span v-if="active === item.id" class="absolute inset-y-2 left-0 w-[2px] bg-[#c44536] max-[640px]:inset-x-3 max-[640px]:top-0 max-[640px]:h-[2px] max-[640px]:w-auto" aria-hidden="true" />
        <component :is="item.icon" :size="19" :stroke-width="1.8" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>

    <div class="border-t border-white/8 px-2 py-3 text-center utility-font text-[9px] text-white/25 max-[640px]:hidden">QA 0.1.9</div>
  </nav>
</template>
