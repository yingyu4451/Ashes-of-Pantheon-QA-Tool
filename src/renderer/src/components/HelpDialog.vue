<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { X } from '@lucide/vue'
import { marked } from 'marked'
import usage from '../../../../docs/usage.md?raw'

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
// The only HTML input is the repository-owned guide bundled at build time, never runtime or user content.
const content = marked.parse(usage, { async: false })

function close(): void { dialog.value?.close() }
onMounted(() => dialog.value?.showModal())
onUnmounted(() => { if (dialog.value?.open) dialog.value.close() })
</script>

<template>
  <dialog ref="dialog" class="modal" aria-labelledby="help-title" @close="emit('close')" @keydown.stop @click="($event.target === dialog) && close()">
    <div class="game-dialog modal-box flex h-[min(740px,calc(100dvh-64px))] w-[min(920px,calc(100vw-48px))] max-w-none flex-col overflow-hidden rounded-md border border-white/15 bg-base-200 p-0">
      <header class="flex shrink-0 items-center justify-between border-b border-white/10 px-6 py-4">
        <h2 id="help-title" class="display-font m-0 text-[20px] text-base-content">使用说明</h2>
        <button type="button" class="btn btn-ghost btn-square btn-sm" title="关闭使用说明" aria-label="关闭使用说明" autofocus @click="close"><X :size="18" aria-hidden="true" /></button>
      </header>
      <article class="help-content min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5" tabindex="0" aria-label="使用说明正文" v-html="content" />
    </div>
  </dialog>
</template>

<style scoped>
.help-content { color: #d8d5d0; font-size: 13px; line-height: 1.9; overflow-wrap: anywhere; }
.help-content :deep(h1) { margin: 0 0 20px; font-size: 18px; color: #eee7dc; }
.help-content :deep(h2) { margin: 28px 0 12px; border-bottom: 1px solid rgb(255 255 255 / 12%); padding-bottom: 8px; font-size: 15px; font-weight: 700; color: #d5b75f; }
.help-content :deep(p) { margin: 12px 0; }
.help-content :deep(ol), .help-content :deep(ul) { margin: 12px 0; padding-left: 24px; }
.help-content :deep(ol) { list-style: decimal; }
.help-content :deep(ul) { list-style: disc; }
.help-content :deep(li) { margin: 6px 0; }
.help-content :deep(code) { font-family: Consolas, monospace; font-size: 12px; color: #b1d9cf; }
.help-content :deep(table) { width: 100%; margin: 16px 0; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.help-content :deep(th), .help-content :deep(td) { padding: 8px 10px; border: 1px solid rgb(255 255 255 / 14%); text-align: left; vertical-align: top; }
.help-content :deep(th) { color: #eee7dc; background: rgb(255 255 255 / 4%); }
</style>
