import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/contracts.js'
import { createUpdateCoordinator, type UpdateDriver } from './updateCoordinator.js'

const updateStatusChannel = 'update:status'

function broadcast(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(updateStatusChannel, status)
  }
}

export function initializeUpdater(): void {
  const { autoUpdater } = electronUpdater
  const coordinator = createUpdateCoordinator({
    driver: autoUpdater as unknown as UpdateDriver,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion()
  })

  coordinator.subscribe(broadcast)
  ipcMain.handle('update:get-status', () => coordinator.getStatus())
  ipcMain.handle('update:check', () => coordinator.check())
  ipcMain.handle('update:download', () => coordinator.download())
  ipcMain.handle('update:install', () => coordinator.install())

  if (app.isPackaged) {
    const timer = setTimeout(() => void coordinator.check(), 5000)
    timer.unref()
  }
}
