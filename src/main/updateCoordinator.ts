import type { OperationResult, UpdateStatus } from '../shared/contracts.js'
import type { PortableRelease } from './portableArchive.js'

export type UpdateProgress = Pick<UpdateStatus, 'percent' | 'transferred' | 'total' | 'bytesPerSecond' | 'mode'>

export interface UpdateDriver {
  getLatestRelease: () => Promise<PortableRelease>
  download: (release: PortableRelease, progress: (value: UpdateProgress) => void) => Promise<void>
  restart: () => Promise<void>
}

export interface UpdateCoordinator {
  getStatus: () => UpdateStatus
  subscribe: (listener: (status: UpdateStatus) => void) => () => void
  check: () => Promise<OperationResult<UpdateStatus>>
  download: () => Promise<OperationResult<UpdateStatus>>
  restart: () => Promise<OperationResult<UpdateStatus>>
}

interface UpdateCoordinatorOptions {
  driver: UpdateDriver
  isPackaged: boolean
  currentVersion: string
  initialMessage?: string
  initialError?: boolean
}

function copyStatus(status: UpdateStatus): UpdateStatus {
  return { ...status }
}

function compareVersions(left: string, right: string): number {
  const normalize = (version: string): number[] => version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const leftParts = normalize(left)
  const rightParts = normalize(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return typeof value === 'string' ? value : '检查更新失败。'
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  const { driver, isPackaged, currentVersion } = options
  const listeners = new Set<(status: UpdateStatus) => void>()
  let latestRelease: PortableRelease | null = null
  let status: UpdateStatus = isPackaged
    ? { phase: options.initialError ? 'error' : 'idle', currentVersion, message: options.initialMessage ?? '尚未检查更新。' }
    : { phase: 'disabled', currentVersion, message: '开发模式不检查更新。' }

  const publish = (next: UpdateStatus): void => {
    status = next
    for (const listener of listeners) listener(copyStatus(status))
  }

  const fail = (error: unknown): OperationResult<UpdateStatus> => {
    publish({ phase: 'error', currentVersion, latestVersion: status.latestVersion, message: errorMessage(error) })
    return { ok: false, message: status.message, data: copyStatus(status) }
  }

  return {
    getStatus: () => copyStatus(status),
    subscribe(listener) {
      listeners.add(listener)
      listener(copyStatus(status))
      return () => listeners.delete(listener)
    },
    async check() {
      if (!isPackaged || ['checking', 'downloading', 'downloaded', 'applying'].includes(status.phase)) return { ok: false, message: status.message, data: copyStatus(status) }
      publish({ phase: 'checking', currentVersion, message: '正在检查 GitHub 更新…' })
      try {
        latestRelease = await driver.getLatestRelease()
        if (compareVersions(latestRelease.version, currentVersion) > 0) {
          publish({ phase: 'available', currentVersion, latestVersion: latestRelease.version, message: `发现 ZIP 便携版 ${latestRelease.version}。` })
        } else {
          publish({ phase: 'not-available', currentVersion, latestVersion: latestRelease.version, message: '当前已是最新便携版。' })
        }
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) {
        latestRelease = null
        return fail(error)
      }
    },
    async download() {
      if (status.phase !== 'available' || !latestRelease) {
        return { ok: false, message: '当前没有可下载的便携版更新。', data: copyStatus(status) }
      }
      publish({ ...status, phase: 'downloading', percent: 0, message: '正在验证本地版本并准备下载…' })
      try {
        await driver.download(latestRelease, (progress) => publish({ ...status, ...progress, phase: 'downloading', message: (progress.percent ?? 0) >= 100 ? '下载完成，正在校验并暂存…' : progress.mode === 'delta' ? '正在下载增量 ZIP…' : '正在下载完整 ZIP…' }))
        publish({ ...status, phase: 'downloaded', percent: 100, message: '更新已校验，等待重启。' })
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) {
        return fail(error)
      }
    },
    async restart() {
      if (status.phase !== 'downloaded') return { ok: false, message: '请先下载并校验更新。', data: copyStatus(status) }
      publish({ ...status, phase: 'applying', message: '正在准备重启并更新…' })
      try {
        await driver.restart()
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) { return fail(error) }
    }
  }
}
