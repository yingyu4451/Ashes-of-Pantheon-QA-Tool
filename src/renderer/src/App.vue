<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import gsap from 'gsap'
import AppRail from '@/components/AppRail.vue'
import ConnectionBar from '@/components/ConnectionBar.vue'
import GlobalNotice from '@/components/GlobalNotice.vue'
import BattleWorkspace from '@/views/BattleWorkspace.vue'
import CardsWorkspace from '@/views/CardsWorkspace.vue'
import PlayerWorkspace from '@/views/PlayerWorkspace.vue'
import SetupWorkspace from '@/views/SetupWorkspace.vue'
import { useQaStore } from '@/stores/qa'
import type { WorkspaceId } from '@shared/contracts'

const store = useQaStore()
const workspaceRoot = ref<HTMLElement | null>(null)

const workspaceComponents: Record<WorkspaceId, Component> = {
  battle: BattleWorkspace,
  cards: CardsWorkspace,
  player: PlayerWorkspace,
  setup: SetupWorkspace
}

const activeComponent = computed(() => workspaceComponents[store.activeWorkspace])

watch(() => store.activeWorkspace, async () => {
  await nextTick()
  if (!workspaceRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  gsap.fromTo(workspaceRoot.value, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform' })
})

onMounted(() => {
  void store.initialize()
})
</script>

<template>
  <div class="flex h-screen min-h-0 min-w-0 overflow-hidden bg-[#121112] text-[#e8e2d7]">
    <a href="#main-workspace" class="skip-link">跳到主工作区</a>
    <AppRail :active="store.activeWorkspace" @select="store.activeWorkspace = $event" />

    <div class="flex min-w-0 flex-1 flex-col max-[640px]:pb-[64px]">
      <ConnectionBar
        :status="store.connectionStatus"
        :label="store.connectionLabel"
        :scene-name="store.battle.sceneName"
        :turn="store.battle.turn"
        :phase="store.battle.phase"
        :runtime-ready="store.runtimeReady"
        @open-setup="store.activeWorkspace = 'setup'"
        @refresh="store.refreshRuntime"
      />

      <main id="main-workspace" ref="workspaceRoot" class="min-h-0 flex-1" tabindex="-1">
        <component :is="activeComponent" />
      </main>
    </div>
    <GlobalNotice />
  </div>
</template>
