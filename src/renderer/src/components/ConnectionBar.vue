<script setup lang="ts">
import { Cable, CircleHelp, RefreshCw } from '@lucide/vue'
import type { ConnectionStatus } from '@shared/contracts'

defineProps<{
  status: ConnectionStatus
  label: string
  sceneName: string
  turn: number
  phase: string
  runtimeReady: boolean
}>()

const emit = defineEmits<{ openSetup: []; openHelp: []; refresh: [] }>()
</script>

<template>
  <header class="flex h-[58px] shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#19181b]/96 px-5">
    <div class="flex min-w-0 items-center gap-3">
      <button type="button" class="flex min-w-0 items-center gap-2 text-left" @click="emit('openSetup')">
        <span class="status-dot shrink-0" :data-status="status" aria-hidden="true" />
        <span class="truncate text-[13px] font-semibold text-white/82">{{ label }}</span>
      </button>
      <span class="h-4 w-px bg-white/10 max-[520px]:hidden" aria-hidden="true" />
      <span class="truncate utility-font text-[11px] text-white/38 max-[520px]:hidden">{{ runtimeReady ? sceneName : status === 'connected' ? 'Editor 已连接 · 未进入 Play Mode' : '未连接运行时' }}</span>
    </div>

    <div class="flex shrink-0 items-center gap-4">
      <div v-if="runtimeReady" class="hidden items-center gap-4 text-[11px] text-white/45 sm:flex">
        <span>回合 <b class="ml-1 text-white/78">{{ turn }}</b></span>
        <span>阶段 <b class="ml-1 text-white/78">{{ phase }}</b></span>
      </div>
      <button type="button" class="btn btn-neutral btn-square btn-sm" title="刷新运行时状态" aria-label="刷新运行时状态" :disabled="status !== 'connected'" @click="emit('refresh')">
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
      <button type="button" class="btn btn-neutral btn-square btn-sm" title="使用说明" aria-label="使用说明" @click="emit('openHelp')"><CircleHelp :size="16" aria-hidden="true" /></button>
      <button type="button" class="btn btn-neutral btn-sm" @click="emit('openSetup')">
        <Cable :size="15" aria-hidden="true" />
        <span class="max-[520px]:sr-only">连接</span>
      </button>
    </div>
  </header>
</template>
