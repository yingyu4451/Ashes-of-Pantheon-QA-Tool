import { existsSync } from 'node:fs'
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, normalize, relative, resolve } from 'node:path'
import { app, dialog, ipcMain } from 'electron'
import { createPackageBridgeManager } from './packageBridge.js'
import type {
  BridgeInstance,
  BridgeRequest,
  GameBuildInspection,
  OperationResult,
  QaCatalog,
  QaPreferences,
  UnityProjectInspection
} from '../shared/contracts.js'

const bridgePackageName = 'com.ashes-of-pantheon.qa-bridge'
const connectedInstances = new Map<string, BridgeInstance & { token: string }>()

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function resolveBundledBridgePath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'unity-package', bridgePackageName)]
    : [
        join(process.cwd(), 'resources', 'unity-package', bridgePackageName),
        join(app.getAppPath(), 'resources', 'unity-package', bridgePackageName)
      ]
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json'))) ?? candidates[0]!
}

function resolvePackageBridgeResourcePath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'package-bridge')]
    : [join(process.cwd(), 'resources', 'package-bridge'), join(app.getAppPath(), 'resources', 'package-bridge')]
  return candidates.find((candidate) => existsSync(join(candidate, 'bepinex-win-x64', 'winhttp.dll'))) ?? candidates[0]!
}

async function assertUnityProject(projectPath: string): Promise<string> {
  const root = resolve(projectPath)
  const required = [join(root, 'Assets'), join(root, 'Packages'), join(root, 'ProjectSettings', 'ProjectVersion.txt')]
  if (!(await Promise.all(required.map(exists))).every(Boolean)) {
    throw new Error('所选目录不是有效的 Unity 项目。')
  }
  return root
}

function resolveBridgeTarget(projectRoot: string): string {
  const target = resolve(projectRoot, 'Packages', bridgePackageName)
  const targetRelative = relative(projectRoot, target)
  if (targetRelative.startsWith('..') || targetRelative === '') {
    throw new Error('Bridge 安装路径超出 Unity 项目。')
  }
  return target
}

async function inspectUnityProject(projectPath: string): Promise<UnityProjectInspection> {
  try {
    const root = await assertUnityProject(projectPath)
    const versionText = await readFile(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
    const version = versionText.match(/m_EditorVersion:\s*(.+)/)?.[1]?.trim()
    const target = resolveBridgeTarget(root)
    return {
      path: root,
      valid: true,
      unityVersion: version,
      bridgeInstalled: await exists(join(target, 'package.json')),
      message: 'Unity 项目可用'
    }
  } catch (error) {
    return {
      path: normalize(projectPath),
      valid: false,
      bridgeInstalled: false,
      message: error instanceof Error ? error.message : '无法检查 Unity 项目。'
    }
  }
}

async function installEditorBridge(projectPath: string): Promise<OperationResult> {
  try {
    const root = await assertUnityProject(projectPath)
    const source = resolveBundledBridgePath()
    const target = resolveBridgeTarget(root)
    if (!(await exists(join(source, 'package.json')))) throw new Error(`应用内的 Unity Bridge 包缺失：${source}`)
    if (await exists(target)) {
      const installedManifestPath = join(target, 'package.json')
      if (!(await exists(installedManifestPath))) throw new Error('Bridge 目标目录已存在，但缺少 package.json。')
      const installedManifest = JSON.parse((await readFile(installedManifestPath, 'utf8')).replace(/^\uFEFF/, '')) as { name?: string }
      if (installedManifest.name !== bridgePackageName) throw new Error('Bridge 目标目录属于其他包，已取消更新。')
      await cp(source, target, { recursive: true, force: true })
      await rm(cachePath(), { force: true })
      return { ok: true, message: 'Editor Bridge 已更新。重新聚焦 Unity，等待脚本编译完成。' }
    }
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await rm(cachePath(), { force: true })
    return { ok: true, message: 'Editor Bridge 已安装。重新聚焦 Unity，等待脚本编译完成。' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Bridge 安装失败。' }
  }
}

async function uninstallEditorBridge(projectPath: string): Promise<OperationResult> {
  try {
    const root = await assertUnityProject(projectPath)
    const target = resolveBridgeTarget(root)
    const manifestPath = join(target, 'package.json')
    if (!(await exists(manifestPath))) return { ok: true, message: 'Bridge 未安装。' }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
    if (manifest.name !== bridgePackageName) throw new Error('目标目录不是 Ashes of Pantheon QA Bridge，已取消卸载。')
    await rm(target, { recursive: true, force: false })
    return { ok: true, message: 'Editor Bridge 已卸载。' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Bridge 卸载失败。' }
  }
}

async function inspectGameBuild(buildPath: string): Promise<GameBuildInspection> {
  try {
    const root = resolve(buildPath)
    const info = await stat(root)
    const folder = info.isDirectory() ? root : resolve(root, '..')
    const entries = await readdir(folder, { withFileTypes: true })
    const executableCandidates = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => join(folder, entry.name))
    const detectedExecutable = (await Promise.all(executableCandidates.map(async (candidate) => {
      const name = candidate.slice(candidate.lastIndexOf('\\') + 1, -4)
      return await exists(join(folder, `${name}_Data`)) ? candidate : null
    }))).find((candidate): candidate is string => Boolean(candidate))
    const executable = info.isFile() && root.toLowerCase().endsWith('.exe') ? root : (detectedExecutable ?? '')
    if (!executable || !(await exists(executable))) throw new Error('目录中没有找到游戏 exe。')
    const executableName = executable.slice(executable.lastIndexOf('\\') + 1, -4)
    const dataPath = join(folder, `${executableName}_Data`)
    if (!(await exists(dataPath))) throw new Error('没有找到与 exe 对应的 Unity Data 目录。')
    const hasIl2Cpp = await exists(join(folder, 'GameAssembly.dll'))
    const hasMono = await exists(join(folder, 'MonoBleedingEdge')) || await exists(join(dataPath, 'Managed'))
    const backend = hasIl2Cpp ? 'il2cpp' : hasMono ? 'mono' : 'unknown'
    return {
      path: folder,
      valid: backend !== 'unknown',
      executablePath: executable,
      backend,
      dataPath,
      message: backend === 'unknown' ? '无法识别 Unity 脚本后端。' : `已识别 ${backend.toUpperCase()} 包。`
    }
  } catch (error) {
    return {
      path: normalize(buildPath),
      valid: false,
      backend: 'unknown',
      message: error instanceof Error ? error.message : '无法检查游戏包。'
    }
  }
}

function instanceDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA ?? app.getPath('userData')
  return join(localAppData, 'AshesOfPantheonQA', 'instances')
}

async function readInstanceFiles(includeToken = false): Promise<Array<BridgeInstance & { token?: string }>> {
  const directory = instanceDirectory()
  if (!(await exists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const instances: Array<BridgeInstance & { token?: string }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(directory, entry.name), 'utf8')
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as BridgeInstance & { token?: string }
      if (!parsed.instanceId || !parsed.port || !parsed.token) continue
      const heartbeatAge = Date.now() - Date.parse(parsed.lastSeenAt)
      if (!Number.isFinite(heartbeatAge) || heartbeatAge > 10_000) continue
      instances.push(includeToken ? parsed : { ...parsed, token: undefined })
    } catch {
      // A partially written rendezvous file is ignored until the next refresh.
    }
  }
  return instances.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
}

async function connectBridge(instanceId: string): Promise<OperationResult<BridgeInstance>> {
  const instance = (await readInstanceFiles(true)).find((item) => item.instanceId === instanceId)
  if (!instance?.token) return { ok: false, message: '运行实例已离线。' }
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/status`, {
      headers: { Authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(2500)
    })
    if (!response.ok) throw new Error(`Bridge 返回 ${response.status}`)
    connectedInstances.set(instanceId, { ...instance, token: instance.token })
    const { token: _token, ...publicInstance } = instance
    return { ok: true, message: '已连接运行实例。', data: publicInstance }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Bridge 连接失败。' }
  }
}

async function requestBridge<T>(request: BridgeRequest): Promise<OperationResult<T>> {
  const instance = connectedInstances.get(request.instanceId)
  if (!instance) return { ok: false, message: '请先连接运行实例。' }
  if (!request.path.startsWith('/api/')) return { ok: false, message: 'Bridge 请求路径无效。' }
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${instance.token}`,
        'Content-Type': 'application/json'
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(5000)
    })
    const responseText = await response.text()
    let payload: T | string | undefined
    try {
      payload = responseText ? JSON.parse(responseText) as T : undefined
    } catch {
      payload = responseText
    }
    if (!response.ok) {
      const detail = typeof payload === 'string'
        ? payload
        : payload && typeof payload === 'object'
          ? String((payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error ?? '')
          : ''
      return { ok: false, message: detail || `Bridge 返回 ${response.status}` }
    }
    return { ok: true, message: '操作完成。', data: payload as T }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Bridge 请求失败。' }
  }
}

function cachePath(): string {
  return join(storageRoot(), 'catalog-cache.json')
}

function storageRoot(): string {
  return process.env.ASHES_OF_PANTHEON_QA_USER_DATA_DIR || app.getPath('userData')
}

function preferencesPath(): string {
  return join(storageRoot(), 'preferences.json')
}

async function readPreferences(): Promise<QaPreferences> {
  if (!(await exists(preferencesPath()))) return { unityProjectPath: '', gameBuildPath: '' }
  try {
    const parsed = JSON.parse((await readFile(preferencesPath(), 'utf8')).replace(/^\uFEFF/, '')) as Partial<QaPreferences>
    return {
      unityProjectPath: typeof parsed.unityProjectPath === 'string' ? parsed.unityProjectPath : '',
      gameBuildPath: typeof parsed.gameBuildPath === 'string' ? parsed.gameBuildPath : ''
    }
  } catch {
    return { unityProjectPath: '', gameBuildPath: '' }
  }
}

async function writePreferences(preferences: QaPreferences): Promise<OperationResult> {
  try {
    const normalized: QaPreferences = {
      unityProjectPath: typeof preferences?.unityProjectPath === 'string' && preferences.unityProjectPath.trim()
        ? normalize(preferences.unityProjectPath)
        : '',
      gameBuildPath: typeof preferences?.gameBuildPath === 'string' && preferences.gameBuildPath.trim()
        ? normalize(preferences.gameBuildPath)
        : ''
    }
    await mkdir(storageRoot(), { recursive: true })
    await writeFile(preferencesPath(), JSON.stringify(normalized), 'utf8')
    return { ok: true, message: '路径设置已保存。' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '路径设置保存失败。' }
  }
}

export function registerIpcHandlers(): void {
  const packageBridge = createPackageBridgeManager({
    inspectBuild: inspectGameBuild,
    resourceRoot: resolvePackageBridgeResourcePath(),
    storageRoot: storageRoot()
  })
  ipcMain.handle('dialog:select-directory', async (_event, title: string) => {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('project:inspect', (_event, projectPath: string) => inspectUnityProject(projectPath))
  ipcMain.handle('project:install-bridge', (_event, projectPath: string) => installEditorBridge(projectPath))
  ipcMain.handle('project:uninstall-bridge', (_event, projectPath: string) => uninstallEditorBridge(projectPath))
  ipcMain.handle('build:inspect', (_event, buildPath: string) => inspectGameBuild(buildPath))
  ipcMain.handle('package-bridge:inspect', (_event, buildPath: string) => packageBridge.inspect(buildPath))
  ipcMain.handle('package-bridge:prepare', (_event, buildPath: string) => packageBridge.prepare(buildPath))
  ipcMain.handle('package-bridge:launch', (_event, buildPath: string) => packageBridge.launch(buildPath))
  ipcMain.handle('package-bridge:remove', (_event, buildPath: string) => packageBridge.remove(buildPath))
  ipcMain.handle('bridge:list', async () => (await readInstanceFiles(false)) as BridgeInstance[])
  ipcMain.handle('bridge:connect', (_event, instanceId: string) => connectBridge(instanceId))
  ipcMain.handle('bridge:request', <T>(_event: Electron.IpcMainInvokeEvent, request: BridgeRequest) => requestBridge<T>(request))
  ipcMain.handle('cache:read-catalog', async () => {
    if (!(await exists(cachePath()))) return null
    try {
      return JSON.parse(await readFile(cachePath(), 'utf8')) as QaCatalog
    } catch {
      return null
    }
  })
  ipcMain.handle('cache:write-catalog', async (_event, catalog: QaCatalog): Promise<OperationResult> => {
    try {
      await mkdir(storageRoot(), { recursive: true })
      await writeFile(cachePath(), JSON.stringify(catalog), 'utf8')
      return { ok: true, message: '卡牌目录缓存已更新。' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '目录缓存写入失败。' }
    }
  })
  ipcMain.handle('preferences:read', () => readPreferences())
  ipcMain.handle('preferences:write', (_event, preferences: QaPreferences) => writePreferences(preferences))
}
