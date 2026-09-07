import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain, net } from 'electron'
import type { UpdateStatus } from '../shared/contracts.js'
import { createUpdateCoordinator, type UpdateProgress } from './updateCoordinator.js'
import { stagePortableUpdate, validateRelease, type PortableRelease, type StagedUpdate, type UpdateAsset } from './portableArchive.js'

const repository = 'yingyu4451/Ashes-of-Pantheon-QA-Tool'
const updateStatusChannel = 'update:status'
const releasesApiUrl = `https://api.github.com/repos/${repository}/releases/latest`
const assetUrl = (version: string, name: string): string => `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`

function broadcast(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(updateStatusChannel, status)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ashes-of-Pantheon-QA-Tool' },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`GitHub 更新检查失败：${response.status}`)
  const text = await response.text()
  if (text.length > 4 * 1024 ** 2) throw new Error('更新清单过大。')
  return JSON.parse(text)
}

async function getLatestRelease(): Promise<PortableRelease> {
  const release = await fetchJson(releasesApiUrl) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string }> }
  const version = release.tag_name?.replace(/^v/, '') ?? ''
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.draft || release.prerelease) throw new Error('GitHub 正式版本无效。')
  if (!release.assets?.some((asset) => asset.name === 'update.json')) throw new Error('该版本没有 ZIP 更新清单。请从 GitHub Releases 下载完整 ZIP。')
  const index = validateRelease(await fetchJson(assetUrl(version, 'update.json')) as PortableRelease)
  if (index.version !== version || ![index.full, ...index.deltas].every((asset) => release.assets?.some((item) => item.name === asset.name))) throw new Error('GitHub ZIP 发布文件不完整。')
  return index
}

async function downloadAsset(version: string, asset: UpdateAsset, mode: 'full' | 'delta', progress: (value: UpdateProgress) => void): Promise<Uint8Array> {
  const response = await net.fetch(assetUrl(version, asset.name), { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`ZIP 下载失败：${response.status}`)
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  let transferred = 0
  let notified = 0
  const started = Date.now()
  progress({ mode, percent: 0, transferred: 0, total: asset.size })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      transferred += value.length
      if (transferred > asset.size) throw new Error('ZIP 下载大小超出清单，已停止。')
      chunks.push(value)
      if (Date.now() - notified > 150 || transferred === asset.size) {
        notified = Date.now()
        progress({ mode, percent: Math.min(100, transferred / asset.size * 100), transferred, total: asset.size, bytesPerSecond: transferred / Math.max(1, (Date.now() - started) / 1000) })
      }
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

export async function initializeUpdater(): Promise<void> {
  const userData = process.env.ASHES_OF_PANTHEON_QA_USER_DATA_DIR || app.getPath('userData')
  const stagingRoot = join(userData, 'zip-updates')
  const pendingPath = join(userData, 'pending-zip-update.json')
  let prepared: StagedUpdate | undefined
  let initialMessage: string | undefined
  let initialError = false
  try {
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as { stageDir: string }
    const path = resolve(pending.stageDir)
    if (!path.startsWith(resolve(stagingRoot) + sep)) throw new Error('Invalid pending update directory')
    const result = JSON.parse(await readFile(join(path, 'result.json'), 'utf8')) as { state: string; message: string; version: string }
    initialError = result.state !== 'applied'
    initialMessage = initialError ? `上次更新未完成（${result.state}）：${result.message}。恢复文件：${path}` : `已更新到 ZIP 便携版 ${result.version}。`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { initialError = true; initialMessage = '无法读取上次更新结果，请检查用户数据目录中的 zip-updates。' }
  }

  const coordinator = createUpdateCoordinator({
    driver: {
      getLatestRelease,
      async download(release, progress) {
        prepared = undefined
        prepared = await stagePortableUpdate({
          directory: dirname(app.getPath('exe')), stagingRoot, currentVersion: app.getVersion(), release,
          download: (asset, mode) => downloadAsset(release.version, asset, mode, progress)
        })
      },
      async restart() {
        if (!prepared) throw new Error('更新尚未暂存。')
        const stage = prepared.stageDir
        const helperPath = join(stage, 'apply-update.ps1')
        const launcherPath = join(stage, 'start-update.ps1')
        const planPath = join(stage, 'plan.json')
        await copyFile(join(process.resourcesPath, 'updater', 'apply-update.ps1'), helperPath)
        await copyFile(join(process.resourcesPath, 'updater', 'start-update.ps1'), launcherPath)
        await writeFile(planPath, JSON.stringify({ ...prepared, parentPid: process.pid, launchUserDataDir: app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData') }))
        const { stdout } = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-PlanPath', planPath],
          { windowsHide: true, cwd: stage, timeout: 15_000 })
        const workerPid = Number.parseInt(stdout.trim(), 10)
        if (!Number.isSafeInteger(workerPid) || workerPid <= 0) throw new Error('更新助手未返回有效进程，请检查暂存目录中的 helper-error.log。')
        const deadline = Date.now() + 60_000
        while (true) {
          try { await readFile(join(stage, 'helper.ready')); break } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          try { process.kill(workerPid, 0) } catch {
            const details = await readFile(join(stage, 'helper-error.log'), 'utf8').catch(() => '')
            throw new Error(`更新助手已退出。${details || `请检查 ${stage} 中的 result.json。`}`)
          }
          if (Date.now() > deadline) throw new Error('更新助手验证超时，工具未退出。')
          await delay(100)
        }
        await writeFile(pendingPath, JSON.stringify({ stageDir: stage }))
        setTimeout(() => app.quit(), 150)
      }
    },
    isPackaged: app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
    currentVersion: app.getVersion(), initialMessage, initialError
  })

  coordinator.subscribe(broadcast)
  ipcMain.handle('update:get-status', () => coordinator.getStatus())
  ipcMain.handle('update:check', () => coordinator.check())
  ipcMain.handle('update:download', () => coordinator.download())
  ipcMain.handle('update:restart', () => coordinator.restart())
  if (app.isPackaged && !initialError) {
    const timer = setTimeout(() => void coordinator.check(), 5000)
    timer.unref()
  }
}
