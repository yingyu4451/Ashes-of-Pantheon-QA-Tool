import { computed, ref, toRaw, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  CardCategory,
  BridgeInstance,
  ConnectionStatus,
  GridPoint,
  QaBattleSnapshot,
  QaCard,
  QaCardInventorySnapshot,
  QaCatalog,
  QaEntity,
  OperationResult,
  Rarity,
  UpdateStatus,
  WorkspaceId
} from '@shared/contracts'
import { demoBattle, demoCatalog } from '@/data/demo'

const clone = <T>(value: T): T => structuredClone(value)
type NoticeTone = 'info' | 'loading' | 'success' | 'error'

export const useQaStore = defineStore('qa', () => {
  const nativeMode = typeof window !== 'undefined' && Boolean(window.qaNative)
  const emptyCatalog: QaCatalog = { cards: [], equipment: [], buffs: [], blessings: [], intents: [] }
  const activeWorkspace = ref<WorkspaceId>('battle')
  const connectionStatus = ref<ConnectionStatus>(nativeMode ? 'disconnected' : 'demo')
  const connectionLabel = ref(nativeMode ? '未连接' : '演示快照')
  const connectedInstanceId = ref<string | null>(null)
  const lastOperationMessage = ref('')
  const notice = ref<{ tone: NoticeTone; message: string } | null>(null)
  const unityProjectPath = ref('')
  const gameBuildPath = ref('')
  const updateStatus = ref<UpdateStatus>({
    phase: nativeMode ? 'idle' : 'disabled',
    currentVersion: '0.1.3',
    message: nativeMode ? '尚未检查更新。' : '开发模式不检查更新。'
  })
  const runtimeReady = ref(!nativeMode)
  const catalog = ref<QaCatalog>(clone(nativeMode ? emptyCatalog : demoCatalog))
  const cardInventoryAvailable = ref(false)
  const ownedCardCounts = ref<Record<string, number>>({})
  const battle = ref<QaBattleSnapshot>(clone(demoBattle))
  const selectedEntityId = ref<string>('enemy-01#0')
  const selectedCell = ref<GridPoint | null>({ x: 1, y: -2 })
  const selectedEquipmentTypeId = ref('')
  const selectedBuffTypeId = ref('')
  const selectedBlessingTypeId = ref('')
  const selectedIntentTypeId = ref('')
  const unsafeValues = ref(false)

  const cardSearch = ref('')
  const selectedCategories = ref<CardCategory[]>([])
  const selectedCosts = ref<number[]>([])
  const selectedRarities = ref<Rarity[]>([])
  const sortKey = ref<'typeId' | 'category' | 'cost' | 'rarity'>('category')
  const sortDirection = ref<'asc' | 'desc'>('asc')
  let connectionMonitor: ReturnType<typeof setInterval> | undefined
  let updateUnsubscribe: (() => void) | undefined
  let refreshInFlight: Promise<OperationResult> | undefined
  let refreshAnnouncementRequested = false

  const selectedEntity = computed<QaEntity | null>(() => {
    if (selectedEntityId.value === battle.value.player.instanceId) {
      return {
        instanceId: battle.value.player.instanceId,
        typeId: 'MainCharacter',
        name: battle.value.player.name,
        kind: 'player',
        position: battle.value.player.position,
        currentHp: battle.value.player.currentHp,
        maxHp: battle.value.player.maxHp,
        buffs: battle.value.player.buffs
      }
    }
    return battle.value.entities.find((entity) => entity.instanceId === selectedEntityId.value) ?? null
  })

  const rarityOrder: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 }
  const categoryOrder: Record<CardCategory, number> = { equipment: 0, placement: 1, directional: 2, target: 3, effect: 4 }

  const filteredCards = computed<QaCard[]>(() => {
    const query = cardSearch.value.trim().toLocaleLowerCase('zh-CN')
    const cards = catalog.value.cards.filter((card) => {
      const matchesSearch = !query || `${card.name} ${card.typeId} ${card.description} ${card.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(query)
      const matchesCategory = selectedCategories.value.length === 0 || selectedCategories.value.includes(card.category)
      const matchesCost = selectedCosts.value.length === 0 || selectedCosts.value.includes(card.cost)
      const matchesRarity = selectedRarities.value.length === 0 || selectedRarities.value.includes(card.rarity)
      return matchesSearch && matchesCategory && matchesCost && matchesRarity
    })
    const multiplier = sortDirection.value === 'asc' ? 1 : -1
    return cards.sort((left, right) => {
      if (sortKey.value === 'typeId') return left.typeId.localeCompare(right.typeId, 'en', { numeric: true, sensitivity: 'base' }) * multiplier
      if (sortKey.value === 'cost') return (left.cost - right.cost) * multiplier
      if (sortKey.value === 'rarity') return (rarityOrder[left.rarity] - rarityOrder[right.rarity]) * multiplier
      return (categoryOrder[left.category] - categoryOrder[right.category]) * multiplier
    })
  })

  const activeFilterCount = computed(() => selectedCategories.value.length + selectedCosts.value.length + selectedRarities.value.length)

  function reconcileSelection(current: string, entries: Array<{ typeId: string }>): string {
    return entries.some((entry) => entry.typeId === current) ? current : (entries[0]?.typeId ?? '')
  }

  watch(() => catalog.value.equipment, (entries) => {
    selectedEquipmentTypeId.value = reconcileSelection(selectedEquipmentTypeId.value, entries)
  }, { immediate: true })
  watch(() => catalog.value.buffs, (entries) => {
    selectedBuffTypeId.value = reconcileSelection(selectedBuffTypeId.value, entries)
  }, { immediate: true })
  watch(() => catalog.value.blessings, (entries) => {
    selectedBlessingTypeId.value = reconcileSelection(selectedBlessingTypeId.value, entries)
  }, { immediate: true })
  watch(() => catalog.value.intents, (entries) => {
    selectedIntentTypeId.value = reconcileSelection(selectedIntentTypeId.value, entries)
  }, { immediate: true })

  function showNotice(message: string, tone: NoticeTone = 'info'): void {
    lastOperationMessage.value = message
    notice.value = { tone, message }
  }

  function clearNotice(): void {
    notice.value = null
  }

  function markDisconnected(message = 'Unity Editor 连接已断开。'): void {
    if (connectionMonitor) clearInterval(connectionMonitor)
    connectionMonitor = undefined
    connectedInstanceId.value = null
    connectionStatus.value = 'disconnected'
    runtimeReady.value = false
    cardInventoryAvailable.value = false
    ownedCardCounts.value = {}
    connectionLabel.value = catalog.value.cards.length ? '离线目录' : '未连接'
    showNotice(message, 'error')
  }

  function startConnectionMonitor(): void {
    if (!window.qaNative) return
    if (connectionMonitor) clearInterval(connectionMonitor)
    connectionMonitor = setInterval(async () => {
      const instanceId = connectedInstanceId.value
      if (!instanceId || !window.qaNative) return
      const instances = await window.qaNative.listBridgeInstances()
      if (!instances.some((instance) => instance.instanceId === instanceId)) markDisconnected()
    }, 2000)
  }

  function clearFilters(): void {
    selectedCategories.value = []
    selectedCosts.value = []
    selectedRarities.value = []
  }

  function selectEntity(entityId: string): void {
    selectedEntityId.value = entityId
  }

  function selectCell(point: GridPoint): void {
    selectedCell.value = point
  }

  async function placeEquipment(): Promise<boolean> {
    const point = selectedCell.value
    const item = catalog.value.equipment.find((entry) => entry.typeId === selectedEquipmentTypeId.value)
    if (!point || !item) return false
    if (connectionStatus.value === 'connected') {
      const result = await executeGm(`/spawnEquipment ${item.typeId} ${point.x} ${point.y}`)
      if (result.ok) await refreshRuntime()
      return result.ok
    }
    const occupied = battle.value.entities.some((entity) => entity.position.x === point.x && entity.position.y === point.y)
      || (battle.value.player.position.x === point.x && battle.value.player.position.y === point.y)
    if (occupied) return false
    battle.value.entities.push({
      instanceId: `equipment-${Date.now()}`,
      typeId: item.typeId,
      name: item.name,
      kind: 'equipment',
      position: point,
      buffs: []
    })
    return true
  }

  async function connectToInstance(instance: BridgeInstance): Promise<OperationResult> {
    if (!window.qaNative) return { ok: false, message: 'Bridge 连接仅在 Electron 应用中可用。' }
    if (connectionMonitor) clearInterval(connectionMonitor)
    connectionMonitor = undefined
    connectedInstanceId.value = null
    connectionStatus.value = 'connecting'
    runtimeReady.value = false
    cardInventoryAvailable.value = false
    ownedCardCounts.value = {}
    showNotice(`正在连接 ${instance.displayName}…`, 'loading')
    const connection = await window.qaNative.connectBridge(instance.instanceId)
    if (!connection.ok) {
      connectionStatus.value = 'disconnected'
      runtimeReady.value = false
      showNotice(connection.message, 'error')
      return { ok: false, message: connection.message }
    }

    connectedInstanceId.value = instance.instanceId
    const [catalogResult, battleResult, cardInventoryResult] = await Promise.all([
      window.qaNative.requestBridge<QaCatalog>({ instanceId: instance.instanceId, method: 'GET', path: '/api/catalog' }),
      window.qaNative.requestBridge<QaBattleSnapshot>({ instanceId: instance.instanceId, method: 'GET', path: '/api/battle' }),
      window.qaNative.requestBridge<QaCardInventorySnapshot>({ instanceId: instance.instanceId, method: 'GET', path: '/api/cards' })
    ])
    if (!catalogResult.ok || !catalogResult.data) {
      connectedInstanceId.value = null
      connectionStatus.value = 'disconnected'
      runtimeReady.value = false
      cardInventoryAvailable.value = false
      ownedCardCounts.value = {}
      const message = catalogResult.message
      showNotice(message, 'error')
      return { ok: false, message }
    }

    catalog.value = catalogResult.data
    applyCardInventorySnapshot(cardInventoryResult.data)
    connectionStatus.value = 'connected'
    runtimeReady.value = Boolean(battleResult.ok && battleResult.data && battleResult.data.available !== false)
    if (runtimeReady.value && battleResult.data) battle.value = battleResult.data
    connectionLabel.value = instance.displayName
    startConnectionMonitor()
    const message = runtimeReady.value ? '目录与战斗状态已同步。' : '卡牌目录已同步；进入 Play Mode 后可读取战斗状态。'
    let cacheResult: OperationResult
    try {
      cacheResult = await window.qaNative.writeCatalogCache(clone(toRaw(catalog.value)))
    } catch (error) {
      cacheResult = { ok: false, message: error instanceof Error ? error.message : '目录缓存写入失败。' }
    }
    showNotice(cacheResult.ok ? message : `${message} 但离线缓存写入失败：${cacheResult.message}`, cacheResult.ok ? 'success' : 'error')
    return { ok: true, message: lastOperationMessage.value }
  }

  async function performRuntimeRefresh(): Promise<OperationResult> {
    if (!window.qaNative || !connectedInstanceId.value) {
      const result = {
        ok: connectionStatus.value === 'demo',
        message: connectionStatus.value === 'demo' ? '演示快照无需刷新。' : '没有已连接的运行实例。'
      }
      if (refreshAnnouncementRequested) showNotice(result.message, result.ok ? 'info' : 'error')
      return result
    }

    const instanceId = connectedInstanceId.value
    const [catalogResult, battleResult, cardInventoryResult] = await Promise.all([
      window.qaNative.requestBridge<QaCatalog>({ instanceId, method: 'GET', path: '/api/catalog' }),
      window.qaNative.requestBridge<QaBattleSnapshot>({ instanceId, method: 'GET', path: '/api/battle' }),
      window.qaNative.requestBridge<QaCardInventorySnapshot>({ instanceId, method: 'GET', path: '/api/cards' })
    ])
    if (connectedInstanceId.value !== instanceId) return { ok: false, message: '刷新期间运行实例已切换。' }

    if (catalogResult.ok && catalogResult.data) {
      catalog.value = catalogResult.data
      try {
        await window.qaNative.writeCatalogCache(clone(toRaw(catalog.value)))
      } catch {
        // The live catalog remains usable even when its offline cache cannot be updated.
      }
    }
    if (cardInventoryResult.ok) applyCardInventorySnapshot(cardInventoryResult.data)

    if (battleResult.ok && battleResult.data) {
      runtimeReady.value = battleResult.data.available !== false
      if (runtimeReady.value) battle.value = battleResult.data
    } else {
      runtimeReady.value = false
    }

    const ok = Boolean(catalogResult.ok && catalogResult.data && battleResult.ok && battleResult.data && cardInventoryResult.ok && cardInventoryResult.data)
    const message = !catalogResult.ok || !catalogResult.data
      ? `目录刷新失败：${catalogResult.message}`
      : !battleResult.ok || !battleResult.data
        ? `战斗数据刷新失败：${battleResult.message}`
        : !cardInventoryResult.ok || !cardInventoryResult.data
          ? `持有卡牌刷新失败：${cardInventoryResult.message}`
        : runtimeReady.value
          ? '目录与战斗数据已刷新。'
          : '目录已刷新；当前没有可用的战斗数据。'
    if (refreshAnnouncementRequested) showNotice(message, ok ? 'success' : 'error')
    return { ok, message }
  }

  function refreshRuntime(announce = true): Promise<OperationResult> {
    if (announce) refreshAnnouncementRequested = true
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = performRuntimeRefresh().finally(() => {
      refreshInFlight = undefined
      refreshAnnouncementRequested = false
    })
    return refreshInFlight
  }

  function applyCardInventorySnapshot(snapshot?: QaCardInventorySnapshot): void {
    const cards = snapshot?.available && Array.isArray(snapshot.cards) ? snapshot.cards : null
    cardInventoryAvailable.value = Boolean(cards)
    ownedCardCounts.value = cards
      ? Object.fromEntries(cards.filter((card) => card.count > 0).map((card) => [card.typeId, card.count]))
      : {}
  }

  async function mutateOwnedCard(typeId: string, method: 'POST' | 'DELETE'): Promise<OperationResult> {
    if (!window.qaNative || !connectedInstanceId.value || !cardInventoryAvailable.value) {
      const operation = { ok: false, message: '当前没有可操作的运行时卡牌库存。请先进入游戏并连接 Bridge。' }
      showNotice(operation.message, 'error')
      return operation
    }
    if (refreshInFlight) await refreshInFlight
    const result = await window.qaNative.requestBridge<{ success: boolean; message: string }>({
      instanceId: connectedInstanceId.value,
      method,
      path: '/api/cards',
      body: { typeId }
    })
    const operation = {
      ok: Boolean(result.ok && result.data?.success),
      message: result.data?.message ?? result.message
    }
    if (operation.ok) await refreshRuntime(false)
    showNotice(operation.message, operation.ok ? 'success' : 'error')
    return operation
  }

  function addOwnedCard(typeId: string): Promise<OperationResult> {
    return mutateOwnedCard(typeId, 'POST')
  }

  function removeOwnedCard(typeId: string): Promise<OperationResult> {
    if ((ownedCardCounts.value[typeId] ?? 0) <= 0) {
      const operation = { ok: false, message: `没有可删除的卡牌：${typeId}` }
      showNotice(operation.message, 'error')
      return Promise.resolve(operation)
    }
    return mutateOwnedCard(typeId, 'DELETE')
  }

  async function executeGm(command: string): Promise<OperationResult> {
    if (!window.qaNative || !connectedInstanceId.value) return { ok: false, message: '没有已连接的运行实例。' }
    const result = await window.qaNative.requestBridge<{ success: boolean; message: string }>({
      instanceId: connectedInstanceId.value,
      method: 'POST',
      path: '/api/gm',
      body: { command }
    })
    const operation = {
      ok: Boolean(result.ok && result.data?.success),
      message: result.data?.message ?? result.message
    }
    showNotice(operation.message, operation.ok ? 'success' : 'error')
    return operation
  }

  async function requestMutation(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<OperationResult> {
    if (connectionStatus.value === 'demo') return { ok: true, message: '演示快照已更新。' }
    if (!window.qaNative || !connectedInstanceId.value) return { ok: false, message: '没有已连接的运行实例。' }
    const result = await window.qaNative.requestBridge<{ success: boolean; message: string }>({
      instanceId: connectedInstanceId.value,
      method,
      path,
      body
    })
    const operation = {
      ok: Boolean(result.ok && result.data?.success),
      message: result.data?.message ?? result.message
    }
    showNotice(operation.message, operation.ok ? 'success' : 'error')
    if (operation.ok) await refreshRuntime()
    return operation
  }

  function applyPlayer(): Promise<OperationResult> {
    const player = battle.value.player
    return requestMutation('/api/player', 'POST', {
      currentHp: player.currentHp,
      maxHp: player.maxHp,
      currentCost: player.currentCost,
      maxCost: player.maxCost,
      unsafe: unsafeValues.value
    })
  }

  function applyEnemy(enemy: QaEntity): Promise<OperationResult> {
    return requestMutation('/api/enemy', 'POST', {
      instanceId: enemy.instanceId,
      currentHp: enemy.currentHp,
      maxHp: enemy.maxHp,
      attack: enemy.attack,
      unsafe: unsafeValues.value
    })
  }

  function addBuff(targetInstanceId: string, typeId: string, stacks: number, duration: number): Promise<OperationResult> {
    return requestMutation('/api/buffs', 'POST', { targetInstanceId, typeId, stacks, duration })
  }

  function removeBuff(targetInstanceId: string, instanceId: string): Promise<OperationResult> {
    return requestMutation('/api/buffs', 'DELETE', { targetInstanceId, instanceId })
  }

  function addBlessing(typeId: string): Promise<OperationResult> {
    return requestMutation('/api/blessings', 'POST', { typeId })
  }

  function removeBlessing(typeId: string): Promise<OperationResult> {
    return requestMutation('/api/blessings', 'DELETE', { typeId })
  }

  function applyIntents(enemy: QaEntity): Promise<OperationResult> {
    return requestMutation('/api/intents', 'POST', {
      instanceId: enemy.instanceId,
      loopStartIndex: enemy.loopStartIndex ?? -1,
      steps: enemy.intents?.map((intent) => ({ typeId: intent.typeId, parameters: intent.parameters })) ?? []
    })
  }

  async function initialize(): Promise<void> {
    if (!window.qaNative) return
    const [cached, preferences, initialUpdateStatus] = await Promise.all([
      window.qaNative.readCatalogCache(),
      window.qaNative.readPreferences(),
      window.qaNative.getUpdateStatus()
    ])
    catalog.value = cached ?? clone(emptyCatalog)
    unityProjectPath.value = preferences.unityProjectPath
    gameBuildPath.value = preferences.gameBuildPath
    updateStatus.value = initialUpdateStatus
    if (!updateUnsubscribe) {
      updateUnsubscribe = window.qaNative.onUpdateStatus((status) => {
        updateStatus.value = status
        if (status.phase === 'available' || status.phase === 'downloaded') showNotice(status.message, 'success')
        if (status.phase === 'error') showNotice(status.message, 'error')
      })
    }
    runtimeReady.value = false
    connectionStatus.value = 'disconnected'
    connectionLabel.value = cached ? '离线目录' : '未连接'
    activeWorkspace.value = cached ? 'cards' : 'setup'
  }

  async function rememberPaths(paths: { unityProjectPath?: string; gameBuildPath?: string }): Promise<OperationResult> {
    if (paths.unityProjectPath !== undefined) unityProjectPath.value = paths.unityProjectPath
    if (paths.gameBuildPath !== undefined) gameBuildPath.value = paths.gameBuildPath
    if (!window.qaNative) return { ok: false, message: '路径保存仅在 Electron 应用中可用。' }
    const result = await window.qaNative.writePreferences({
      unityProjectPath: unityProjectPath.value,
      gameBuildPath: gameBuildPath.value
    })
    if (!result.ok) lastOperationMessage.value = result.message
    return result
  }

  async function checkForUpdates(): Promise<OperationResult<UpdateStatus>> {
    if (!window.qaNative) return { ok: false, message: '更新检查仅在 Electron 应用中可用。' }
    const result = await window.qaNative.checkForUpdates()
    if (result.data) updateStatus.value = result.data
    showNotice(result.message, result.ok ? 'info' : updateStatus.value.phase === 'disabled' ? 'info' : 'error')
    return result
  }

  async function openUpdateDownload(): Promise<OperationResult<UpdateStatus>> {
    if (!window.qaNative) return { ok: false, message: '便携版下载仅在 Electron 应用中可用。' }
    const result = await window.qaNative.openUpdateDownload()
    showNotice(result.message, result.ok ? 'info' : 'error')
    return result
  }

  return {
    activeWorkspace,
    connectionStatus,
    connectionLabel,
    runtimeReady,
    connectedInstanceId,
    lastOperationMessage,
    notice,
    unityProjectPath,
    gameBuildPath,
    updateStatus,
    catalog,
    cardInventoryAvailable,
    ownedCardCounts,
    battle,
    selectedEntityId,
    selectedEntity,
    selectedCell,
    selectedEquipmentTypeId,
    selectedBuffTypeId,
    selectedBlessingTypeId,
    selectedIntentTypeId,
    unsafeValues,
    cardSearch,
    selectedCategories,
    selectedCosts,
    selectedRarities,
    sortKey,
    sortDirection,
    filteredCards,
    activeFilterCount,
    clearFilters,
    showNotice,
    clearNotice,
    markDisconnected,
    selectEntity,
    selectCell,
    placeEquipment,
    connectToInstance,
    refreshRuntime,
    addOwnedCard,
    removeOwnedCard,
    executeGm,
    applyPlayer,
    applyEnemy,
    addBuff,
    removeBuff,
    addBlessing,
    removeBlessing,
    applyIntents,
    rememberPaths,
    checkForUpdates,
    openUpdateDownload,
    initialize
  }
})
