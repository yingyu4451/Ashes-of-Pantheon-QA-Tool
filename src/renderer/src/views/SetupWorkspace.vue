<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Cable, Download, FolderOpen, PackageCheck, Play, RefreshCw, Trash2 } from '@lucide/vue'
import { useQaStore } from '@/stores/qa'
import type { BridgeInstance, GameBuildInspection, PackageBridgeInspection, UnityProjectInspection, UpdatePhase } from '@shared/contracts'

const store = useQaStore()
const projectInspection = ref<UnityProjectInspection | null>(null)
const buildInspection = ref<GameBuildInspection | null>(null)
const packageBridgeInspection = ref<PackageBridgeInspection | null>(null)
const instances = ref<BridgeInstance[]>([])
const busy = ref(false)
const connectingInstanceId = ref('')
const refreshingInstances = ref(false)
const packageBridgeBusy = ref(false)
const statusMessage = ref('')
let instanceRefreshTimer: ReturnType<typeof setInterval> | undefined
let buildInspectionRevision = 0
const updatePhaseLabels: Record<UpdatePhase, string> = {
  disabled: '开发模式',
  idle: '待检查',
  checking: '检查中',
  available: '可更新',
  'not-available': '已是最新',
  downloading: '打开下载',
  downloaded: '请替换文件',
  error: '检查失败'
}

async function selectUnityProject(): Promise<void> {
  if (!window.qaNative) {
    statusMessage.value = '目录选择仅在 Electron 应用中可用。'
    return
  }
  const path = await window.qaNative.selectDirectory('选择 Ashes of Pantheon Unity 项目')
  if (!path) return
  projectInspection.value = await window.qaNative.inspectUnityProject(path)
  if (projectInspection.value.valid) {
    const saved = await store.rememberPaths({ unityProjectPath: projectInspection.value.path })
    store.showNotice(saved.ok ? 'Unity 项目路径已保存。' : saved.message, saved.ok ? 'success' : 'error')
  } else {
    store.showNotice(projectInspection.value.message, 'error')
  }
}

async function installBridge(): Promise<void> {
  if (!window.qaNative || !store.unityProjectPath) return
  busy.value = true
  try {
    const result = await window.qaNative.installEditorBridge(store.unityProjectPath)
    statusMessage.value = result.message
    store.showNotice(result.message, result.ok ? 'success' : 'error')
    projectInspection.value = await window.qaNative.inspectUnityProject(store.unityProjectPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bridge 安装或更新失败。请重新选择 Unity 项目后重试。'
    statusMessage.value = message
    store.showNotice(message, 'error')
  } finally {
    busy.value = false
  }
}

async function uninstallBridge(): Promise<void> {
  if (!window.qaNative || !store.unityProjectPath) return
  if (!window.confirm('从所选 Unity 项目卸载 Editor Bridge？')) return
  busy.value = true
  try {
    const result = await window.qaNative.uninstallEditorBridge(store.unityProjectPath)
    statusMessage.value = result.message
    store.showNotice(result.message, result.ok ? 'success' : 'error')
    projectInspection.value = await window.qaNative.inspectUnityProject(store.unityProjectPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bridge 卸载失败。请关闭 Unity 后重试。'
    statusMessage.value = message
    store.showNotice(message, 'error')
  } finally {
    busy.value = false
  }
}

async function selectBuild(): Promise<void> {
  if (!window.qaNative) {
    statusMessage.value = '游戏包识别仅在 Electron 应用中可用。'
    return
  }
  const path = await window.qaNative.selectDirectory('选择游戏包目录')
  if (!path) return
  const revision = ++buildInspectionRevision
  buildInspection.value = null
  packageBridgeInspection.value = null
  const inspection = await window.qaNative.inspectGameBuild(path)
  if (revision !== buildInspectionRevision) return
  buildInspection.value = inspection
  if (inspection.valid) {
    const saved = await store.rememberPaths({ gameBuildPath: inspection.path })
    store.showNotice(saved.ok ? '游戏包路径已保存。' : saved.message, saved.ok ? 'success' : 'error')
  } else {
    store.showNotice(inspection.message, 'error')
  }
}

async function installPackageBridge(): Promise<void> {
  if (!window.qaNative || !store.gameBuildPath) return
  packageBridgeBusy.value = true
  try {
    const result = await window.qaNative.preparePackageBridge(store.gameBuildPath)
    if (result.data) packageBridgeInspection.value = result.data
    store.showNotice(result.message, result.ok ? 'success' : 'error')
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '打包版 Bridge 安装失败。', 'error')
  } finally {
    packageBridgeBusy.value = false
  }
}

async function launchPackageBridge(): Promise<void> {
  if (!window.qaNative || !store.gameBuildPath) return
  packageBridgeBusy.value = true
  try {
    const result = await window.qaNative.launchPackageBridge(store.gameBuildPath)
    if (result.data) packageBridgeInspection.value = result.data
    store.showNotice(result.message, result.ok ? 'success' : 'error')
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '临时游戏副本启动失败。', 'error')
  } finally {
    packageBridgeBusy.value = false
  }
}

async function removePackageBridge(): Promise<void> {
  if (!window.qaNative || !store.gameBuildPath) return
  if (!window.confirm('移除打包游戏的临时 Bridge 副本？原始游戏包不会被删除。')) return
  packageBridgeBusy.value = true
  try {
    const result = await window.qaNative.removePackageBridge(store.gameBuildPath)
    packageBridgeInspection.value = await window.qaNative.inspectPackageBridge(store.gameBuildPath)
    store.showNotice(result.message, result.ok ? 'success' : 'error')
  } catch (error) {
    store.showNotice(error instanceof Error ? error.message : '临时 Bridge 移除失败。请先关闭由 QA 工具启动的游戏。', 'error')
  } finally {
    packageBridgeBusy.value = false
  }
}

async function refreshInstances(announce = false): Promise<void> {
  if (announce) refreshingInstances.value = true
  try {
    instances.value = window.qaNative ? await window.qaNative.listBridgeInstances() : []
    if (announce) store.showNotice(instances.value.length ? `发现 ${instances.value.length} 个运行实例。` : '没有发现运行中的 Bridge。请确认 Unity 已打开且 Bridge 编译成功。', instances.value.length ? 'success' : 'info')
  } catch (error) {
    if (announce) store.showNotice(error instanceof Error ? error.message : '运行实例刷新失败。请重新启动工具后重试。', 'error')
  } finally {
    refreshingInstances.value = false
  }
}

async function connect(instance: BridgeInstance): Promise<void> {
  connectingInstanceId.value = instance.instanceId
  try {
    const result = await store.connectToInstance(instance)
    statusMessage.value = result.message
    if (result.ok) {
      store.activeWorkspace = store.runtimeReady ? 'battle' : 'cards'
    }
  } finally {
    connectingInstanceId.value = ''
  }
}

onMounted(() => {
  void refreshInstances()
  instanceRefreshTimer = setInterval(() => void refreshInstances(), 2000)
})

watch(() => store.unityProjectPath, async (path) => {
  projectInspection.value = path && window.qaNative ? await window.qaNative.inspectUnityProject(path) : null
}, { immediate: true })

watch(() => store.gameBuildPath, async (path) => {
  const revision = ++buildInspectionRevision
  buildInspection.value = null
  packageBridgeInspection.value = null
  if (!path || !window.qaNative) return

  const nextBuildInspection = await window.qaNative.inspectGameBuild(path)
  if (revision !== buildInspectionRevision || store.gameBuildPath !== path) return
  buildInspection.value = nextBuildInspection
  if (!nextBuildInspection.valid) return

  const nextBridgeInspection = await window.qaNative.inspectPackageBridge(path)
  if (revision !== buildInspectionRevision || store.gameBuildPath !== path) return
  packageBridgeInspection.value = nextBridgeInspection
}, { immediate: true })

onUnmounted(() => {
  if (instanceRefreshTimer) clearInterval(instanceRefreshTimer)
})
</script>

<template>
  <section class="h-full min-h-0 overflow-y-auto" aria-labelledby="setup-title">
    <header class="border-b border-white/9 px-7 py-5">
      <p class="utility-font m-0 text-[10px] text-[#c6a451]/65">CONNECTIONS</p>
      <h1 id="setup-title" class="display-font m-0 mt-1 text-[26px] text-[#eee7dc]">项目与连接</h1>
    </header>

    <div class="mx-auto max-w-[1100px] px-7 py-7">
      <section class="grid grid-cols-[180px_minmax(0,1fr)] gap-7 border-b border-white/10 pb-8 max-[760px]:grid-cols-1" aria-labelledby="editor-heading">
        <div>
          <h2 id="editor-heading" class="m-0 text-[14px] font-bold text-white/78">Editor Bridge</h2>
          <p class="utility-font mt-2 text-[9px] text-white/28">EDITOR PLAY MODE</p>
        </div>
        <div class="space-y-3">
          <div class="flex min-w-0 gap-2">
            <input class="field min-w-0 flex-1 px-3 utility-font text-[11px]" :value="store.unityProjectPath" name="unity-project-path" autocomplete="off" readonly placeholder="未选择 Unity 项目…" aria-label="Unity 项目路径" />
            <button type="button" class="secondary-button shrink-0" @click="selectUnityProject"><FolderOpen :size="15" aria-hidden="true" />选择项目</button>
          </div>

          <div v-if="projectInspection" class="flex flex-wrap items-center gap-x-5 gap-y-2 border border-white/10 bg-white/[0.025] px-3 py-2 text-[11px]">
            <span :class="projectInspection.valid ? 'text-[#67b49e]' : 'text-[#dd6958]'">{{ projectInspection.message }}</span>
            <span v-if="projectInspection.unityVersion" class="utility-font text-white/36">Unity {{ projectInspection.unityVersion }}</span>
            <span class="ml-auto text-white/42">{{ projectInspection.bridgeInstalled ? 'Bridge 已安装' : 'Bridge 未安装' }}</span>
          </div>

          <div class="flex gap-2">
            <button type="button" class="primary-button" :disabled="busy || !projectInspection?.valid" @click="installBridge">
              <RefreshCw v-if="busy" :size="15" class="animate-spin" aria-hidden="true" />
              <PackageCheck v-else :size="15" aria-hidden="true" />
              {{ busy ? '处理中…' : projectInspection?.bridgeInstalled ? '更新 Bridge' : '安装 Bridge' }}
            </button>
            <button type="button" class="secondary-button" :disabled="busy || !projectInspection?.bridgeInstalled" @click="uninstallBridge"><Trash2 :size="14" aria-hidden="true" />卸载 Bridge</button>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-[180px_minmax(0,1fr)] gap-7 border-b border-white/10 py-8 max-[760px]:grid-cols-1" aria-labelledby="build-heading">
        <div>
          <h2 id="build-heading" class="m-0 text-[14px] font-bold text-white/78">打包游戏</h2>
          <p class="utility-font mt-2 text-[9px] text-white/28">TEMPORARY QA COPY</p>
        </div>
        <div class="space-y-3">
          <div class="flex min-w-0 gap-2">
            <input class="field min-w-0 flex-1 px-3 utility-font text-[11px]" :value="store.gameBuildPath" name="game-build-path" autocomplete="off" readonly placeholder="未选择游戏包…" aria-label="游戏包路径" />
            <button type="button" class="secondary-button shrink-0" @click="selectBuild"><FolderOpen :size="15" aria-hidden="true" />选择游戏包</button>
          </div>
          <div v-if="buildInspection" class="flex flex-wrap items-center gap-x-5 gap-y-2 border border-white/10 bg-white/[0.025] px-3 py-2 text-[11px]">
            <span :class="buildInspection.valid ? 'text-[#67b49e]' : 'text-[#dd6958]'">{{ buildInspection.message }}</span>
            <span v-if="buildInspection.backend" class="border border-[#7167a8]/40 bg-[#7167a8]/10 px-2 py-1 utility-font text-[9px] uppercase text-[#b8afe5]">{{ buildInspection.backend }}</span>
            <span v-if="buildInspection.executablePath" class="min-w-0 truncate utility-font text-white/28">{{ buildInspection.executablePath }}</span>
          </div>
          <div v-if="packageBridgeInspection" class="min-w-0 border border-white/10 bg-white/[0.025] px-3 py-2 text-[11px]" :class="packageBridgeInspection.prepared ? 'text-[#67b49e]' : 'text-[#d5b75f]'">
            <p class="m-0">{{ packageBridgeInspection.message }}</p>
            <p v-if="packageBridgeInspection.prepared && packageBridgeInspection.temporaryPath" class="utility-font m-0 mt-1 truncate text-[9px] text-white/32" :title="packageBridgeInspection.temporaryPath">
              临时副本 <span translate="no">{{ packageBridgeInspection.temporaryPath }}</span>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="!packageBridgeInspection?.prepared"
              type="button"
              class="primary-button"
              :disabled="packageBridgeBusy || !buildInspection?.valid || buildInspection.backend !== 'mono'"
              @click="installPackageBridge"
            >
              <RefreshCw v-if="packageBridgeBusy" :size="14" class="animate-spin" aria-hidden="true" />
              <PackageCheck v-else :size="14" aria-hidden="true" />
              {{ packageBridgeBusy ? '安装中…' : '安装打包版 Bridge' }}
            </button>
            <button
              v-else
              type="button"
              class="primary-button"
              :disabled="packageBridgeBusy"
              @click="launchPackageBridge"
            >
              <Play :size="14" aria-hidden="true" />{{ packageBridgeBusy ? '启动中…' : '从临时副本启动' }}
            </button>
            <button
              v-if="packageBridgeInspection?.prepared"
              type="button"
              class="secondary-button"
              :disabled="packageBridgeBusy"
              @click="removePackageBridge"
            >
              <Trash2 :size="14" aria-hidden="true" />移除临时 Bridge
            </button>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-[180px_minmax(0,1fr)] gap-7 border-b border-white/10 py-8 max-[760px]:grid-cols-1" aria-labelledby="instances-heading">
        <div>
          <h2 id="instances-heading" class="m-0 text-[14px] font-bold text-white/78">运行实例</h2>
          <button type="button" class="mt-3 flex items-center gap-1.5 text-[10px] text-[#d2b357] hover:text-[#ecd377] disabled:opacity-45" :disabled="refreshingInstances" @click="refreshInstances(true)"><RefreshCw :size="12" :class="refreshingInstances ? 'animate-spin' : ''" aria-hidden="true" />{{ refreshingInstances ? '刷新中…' : '刷新' }}</button>
        </div>
        <div>
          <div v-if="instances.length" class="space-y-2">
            <div v-for="instance in instances" :key="instance.instanceId" class="flex items-center gap-4 border border-white/10 bg-white/[0.025] px-4 py-3">
              <span class="status-dot" data-status="connected" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="m-0 truncate text-[12px] font-semibold text-white/76">{{ instance.displayName }}</p>
                <p class="utility-font m-0 mt-1 truncate text-[9px] text-white/28">PID {{ instance.processId }} · {{ instance.gameVersion }} · {{ instance.sceneName }}</p>
              </div>
              <button type="button" class="secondary-button shrink-0" :disabled="Boolean(connectingInstanceId) || store.connectedInstanceId === instance.instanceId" @click="connect(instance)">
                <RefreshCw v-if="connectingInstanceId === instance.instanceId" :size="14" class="animate-spin" aria-hidden="true" />
                <Cable v-else :size="14" aria-hidden="true" />
                {{ store.connectedInstanceId === instance.instanceId ? '已连接' : connectingInstanceId === instance.instanceId ? '连接中…' : '连接' }}
              </button>
            </div>
          </div>
          <div v-else class="grid h-28 place-items-center border border-dashed border-white/12 text-[11px] text-white/30">没有发现运行中的 Bridge</div>
        </div>
      </section>

      <section class="grid grid-cols-[180px_minmax(0,1fr)] gap-7 py-8 max-[760px]:grid-cols-1" aria-labelledby="update-heading">
        <div>
          <h2 id="update-heading" class="m-0 text-[14px] font-bold text-white/78">应用更新</h2>
          <p class="utility-font mt-2 text-[9px] text-white/28">GITHUB RELEASES</p>
        </div>
        <div class="space-y-3">
          <div class="flex min-h-[58px] flex-wrap items-center gap-x-5 gap-y-2 border border-white/10 bg-white/[0.025] px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="m-0 break-words text-[12px] font-semibold text-white/74">{{ store.updateStatus.message }}</p>
              <p class="utility-font m-0 mt-1 text-[9px] text-white/30">
                当前 <span translate="no">v{{ store.updateStatus.currentVersion }}</span>
                <template v-if="store.updateStatus.latestVersion"> · 最新 <span translate="no">v{{ store.updateStatus.latestVersion }}</span></template>
              </p>
            </div>
            <span class="border border-white/12 px-2 py-1 text-[9px] text-white/40">{{ updatePhaseLabels[store.updateStatus.phase] }}</span>
          </div>

          <button
            v-if="store.updateStatus.phase === 'available'"
            type="button"
            class="primary-button"
            @click="store.openUpdateDownload"
          >
            <Download :size="15" aria-hidden="true" />下载便携版
          </button>
          <button
            v-else
            type="button"
            class="secondary-button"
            :disabled="store.updateStatus.phase === 'disabled' || store.updateStatus.phase === 'checking'"
            @click="store.checkForUpdates"
          >
            <RefreshCw :size="15" :class="store.updateStatus.phase === 'checking' ? 'animate-spin' : ''" aria-hidden="true" />
            {{ store.updateStatus.phase === 'checking' ? '检查中…' : '检查更新' }}
          </button>
        </div>
      </section>

      <p class="m-0 min-h-5 border-t border-white/8 pt-4 text-[11px] text-[#d7b95f]" aria-live="polite">{{ statusMessage }}</p>
    </div>
  </section>
</template>
