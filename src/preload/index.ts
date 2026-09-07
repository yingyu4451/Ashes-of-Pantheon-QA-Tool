import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeRequest, OperationResult, QaCatalog, QaNativeApi, UpdateStatus } from '../shared/contracts.js'

const api: QaNativeApi = {
  selectDirectory: (title) => ipcRenderer.invoke('dialog:select-directory', title),
  inspectUnityProject: (projectPath) => ipcRenderer.invoke('project:inspect', projectPath),
  installEditorBridge: (projectPath) => ipcRenderer.invoke('project:install-bridge', projectPath),
  uninstallEditorBridge: (projectPath) => ipcRenderer.invoke('project:uninstall-bridge', projectPath),
  inspectGameBuild: (buildPath) => ipcRenderer.invoke('build:inspect', buildPath),
  inspectPackageBridge: (buildPath) => ipcRenderer.invoke('package-bridge:inspect', buildPath),
  preparePackageBridge: (buildPath) => ipcRenderer.invoke('package-bridge:prepare', buildPath),
  launchPackageBridge: (buildPath) => ipcRenderer.invoke('package-bridge:launch', buildPath),
  removePackageBridge: (buildPath) => ipcRenderer.invoke('package-bridge:remove', buildPath),
  listBridgeInstances: () => ipcRenderer.invoke('bridge:list'),
  connectBridge: (instanceId) => ipcRenderer.invoke('bridge:connect', instanceId),
  requestBridge: <T>(request: BridgeRequest) => ipcRenderer.invoke('bridge:request', request) as Promise<OperationResult<T>>,
  readCatalogCache: () => ipcRenderer.invoke('cache:read-catalog') as Promise<QaCatalog | null>,
  writeCatalogCache: (catalog) => ipcRenderer.invoke('cache:write-catalog', catalog),
  readPreferences: () => ipcRenderer.invoke('preferences:read'),
  writePreferences: (preferences) => ipcRenderer.invoke('preferences:write', preferences),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  restartForUpdate: () => ipcRenderer.invoke('update:restart'),
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => listener(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  }
}

contextBridge.exposeInMainWorld('qaNative', api)
