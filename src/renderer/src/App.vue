<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import gsap from 'gsap'
import AppRail from '@/components/AppRail.vue'
import ConnectionBar from '@/components/ConnectionBar.vue'
import GlobalNotice from '@/components/GlobalNotice.vue'
import HelpDialog from '@/components/HelpDialog.vue'
import BattleWorkspace from '@/views/BattleWorkspace.vue'
import CardsWorkspace from '@/views/CardsWorkspace.vue'
import SetupWorkspace from '@/views/SetupWorkspace.vue'
import { useQaStore } from '@/stores/qa'
import type { WorkspaceId } from '@shared/contracts'

const store = useQaStore()
const workspaceRoot = ref<HTMLElement | null>(null)
const helpOpen = ref(false)
const setupRefreshRevision = ref(0)

const workspaceComponents: Record<WorkspaceId, Component> = {
  battle: BattleWorkspace,
  cards: CardsWorkspace,
  setup: SetupWorkspace
}

const activeComponent = computed(() => workspaceComponents[store.activeWorkspace])

function selectWorkspace(workspace: WorkspaceId): void {
  store.activeWorkspace = workspace
  if (workspace === 'setup') setupRefreshRevision.value++
  void store.refreshRuntime(false)
}

function refreshOnWindowFocus(): void {
  void store.refreshRuntime(false)
}

watch(() => store.activeWorkspace, async () => {
  await nextTick()
  if (!workspaceRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  gsap.fromTo(workspaceRoot.value, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform' })
})

onMounted(() => {
  window.addEventListener('focus', refreshOnWindowFocus)
  void store.initialize()
})

onUnmounted(() => {
  window.removeEventListener('focus', refreshOnWindowFocus)
})
</script>

<template>
  <div class="flex h-screen min-h-0 min-w-0 overflow-hidden bg-[#121112] text-[#e8e2d7]">
    <a href="#main-workspace" class="skip-link">跳到主工作区</a>
    <AppRail :active="store.activeWorkspace" @select="selectWorkspace" />

    <div class="flex min-w-0 flex-1 flex-col max-[640px]:pb-[64px]">
      <ConnectionBar
        :status="store.connectionStatus"
        :label="store.connectionLabel"
        :scene-name="store.battle.sceneName"
        :turn="store.battle.turn"
        :phase="store.battle.phase"
        :runtime-ready="store.runtimeReady"
        @open-setup="store.activeWorkspace = 'setup'"
        @open-help="helpOpen = true"
        @refresh="store.refreshRuntime"
      />

      <main id="main-workspace" ref="workspaceRoot" class="min-h-0 flex-1" tabindex="-1">
        <component :is="activeComponent" v-bind="store.activeWorkspace === 'battle' ? { interactionSuspended: helpOpen } : store.activeWorkspace === 'setup' ? { refreshRevision: setupRefreshRevision } : {}" />
      </main>
    </div>
    <GlobalNotice />
    <HelpDialog v-if="helpOpen" @close="helpOpen = false" />
  </div>
</template>
