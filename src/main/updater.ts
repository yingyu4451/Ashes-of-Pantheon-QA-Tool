import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { UpdateStatus } from '../shared/contracts.js'
import { createUpdateCoordinator, type PortableRelease } from './updateCoordinator.js'

const updateStatusChannel = 'update:status'
const releasesApiUrl = 'https://api.github.com/repos/yingyu4451/Ashes-of-Pantheon-QA-Tool/releases/latest'

function broadcast(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(updateStatusChannel, status)
  }
}

async function getLatestRelease(): Promise<PortableRelease> {
  const response = await fetch(releasesApiUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ashes-of-Pantheon-QA-Tool' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`GitHub Release 检查失败：${response.status}`)
  const release = await response.json() as {
    tag_name?: unknown
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
  }
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '') : ''
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('GitHub Release 版本号无效。')
  const expectedName = `Ashes-of-Pantheon-QA-Tool-Portable-${version}.exe`
  const asset = release.assets?.find((item) => item.name === expectedName)
  if (!asset || typeof asset.browser_download_url !== 'string') throw new Error(`GitHub Release 缺少便携版文件：${expectedName}`)
  return { version, downloadUrl: asset.browser_download_url }
}

export function initializeUpdater(): void {
  const coordinator = createUpdateCoordinator({
    driver: { getLatestRelease, openExternal: (url) => shell.openExternal(url) },
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion()
  })

  coordinator.subscribe(broadcast)
  ipcMain.handle('update:get-status', () => coordinator.getStatus())
  ipcMain.handle('update:check', () => coordinator.check())
  ipcMain.handle('update:open-download', () => coordinator.openDownload())

  if (app.isPackaged) {
    const timer = setTimeout(() => void coordinator.check(), 5000)
    timer.unref()
  }
}
