import { _electron as electron, expect, test } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native preload exposes directory selection and hides demo catalog', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-qa-native-'))
  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userDataRoot }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const nativeApi = await page.evaluate(() => ({
      selectDirectory: typeof window.qaNative?.selectDirectory,
      inspectUnityProject: typeof window.qaNative?.inspectUnityProject,
      getUpdateStatus: typeof window.qaNative?.getUpdateStatus,
      checkForUpdates: typeof window.qaNative?.checkForUpdates,
      downloadUpdate: typeof window.qaNative?.downloadUpdate,
      restartForUpdate: typeof window.qaNative?.restartForUpdate,
      onUpdateStatus: typeof window.qaNative?.onUpdateStatus
    }))

    expect(nativeApi).toEqual({
      selectDirectory: 'function',
      inspectUnityProject: 'function',
      getUpdateStatus: 'function',
      checkForUpdates: 'function',
      downloadUpdate: 'function',
      restartForUpdate: 'function',
      onUpdateStatus: 'function'
    })
    const menuState = await app.evaluate(({ BrowserWindow, Menu }) => ({
      applicationMenuIsNull: Menu.getApplicationMenu() === null,
      menuBarVisible: BrowserWindow.getAllWindows()[0]?.isMenuBarVisible() ?? true
    }))
    expect(menuState).toEqual({ applicationMenuIsNull: true, menuBarVisible: false })
    await expect(page.getByRole('heading', { name: '项目与连接' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '应用更新' })).toBeVisible()
    await expect(page.getByText('开发模式不检查更新。')).toBeVisible()
    await expect(page.getByRole('button', { name: '检查更新' })).toBeDisabled()
    await expect(page.getByText('显示 12 / 12')).toHaveCount(0)

    await page.getByRole('button', { name: '战斗' }).click()
    await expect(page.getByRole('heading', { name: '未连接战斗实例' })).toBeVisible()
    await expect(page.getByText('67/80')).toHaveCount(0)

    await page.getByRole('button', { name: '玩家' }).click()
    await expect(page.getByRole('heading', { name: '未连接玩家实例' })).toBeVisible()

    await page.getByRole('button', { name: '卡牌' }).click()
    await expect(page.getByText('尚未同步卡牌目录')).toBeVisible()
    await expect(page.getByRole('button', { name: '前往连接' })).toBeVisible()
  } finally {
    await app.close()
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('editor bridge installs from bundled resources', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'ashes-qa-unity-'))
  const userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-qa-bridge-settings-'))
  await mkdir(join(projectRoot, 'Assets'))
  await mkdir(join(projectRoot, 'Packages'))
  await mkdir(join(projectRoot, 'ProjectSettings'))
  await writeFile(join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.62f2c1\n', 'utf8')

  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userDataRoot }
  })
  try {
    const page = await app.firstWindow()
    const installResult = await page.evaluate((path) => window.qaNative!.installEditorBridge(path), projectRoot)
    expect(installResult.ok).toBe(true)

    const manifest = JSON.parse(await readFile(join(projectRoot, 'Packages', 'com.ashes-of-pantheon.qa-bridge', 'package.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe('com.ashes-of-pantheon.qa-bridge')

    await page.evaluate(() => window.qaNative!.writeCatalogCache({ cards: [], equipment: [], buffs: [], blessings: [], intents: [] }))

    const updateResult = await page.evaluate((path) => window.qaNative!.installEditorBridge(path), projectRoot)
    expect(updateResult).toEqual({ ok: true, message: 'Editor Bridge 已更新。重新聚焦 Unity，等待脚本编译完成。' })
    await expect(page.evaluate(() => window.qaNative!.readCatalogCache())).resolves.toBeNull()

    const uninstallResult = await page.evaluate((path) => window.qaNative!.uninstallEditorBridge(path), projectRoot)
    expect(uninstallResult.ok).toBe(true)
    await expect(access(join(projectRoot, 'Packages', 'com.ashes-of-pantheon.qa-bridge'))).rejects.toThrow()
  } finally {
    await app.close()
    if (projectRoot.startsWith(join(tmpdir(), 'ashes-qa-unity-'))) {
      await rm(projectRoot, { recursive: true, force: true })
    }
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('selected paths persist across Electron restarts', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-qa-preferences-'))
  const launch = () => electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userDataRoot }
  })
  const expected = {
    unityProjectPath: 'D:\\Unity Project\\Ashes of Pantheon',
    gameBuildPath: 'D:\\Builds\\Ashes of Pantheon'
  }

  try {
    const firstApp = await launch()
    const firstPage = await firstApp.firstWindow()
    const writeResult = await firstPage.evaluate(async (preferences) => {
      const api = window.qaNative as typeof window.qaNative & {
        writePreferences: (value: typeof preferences) => Promise<{ ok: boolean; message: string }>
      }
      return api!.writePreferences(preferences)
    }, expected)
    expect(writeResult.ok).toBe(true)
    await firstApp.close()

    const secondApp = await launch()
    try {
      const secondPage = await secondApp.firstWindow()
      const restored = await secondPage.evaluate(async () => {
        const api = window.qaNative as typeof window.qaNative & {
          readPreferences: () => Promise<{ unityProjectPath: string; gameBuildPath: string }>
        }
        return api!.readPreferences()
      })
      expect(restored).toEqual(expected)
      await expect(secondPage.getByLabel('Unity 项目路径')).toHaveValue(expected.unityProjectPath)
      await expect(secondPage.getByLabel('游戏包路径')).toHaveValue(expected.gameBuildPath)
      const clearResult = await secondPage.evaluate((unityProjectPath) => window.qaNative!.writePreferences({
        unityProjectPath,
        gameBuildPath: ''
      }), expected.unityProjectPath)
      expect(clearResult.ok).toBe(true)
      await expect(secondPage.evaluate(() => window.qaNative!.readPreferences())).resolves.toEqual({
        unityProjectPath: expected.unityProjectPath,
        gameBuildPath: ''
      })
    } finally {
      await secondApp.close()
    }
  } finally {
    if (userDataRoot.startsWith(join(tmpdir(), 'ashes-qa-preferences-'))) {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  }
})

test('packaged game requires an external Bridge in a temporary copy', async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), 'ashes-package-build-'))
  const userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-package-bridge-'))
  const executableName = 'Ashes of Pantheon.exe'
  await mkdir(join(buildRoot, 'Ashes of Pantheon_Data', 'Managed'), { recursive: true })
  await mkdir(join(buildRoot, 'MonoBleedingEdge'))
  await writeFile(join(buildRoot, executableName), 'test executable', 'utf8')
  await writeFile(join(buildRoot, 'UnityPlayer.dll'), 'test unity player', 'utf8')
  await writeFile(join(buildRoot, 'Ashes of Pantheon_Data', 'Managed', 'HappyHotel.dll'), 'test assembly', 'utf8')
  await writeFile(join(userDataRoot, 'preferences.json'), JSON.stringify({
    unityProjectPath: '',
    gameBuildPath: buildRoot
  }), 'utf8')

  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userDataRoot }
  })
  try {
    const page = await app.firstWindow()
    const before = await page.evaluate((path) => window.qaNative!.inspectPackageBridge(path), buildRoot)
    expect(before).toMatchObject({ sourcePath: buildRoot, prepared: false, backend: 'mono' })
    await expect(page.getByText('此游戏包尚未创建临时 Bridge 副本。原始游戏包不会被修改。')).toBeVisible()
    await expect(page.getByRole('button', { name: '安装打包版 Bridge' })).toBeVisible()

    const launchBeforeInstall = await page.evaluate((path) => window.qaNative!.launchPackageBridge(path), buildRoot)
    expect(launchBeforeInstall).toMatchObject({
      ok: false,
      message: '请先安装打包版 Bridge，再从临时副本启动游戏。',
      data: { sourcePath: buildRoot, prepared: false, backend: 'mono' }
    })
    await expect(access(join(buildRoot, 'winhttp.dll'))).rejects.toThrow()

    await page.getByRole('button', { name: '安装打包版 Bridge' }).click()
    const packageRegion = page.getByRole('region', { name: '打包游戏' })
    await expect(packageRegion.getByText('此游戏包的临时 Bridge 副本已准备；原始游戏包未修改。')).toBeVisible()
    const prepared = await page.evaluate((path) => window.qaNative!.inspectPackageBridge(path), buildRoot)
    expect(prepared).toMatchObject({ sourcePath: buildRoot, prepared: true, backend: 'mono' })
    expect(prepared.temporaryPath).not.toBe(buildRoot)
    await expect(packageRegion.getByText(prepared.temporaryPath!, { exact: false })).toBeVisible()
    await expect(access(join(buildRoot, 'winhttp.dll'))).rejects.toThrow()
    await access(join(prepared.temporaryPath!, 'winhttp.dll'))
    await access(join(prepared.temporaryPath!, 'BepInEx', 'plugins', 'AshesOfPantheon.QA.PackageBridge.dll'))

    const pluginSource = await readFile(join(process.cwd(), 'resources', 'package-bridge', 'plugin-src', 'AshesOfPantheonPackageBridge.cs'), 'utf8')
    expect(pluginSource).toContain('path == "/api/player"')
    expect(pluginSource).toContain('path == "/api/enemy"')
    expect(pluginSource).toContain('path == "/api/buffs"')
    expect(pluginSource).toContain('path == "/api/blessings"')
    expect(pluginSource).toContain('path == "/api/intents"')
    expect(pluginSource).toContain('HappyHotel.Core.Localization.LocalizedStringResolver')

    await writeFile(join(prepared.temporaryPath!, 'BepInEx', 'plugins', 'AshesOfPantheon.QA.PackageBridge.dll'), 'outdated bridge', 'utf8')
    const outdated = await page.evaluate((path) => window.qaNative!.inspectPackageBridge(path), buildRoot)
    expect(outdated).toMatchObject({
      sourcePath: buildRoot,
      prepared: false,
      backend: 'mono',
      message: '此游戏包的临时 Bridge 副本需要更新。原始游戏包不会被修改。'
    })

    const refreshed = await page.evaluate((path) => window.qaNative!.preparePackageBridge(path), buildRoot)
    expect(refreshed.ok).toBe(true)

    const removed = await page.evaluate((path) => window.qaNative!.removePackageBridge(path), buildRoot)
    expect(removed.ok).toBe(true)
    await expect(access(prepared.temporaryPath!)).rejects.toThrow()
    await access(join(buildRoot, executableName))
    await access(join(buildRoot, 'Ashes of Pantheon_Data', 'Managed', 'HappyHotel.dll'))
  } finally {
    await app.close()
    await rm(buildRoot, { recursive: true, force: true })
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('connection shows persistent success feedback and opens the available workspace', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'ashes-qa-instances-'))
  const userDataRoot = await mkdtemp(join(tmpdir(), 'ashes-qa-session-'))
  const token = 'test-token'
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}')
      return
    }
    if (request.url === '/api/fail') {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '地图尚未初始化。' }))
      return
    }
    const body = request.url === '/api/catalog'
      ? { cards: [{ typeId: 'Card1', name: '测试卡牌', description: '测试描述', category: 'effect', cost: 1, rarity: 'common', tags: [] }], equipment: [], buffs: [], blessings: [], intents: [] }
      : request.url === '/api/battle'
        ? { available: false, sceneName: 'MainMenu', mapName: '', width: 0, height: 0, turn: 0, phase: 'editor-edit', player: null, entities: [] }
        : request.url === '/api/cards'
          ? { available: false, cards: [] }
          : { ready: true, mode: 'editor-edit', sceneName: 'MainMenu' }
    const send = () => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (request.url === '/api/status') setTimeout(send, 250)
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test Bridge failed to listen.')
  const instanceDirectory = join(localAppData, 'AshesOfPantheonQA', 'instances')
  await mkdir(instanceDirectory, { recursive: true })
  const instanceFile = join(instanceDirectory, 'feedback-test.json')
  await writeFile(instanceFile, JSON.stringify({
    instanceId: 'feedback-test',
    kind: 'editor',
    processId: process.pid,
    displayName: 'Unity Editor · 反馈测试',
    gameVersion: '1.0',
    sceneName: 'MainMenu',
    port: address.port,
    token,
    lastSeenAt: new Date().toISOString()
  }), 'utf8')

  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, LOCALAPPDATA: localAppData, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userDataRoot }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('Unity Editor · 反馈测试')).toBeVisible({ timeout: 5000 })
    const instanceRow = page.getByText('Unity Editor · 反馈测试').locator('xpath=../..')
    await instanceRow.getByRole('button', { name: '连接' }).click()
    await expect(page.getByRole('button', { name: '连接中…' })).toBeDisabled()

    await expect(page.getByRole('status').filter({ hasText: '卡牌目录已同步；进入 Play Mode 后可读取战斗状态。' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '卡牌目录' })).toBeVisible()
    await expect(page.getByText('Editor 已连接 · 未进入 Play Mode')).toBeVisible()
    await page.getByRole('button', { name: '连接', exact: true }).first().click()
    await expect(page.getByRole('button', { name: '已连接' })).toBeDisabled()
    const failure = await page.evaluate(() => window.qaNative!.requestBridge({
      instanceId: 'feedback-test',
      method: 'GET',
      path: '/api/fail'
    }))
    expect(failure).toEqual({ ok: false, message: '地图尚未初始化。' })
    await rm(instanceFile)
    await expect(page.getByRole('status').filter({ hasText: 'Unity Editor 连接已断开。' })).toBeVisible({ timeout: 7000 })
    await expect(page.getByText('离线目录')).toBeVisible()
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(localAppData, { recursive: true, force: true })
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('connects to a live Unity Editor bridge', async () => {
  test.skip(process.env.ASHES_OF_PANTHEON_LIVE_BRIDGE !== '1', 'Requires a running Unity Editor bridge')
  const app = await electron.launch({ args: ['out/main/index.js'], cwd: process.cwd() })
  try {
    const page = await app.firstWindow()
    const result = await page.evaluate(async () => {
      const instances = await window.qaNative!.listBridgeInstances()
      const instance = instances[0]
      if (!instance) return { instances: 0, connected: false, catalogCards: -1 }
      const connection = await window.qaNative!.connectBridge(instance.instanceId)
      if (!connection.ok) return { instances: instances.length, connected: false, catalogCards: -1, message: connection.message }
      const catalog = await window.qaNative!.requestBridge<{
        cards: Array<{ name: string }>
        equipment: Array<{ name: string }>
        buffs: Array<{ name: string }>
        blessings: Array<{ name: string }>
        intents: Array<{ name: string }>
      }>({
        instanceId: instance.instanceId,
        method: 'GET',
        path: '/api/catalog'
      })
      return {
        instances: instances.length,
        connected: connection.ok,
        catalogCards: catalog.data?.cards.length ?? -1,
        catalogEquipment: catalog.data?.equipment.length ?? -1,
        allCatalogNamesChinese: catalog.data
          ? [catalog.data.cards, catalog.data.buffs, catalog.data.blessings, catalog.data.intents]
              .flat()
              .every((item) => /\p{Script=Han}/u.test(item.name))
          : false,
        message: catalog.message
      }
    })

    expect(result.instances).toBeGreaterThan(0)
    expect(result.connected).toBe(true)
    expect(result.catalogCards).toBeGreaterThan(0)
    expect(result.catalogEquipment).toBeGreaterThan(0)
    expect(result.allCatalogNamesChinese).toBe(true)
  } finally {
    await app.close()
  }
})
