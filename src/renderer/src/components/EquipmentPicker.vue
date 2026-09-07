<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { ChevronDown, Search } from '@lucide/vue'

const props = defineProps<{ modelValue: string; options: Array<{ typeId: string; name: string }>; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(-1)
const listId = useId()
const selected = computed(() => props.options.find((item) => item.typeId === props.modelValue))
const label = computed(() => selected.value ? `${selected.value.name} · ${selected.value.typeId}` : '')
const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase('zh-CN')
  return props.options.filter((item) => `${item.name} ${item.typeId}`.toLocaleLowerCase('zh-CN').includes(term))
})

function begin(): void {
  if (props.disabled || !props.options.length || open.value) return
  query.value = ''
  activeIndex.value = -1
  open.value = true
}

function select(typeId: string): void {
  emit('update:modelValue', typeId)
  open.value = false
}

async function onKeydown(event: KeyboardEvent): Promise<void> {
  if (event.isComposing) return
  if (event.key === 'Escape' || event.key === 'Tab') { open.value = false; return }
  if (event.key === 'Enter' && open.value) {
    event.preventDefault()
    const item = filtered.value[activeIndex.value < 0 ? 0 : activeIndex.value]
    if (item) select(item.typeId)
    return
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  begin()
  if (!filtered.value.length) return
  activeIndex.value = activeIndex.value < 0
    ? event.key === 'ArrowDown' ? 0 : filtered.value.length - 1
    : (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + filtered.value.length) % filtered.value.length
  await nextTick()
  document.getElementById(`${listId}-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' })
}

function dismiss(event: PointerEvent): void {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
watch(query, () => { activeIndex.value = -1 })
watch(() => props.disabled, (disabled) => { if (disabled) open.value = false })
watch(() => props.options, () => { activeIndex.value = -1; if (!props.options.length) open.value = false })
onMounted(() => document.addEventListener('pointerdown', dismiss))
onUnmounted(() => document.removeEventListener('pointerdown', dismiss))
</script>

<template>
  <div ref="root" class="dropdown dropdown-top relative block min-w-0">
    <div class="relative flex items-center">
      <input ref="input" :value="open ? query : label" role="combobox" aria-label="放置装备" aria-autocomplete="list" :aria-expanded="open" :aria-controls="listId" :aria-activedescendant="open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined" :disabled="disabled || !options.length" name="placement-equipment" autocomplete="off" :placeholder="options.length ? '中文名、TypeId…' : '没有可用装备'" class="input input-sm w-full min-w-0 pr-8 text-[11px]" @focus="begin" @click="begin" @input="query = ($event.target as HTMLInputElement).value; open = true" @keydown="onKeydown" @blur="open = false" />
      <button type="button" class="absolute right-1 grid h-7 w-7 place-items-center text-base-content/60 hover:text-secondary" aria-label="展开装备目录" title="展开装备目录" :disabled="disabled || !options.length" @mousedown.prevent @click="open ? open = false : (input?.focus(), begin())"><ChevronDown :size="14" aria-hidden="true" /></button>
    </div>
    <div v-if="open" class="absolute bottom-full left-0 z-50 mb-2 w-[340px] max-w-[calc(100vw-32px)] rounded-box border border-base-content/20 bg-base-200 p-1 shadow-xl">
      <div class="flex items-center gap-2 border-b border-base-content/10 px-2 py-2 text-[11px] text-base-content/60"><Search :size="13" aria-hidden="true" />装备目录 <span class="ml-auto tabular-nums">{{ filtered.length }}</span></div>
      <ul :id="listId" role="listbox" aria-label="装备目录" class="menu m-0 block max-h-64 w-full overflow-y-auto p-0.5">
        <li v-for="(item, index) in filtered" :id="`${listId}-${index}`" :key="item.typeId" role="option" :aria-selected="modelValue === item.typeId" :aria-label="`${item.name} ${item.typeId}`" class="block cursor-pointer rounded-sm px-2 py-2 hover:bg-base-content/10" :class="activeIndex === index ? 'bg-base-content/10' : ''" @mousedown.prevent @click="select(item.typeId)" @pointermove="activeIndex = index">
          <span class="block break-words p-0 text-[12px] font-semibold" :class="modelValue === item.typeId ? 'text-secondary' : 'text-base-content'">{{ item.name }}</span>
          <span class="utility-font mt-1 block break-all p-0 text-[10px] text-base-content/60" translate="no">{{ item.typeId }}</span>
        </li>
      </ul>
      <p v-if="!filtered.length" class="m-0 py-5 text-center text-[12px] text-base-content/60" role="status">没有匹配的装备</p>
    </div>
  </div>
</template>
