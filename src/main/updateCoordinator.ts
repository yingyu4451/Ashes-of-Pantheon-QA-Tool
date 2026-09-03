import type { OperationResult, UpdateStatus } from '../shared/contracts.js'

export type UpdateDriverEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

export interface UpdateDriver {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on: (event: UpdateDriverEvent, listener: (...args: unknown[]) => void) => unknown
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

export interface UpdateCoordinator {
  getStatus: () => UpdateStatus
  subscribe: (listener: (status: UpdateStatus) => void) => () => void
  check: () => Promise<OperationResult<UpdateStatus>>
  download: () => Promise<OperationResult<UpdateStatus>>
  install: () => OperationResult<UpdateStatus>
}

interface UpdateCoordinatorOptions {
  driver: UpdateDriver
  isPackaged: boolean
  currentVersion: string
}

function copyStatus(status: UpdateStatus): UpdateStatus {
  return { ...status }
}

function versionFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const version = (value as { version?: unknown }).version
  return typeof version === 'string' ? version : undefined
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return typeof value === 'string' ? value : '检查更新失败。'
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  const { driver, isPackaged, currentVersion } = options
  const listeners = new Set<(status: UpdateStatus) => void>()
  let status: UpdateStatus = isPackaged
    ? { phase: 'idle', currentVersion, message: '尚未检查更新。' }
    : { phase: 'disabled', currentVersion, message: '开发模式不检查更新。' }

  const publish = (next: UpdateStatus): void => {
    status = next
    for (const listener of listeners) listener(copyStatus(status))
  }

  const fail = (error: unknown): OperationResult<UpdateStatus> => {
    publish({ phase: 'error', currentVersion, latestVersion: status.latestVersion, message: errorMessage(error) })
    return { ok: false, message: status.message, data: copyStatus(status) }
  }

  if (isPackaged) {
    driver.autoDownload = false
    driver.autoInstallOnAppQuit = false
    driver.allowPrerelease = false

    driver.on('checking-for-update', () => {
      publish({ phase: 'checking', currentVersion, message: '正在检查 GitHub 更新…' })
    })
    driver.on('update-available', (info) => {
      const latestVersion = versionFrom(info)
      publish({ phase: 'available', currentVersion, latestVersion, message: latestVersion ? `发现新版本 ${latestVersion}。` : '发现新版本。' })
    })
    driver.on('update-not-available', (info) => {
      publish({ phase: 'not-available', currentVersion, latestVersion: versionFrom(info) ?? currentVersion, message: '当前已是最新版本。' })
    })
    driver.on('download-progress', (progress) => {
      const value = progress && typeof progress === 'object' ? progress as Record<string, unknown> : {}
      const percent = typeof value.percent === 'number' ? Math.min(100, Math.max(0, value.percent)) : 0
      publish({
        phase: 'downloading',
        currentVersion,
        latestVersion: status.latestVersion,
        percent,
        transferred: typeof value.transferred === 'number' ? value.transferred : undefined,
        total: typeof value.total === 'number' ? value.total : undefined,
        bytesPerSecond: typeof value.bytesPerSecond === 'number' ? value.bytesPerSecond : undefined,
        message: `正在下载更新 ${Math.round(percent)}%…`
      })
    })
    driver.on('update-downloaded', (info) => {
      const latestVersion = versionFrom(info) ?? status.latestVersion
      publish({ phase: 'downloaded', currentVersion, latestVersion, percent: 100, message: '更新已下载，可以重启安装。' })
    })
    driver.on('error', (error) => {
      fail(error)
    })
  }

  return {
    getStatus: () => copyStatus(status),
    subscribe(listener) {
      listeners.add(listener)
      listener(copyStatus(status))
      return () => listeners.delete(listener)
    },
    async check() {
      if (!isPackaged) return { ok: false, message: status.message, data: copyStatus(status) }
      publish({ phase: 'checking', currentVersion, message: '正在检查 GitHub 更新…' })
      try {
        await driver.checkForUpdates()
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) {
        return fail(error)
      }
    },
    async download() {
      if (status.phase !== 'available') {
        return { ok: false, message: '当前没有可下载的更新。', data: copyStatus(status) }
      }
      publish({ phase: 'downloading', currentVersion, latestVersion: status.latestVersion, percent: 0, message: '正在下载更新 0%…' })
      try {
        await driver.downloadUpdate()
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) {
        return fail(error)
      }
    },
    install() {
      if (status.phase !== 'downloaded') {
        return { ok: false, message: '更新尚未下载完成。', data: copyStatus(status) }
      }
      driver.quitAndInstall(false, true)
      return { ok: true, message: '正在重启并安装更新…', data: copyStatus(status) }
    }
  }
}
