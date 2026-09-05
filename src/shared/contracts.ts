export type WorkspaceId = 'cards' | 'battle' | 'player' | 'setup'
export type ConnectionKind = 'editor' | 'package'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'demo'
export type CardCategory = 'equipment' | 'placement' | 'directional' | 'target' | 'effect'
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
export type EntityKind = 'player' | 'enemy' | 'equipment'
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface GridPoint {
  x: number
  y: number
}

export interface QaCard {
  typeId: string
  name: string
  description: string
  category: CardCategory
  cost: number
  rarity: Rarity
  tags: string[]
  imageUrl?: string
  frameVariant?: number
}

export interface QaBuff {
  instanceId: string
  typeId: string
  name: string
  stacks: number
  remainingTurns?: number
  description: string
}

export interface QaBlessing {
  typeId: string
  name: string
  description: string
}

export interface QaIntentStep {
  instanceId: string
  typeId: string
  name: string
  summary: string
  parameters: Record<string, string | number | boolean>
}

export interface QaEntity {
  instanceId: string
  typeId: string
  name: string
  kind: EntityKind
  position: GridPoint
  currentHp?: number
  maxHp?: number
  attack?: number
  buffs: QaBuff[]
  intents?: QaIntentStep[]
  loopStartIndex?: number
}

export interface QaPlayerState {
  instanceId: string
  name: string
  position: GridPoint
  currentHp: number
  maxHp: number
  currentCost: number
  maxCost: number
  blessings: QaBlessing[]
  buffs: QaBuff[]
}

export interface QaBattleSnapshot {
  available?: boolean
  sceneName: string
  mapName: string
  width: number
  height: number
  turn: number
  phase: string
  player: QaPlayerState
  entities: QaEntity[]
}

export interface QaCatalog {
  cards: QaCard[]
  equipment: Array<{ typeId: string; name: string }>
  buffs: Array<{ typeId: string; name: string; description: string; supportsStacks: boolean; supportsDuration: boolean }>
  blessings: Array<{ typeId: string; name: string; description: string }>
  intents: Array<{ typeId: string; name: string; description: string; parameters: string[] }>
}

export interface QaCardInventorySnapshot {
  available: boolean
  cards: Array<{ typeId: string; count: number }>
}

export interface UnityProjectInspection {
  path: string
  valid: boolean
  unityVersion?: string
  bridgeInstalled: boolean
  message: string
}

export interface GameBuildInspection {
  path: string
  valid: boolean
  executablePath?: string
  backend?: 'mono' | 'il2cpp' | 'unknown'
  dataPath?: string
  message: string
}

export interface PackageBridgeInspection {
  sourcePath: string
  prepared: boolean
  temporaryPath?: string
  executablePath?: string
  backend?: 'mono' | 'il2cpp' | 'unknown'
  message: string
}

export interface BridgeInstance {
  instanceId: string
  kind: ConnectionKind
  processId: number
  displayName: string
  gameVersion: string
  sceneName: string
  port: number
  lastSeenAt: string
}

export interface OperationResult<T = undefined> {
  ok: boolean
  message: string
  data?: T
}

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  latestVersion?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  message: string
}

export interface QaPreferences {
  unityProjectPath: string
  gameBuildPath: string
}

export interface BridgeRequest {
  instanceId: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
}

export interface QaNativeApi {
  selectDirectory: (title: string) => Promise<string | null>
  inspectUnityProject: (projectPath: string) => Promise<UnityProjectInspection>
  installEditorBridge: (projectPath: string) => Promise<OperationResult>
  uninstallEditorBridge: (projectPath: string) => Promise<OperationResult>
  inspectGameBuild: (buildPath: string) => Promise<GameBuildInspection>
  inspectPackageBridge: (buildPath: string) => Promise<PackageBridgeInspection>
  preparePackageBridge: (buildPath: string) => Promise<OperationResult<PackageBridgeInspection>>
  launchPackageBridge: (buildPath: string) => Promise<OperationResult<PackageBridgeInspection>>
  removePackageBridge: (buildPath: string) => Promise<OperationResult>
  listBridgeInstances: () => Promise<BridgeInstance[]>
  connectBridge: (instanceId: string) => Promise<OperationResult<BridgeInstance>>
  requestBridge: <T>(request: BridgeRequest) => Promise<OperationResult<T>>
  readCatalogCache: () => Promise<QaCatalog | null>
  writeCatalogCache: (catalog: QaCatalog) => Promise<OperationResult>
  readPreferences: () => Promise<QaPreferences>
  writePreferences: (preferences: QaPreferences) => Promise<OperationResult>
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<OperationResult<UpdateStatus>>
  openUpdateDownload: () => Promise<OperationResult<UpdateStatus>>
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void
}
