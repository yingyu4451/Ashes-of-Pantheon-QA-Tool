<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Shield, Skull, UserRound } from '@lucide/vue'
import type { Component } from 'vue'
import { resolveEntityImageUrl } from '@shared/catalog'
import type { QaCatalog, QaEntity } from '@shared/contracts'
import { resolveEntitySpriteSource } from './entitySprite'

const props = withDefaults(defineProps<{
  entity: Pick<QaEntity, 'kind' | 'typeId'>
  catalog?: QaCatalog | null
  /** Placeholder icon override (the battle list keeps PackageOpen for equipment). */
  fallbackIcon?: Component
  iconSize?: number
}>(), { catalog: null, iconSize: 16 })

const fallbackIcons: Record<QaEntity['kind'], Component> = {
  player: UserRound,
  enemy: Skull,
  equipment: Shield
}

const failedSrc = ref('')
const imageUrl = computed(() => resolveEntityImageUrl(props.catalog, props.entity))
const icon = computed(() => props.fallbackIcon ?? fallbackIcons[props.entity.kind] ?? Shield)
const source = computed(() => resolveEntitySpriteSource(props.catalog, props.entity, failedSrc.value))

function handleImageError(): void {
  failedSrc.value = imageUrl.value ?? ''
}

// A different texture (catalog refresh) gets another chance; the failed URL stays on fallback.
watch(imageUrl, (src) => {
  if (src && src !== failedSrc.value) failedSrc.value = ''
})
</script>

<template>
  <span class="pointer-events-none grid h-full min-h-0 w-full min-w-0 select-none place-items-center overflow-hidden" aria-hidden="true">
    <img
      v-if="source.kind === 'image'"
      :src="source.src"
      alt=""
      draggable="false"
      class="h-full w-full object-contain drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)]"
      @error="handleImageError"
    />
    <component :is="icon" v-else :size="iconSize" />
  </span>
</template>
