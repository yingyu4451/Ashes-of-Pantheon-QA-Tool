<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from '@lucide/vue'
import { useQaStore } from '@/stores/qa'

const store = useQaStore()
</script>

<template>
  <Transition name="notice">
    <div
      v-if="store.notice"
      class="game-notice alert fixed bottom-5 right-5 z-[70] flex w-[min(380px,calc(100vw-40px))] items-start gap-3 border bg-[#1c191d]/98 p-4 shadow-[0_18px_55px_rgb(0_0_0/0.55)] cut-corner max-[640px]:bottom-[76px]"
      :class="store.notice.tone === 'error' ? 'border-[#c44536]/70' : store.notice.tone === 'success' ? 'border-[#4d9e89]/70' : 'border-[#c6a451]/55'"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle v-if="store.notice.tone === 'loading'" :size="17" class="mt-0.5 shrink-0 animate-spin text-[#d5b75f]" aria-hidden="true" />
      <CheckCircle2 v-else-if="store.notice.tone === 'success'" :size="17" class="mt-0.5 shrink-0 text-[#67b49e]" aria-hidden="true" />
      <AlertCircle v-else-if="store.notice.tone === 'error'" :size="17" class="mt-0.5 shrink-0 text-[#e36a58]" aria-hidden="true" />
      <Info v-else :size="17" class="mt-0.5 shrink-0 text-[#d5b75f]" aria-hidden="true" />
      <p class="m-0 min-w-0 flex-1 break-words text-[12px] leading-5 text-white/76">{{ store.notice.message }}</p>
      <button type="button" class="btn btn-neutral btn-square btn-sm !h-7 !w-7 shrink-0" title="关闭提示" aria-label="关闭提示" @click="store.clearNotice">
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.notice-enter-active,
.notice-leave-active {
  transition: transform 160ms ease, opacity 160ms ease;
}

.notice-enter-from,
.notice-leave-to {
  transform: translateY(8px);
  opacity: 0;
}
</style>
