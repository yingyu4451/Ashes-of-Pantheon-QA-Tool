import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { GameBuildInspection, OperationResult, PackageBridgeInspection } from '../shared/contracts.js'

interface PackageBridgeMarker {
  sourcePath: string
  backend: 'mono'
  createdAt: string
  version: 1
}

interface PackageBridgeManagerOptions {
  inspectBuild: (path: string) => Promise<GameBuildInspection>
  resourceRoot: string
  storageRoot: string
}

export interface PackageBridgeManager {
  inspect: (buildPath: string) => Promise<PackageBridgeInspection>
  prepare: (buildPath: string) => Promise<OperationResult<PackageBridgeInspection>>
  launch: (buildPath: string) => Promise<OperationResult<PackageBridgeInspection>>
  remove: (buildPath: string) => Promise<OperationResult>
}

const markerName = '.ashes-qa-package-bridge.json'
const pluginFileName = 'AshesOfPantheon.QA.PackageBridge.dll'
const reservedNames = new Set(['bepinex', 'doorstop_config.ini', 'winhttp.dll', '.doorstop_version', 'changelog.txt', 'bepinex-license.txt'])

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function managedTarget(storageRoot: string, sourcePath: string): string {
  const base = resolve(storageRoot, 'package-bridge-runs')
  const identity = createHash('sha256').update(resolve(sourcePath).toLocaleLowerCase('en-US')).digest('hex').slice(0, 16)
  const target = resolve(base, identity)
  const targetRelative = relative(base, target)
  if (!targetRelative || targetRelative.startsWith('..')) throw new Error('临时 Bridge 路径超出应用数据目录。')
  return target
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  try {
    const [leftContents, rightContents] = await Promise.all([readFile(left), readFile(right)])
    if (leftContents.length !== rightContents.length) return false
    return createHash('sha256').update(leftContents).digest('hex') === createHash('sha256').update(rightContents).digest('hex')
  } catch {
    return false
  }
}

async function readMarker(target: string): Promise<PackageBridgeMarker | null> {
  try {
    const raw = await readFile(join(target, markerName), 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as PackageBridgeMarker
  } catch {
    return null
  }
}

async function assertManagedTarget(target: string, sourcePath: string): Promise<void> {
  const marker = await readMarker(target)
  if (!marker || marker.version !== 1 || !samePath(marker.sourcePath, sourcePath)) {
    throw new Error('临时目录缺少有效的 QA Bridge marker，已拒绝修改。')
  }
}

async function linkSourceEntry(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  if (info.isDirectory()) {
    await symlink(source, target, 'junction')
    return
  }
  try {
    await link(source, target)
  } catch {
    await cp(source, target, { force: false })
  }
}

export function createPackageBridgeManager(options: PackageBridgeManagerOptions): PackageBridgeManager {
  const { inspectBuild, resourceRoot, storageRoot } = options

  const inspect = async (buildPath: string): Promise<PackageBridgeInspection> => {
    const build = await inspectBuild(buildPath)
    const sourcePath = resolve(build.path)
    const temporaryPath = managedTarget(storageRoot, sourcePath)
    const marker = await readMarker(temporaryPath)
    const markerMatchesSource = Boolean(marker && marker.version === 1 && samePath(marker.sourcePath, sourcePath))
    const temporaryExecutablePath = build.executablePath ? join(temporaryPath, basename(build.executablePath)) : undefined
    const temporaryDataPath = build.dataPath ? join(temporaryPath, basename(build.dataPath)) : undefined
    const bundledPluginPath = join(resourceRoot, 'plugin', pluginFileName)
    const temporaryPluginPath = join(temporaryPath, 'BepInEx', 'plugins', pluginFileName)
    const prepared = Boolean(
      build.valid &&
      markerMatchesSource &&
      temporaryExecutablePath &&
      temporaryDataPath &&
      await exists(temporaryExecutablePath) &&
      await exists(temporaryDataPath) &&
      await exists(join(temporaryPath, 'winhttp.dll')) &&
      await filesMatch(temporaryPluginPath, bundledPluginPath)
    )
    return {
      sourcePath,
      prepared,
      temporaryPath: prepared ? temporaryPath : undefined,
      executablePath: prepared ? temporaryExecutablePath : build.executablePath,
      backend: build.backend,
      message: !build.valid
        ? build.message
        : prepared
          ? '此游戏包的临时 Bridge 副本已准备；原始游戏包未修改。'
          : markerMatchesSource
            ? '此游戏包的临时 Bridge 副本需要更新。原始游戏包不会被修改。'
          : build.backend === 'mono'
            ? '此游戏包尚未创建临时 Bridge 副本。原始游戏包不会被修改。'
            : '当前包不是受支持的 Mono 构建。'
    }
  }

  const prepare = async (buildPath: string): Promise<OperationResult<PackageBridgeInspection>> => {
    const build = await inspectBuild(buildPath)
    if (!build.valid || !build.executablePath || !build.dataPath) return { ok: false, message: build.message }
    if (build.backend !== 'mono') return { ok: false, message: '当前仅支持为 Mono 游戏包安装外部 Bridge。' }

    const sourcePath = resolve(build.path)
    if (await exists(join(sourcePath, 'winhttp.dll')) || await exists(join(sourcePath, 'BepInEx'))) {
      return { ok: false, message: '原始游戏包已包含外部加载器。请选择未修改的原始包。' }
    }
    const loaderRoot = join(resourceRoot, 'bepinex-win-x64')
    const pluginPath = join(resourceRoot, 'plugin', pluginFileName)
    if (!(await exists(join(loaderRoot, 'winhttp.dll'))) || !(await exists(pluginPath))) {
      return { ok: false, message: '应用内的打包版 Bridge 资源缺失。' }
    }

    const target = managedTarget(storageRoot, sourcePath)
    if (await exists(target)) {
      await assertManagedTarget(target, sourcePath)
      await rm(target, { recursive: true, force: false })
    }
    await mkdir(target, { recursive: true })
    const marker: PackageBridgeMarker = { sourcePath, backend: 'mono', createdAt: new Date().toISOString(), version: 1 }
    await writeFile(join(target, markerName), JSON.stringify(marker), 'utf8')

    try {
      const entries = await readdir(sourcePath, { withFileTypes: true })
      for (const entry of entries) {
        if (reservedNames.has(entry.name.toLocaleLowerCase('en-US'))) continue
        await linkSourceEntry(join(sourcePath, entry.name), join(target, entry.name))
      }
      await cp(loaderRoot, target, { recursive: true, force: false, errorOnExist: false })
      const pluginTarget = join(target, 'BepInEx', 'plugins', pluginFileName)
      await mkdir(join(target, 'BepInEx', 'plugins'), { recursive: true })
      await cp(pluginPath, pluginTarget, { force: true })
    } catch (error) {
      await assertManagedTarget(target, sourcePath)
      await rm(target, { recursive: true, force: true })
      return { ok: false, message: error instanceof Error ? error.message : '创建临时游戏副本失败。' }
    }

    const data = await inspect(sourcePath)
    return { ok: data.prepared, message: data.message, data }
  }

  const launch = async (buildPath: string): Promise<OperationResult<PackageBridgeInspection>> => {
    const data = await inspect(buildPath)
    if (!data.prepared) return { ok: false, message: '请先安装打包版 Bridge，再从临时副本启动游戏。', data }
    if (!data.temporaryPath || !data.executablePath) return { ok: false, message: '临时游戏副本尚未准备完成。' }
    const child = spawn(data.executablePath, [], { cwd: data.temporaryPath, detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, message: '已从临时副本启动游戏，正在等待 Bridge 上线。', data }
  }

  const remove = async (buildPath: string): Promise<OperationResult> => {
    const build = await inspectBuild(buildPath)
    const sourcePath = resolve(build.path)
    const target = managedTarget(storageRoot, sourcePath)
    if (!(await exists(target))) return { ok: true, message: '没有需要移除的临时 Bridge。' }
    await assertManagedTarget(target, sourcePath)
    await rm(target, { recursive: true, force: false })
    return { ok: true, message: '打包版 Bridge 临时副本已移除。' }
  }

  return { inspect, prepare, launch, remove }
}
