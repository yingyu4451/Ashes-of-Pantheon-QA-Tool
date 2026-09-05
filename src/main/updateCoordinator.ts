import type { OperationResult, UpdateStatus } from '../shared/contracts.js'

export interface PortableRelease {
  version: string
  downloadUrl: string
}

export interface UpdateDriver {
  getLatestRelease: () => Promise<PortableRelease>
  openExternal: (url: string) => Promise<void>
}

export interface UpdateCoordinator {
  getStatus: () => UpdateStatus
  subscribe: (listener: (status: UpdateStatus) => void) => () => void
  check: () => Promise<OperationResult<UpdateStatus>>
  openDownload: () => Promise<OperationResult<UpdateStatus>>
}

interface UpdateCoordinatorOptions {
  driver: UpdateDriver
  isPackaged: boolean
  currentVersion: string
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
        latestRelease = await driver.getLatestRelease()
        if (compareVersions(latestRelease.version, currentVersion) > 0) {
          publish({ phase: 'available', currentVersion, latestVersion: latestRelease.version, message: `发现便携版 ${latestRelease.version}。` })
        } else {
          publish({ phase: 'not-available', currentVersion, latestVersion: latestRelease.version, message: '当前已是最新便携版。' })
        }
        return { ok: true, message: status.message, data: copyStatus(status) }
      } catch (error) {
        latestRelease = null
        return fail(error)
      }
    },
    async openDownload() {
      if (status.phase !== 'available' || !latestRelease) {
        return { ok: false, message: '当前没有可下载的便携版更新。', data: copyStatus(status) }
      }
      try {
        await driver.openExternal(latestRelease.downloadUrl)
        return { ok: true, message: '已在浏览器中打开便携版下载。下载完成后关闭旧版本并运行新文件。', data: copyStatus(status) }
      } catch (error) {
        return fail(error)
      }
    }
  }
}
