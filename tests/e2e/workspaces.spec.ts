import { expect, test } from '@playwright/test'
import type { BridgeRequest, OperationResult } from '@shared/contracts'

test('card catalog shows owned counts and supports card inventory actions', async ({ page }) => {
  await page.addInitScript(() => {
    const ownedCounts: Record<string, number> = { TestCard: 2, TestEquipment: 1 }
    const instance = {
      instanceId: 'card-inventory-test',
      kind: 'editor' as const,
      processId: 4321,
      displayName: 'Unity Editor · 卡牌操作测试',
      gameVersion: '1.0',
      sceneName: 'Battle',
      port: 12345,
      lastSeenAt: new Date().toISOString()
    }
    window.qaNative = {
      selectDirectory: async () => null,
      inspectUnityProject: async (path: string) => ({ path, valid: true, bridgeInstalled: true, message: 'Unity 项目可用' }),
      listBridgeInstances: async () => [instance],
      connectBridge: async () => ({ ok: true, message: '已连接运行实例。', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        if (request.path === '/api/catalog') {
          return {
            ok: true,
            message: '操作完成。',
            data: {
              cards: [
                { typeId: 'TestCard', name: '测试战术牌', description: '用于验证卡牌增删。', category: 'effect', cost: 1, rarity: 'common', tags: [] },
                { typeId: 'TestEquipment', name: '测试装备牌', description: '用于验证装备放置。', category: 'equipment', cost: 0, rarity: 'rare', tags: [] }
              ],
              equipment: [{ typeId: 'TestEquipment', name: '测试装备牌' }],
              buffs: [],
              blessings: [],
              intents: []
            } as T
          }
        }
        if (request.path === '/api/battle') {
          return {
            ok: true,
            message: '操作完成。',
            data: {
              available: true,
              sceneName: 'Battle',
              mapName: 'TestMap',
              width: 3,
              height: 3,
              turn: 1,
              phase: '玩家行动',
              player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 80, maxHp: 80, currentCost: 3, maxCost: 3, blessings: [], buffs: [] },
              entities: []
            } as T
          }
        }
        if (request.path === '/api/battle/route-preview') return { ok: true, message: '操作完成。', data: null as T }
        if (request.path === '/api/cards' && request.method === 'GET') {
          return {
            ok: true,
            message: '操作完成。',
            data: {
              available: true,
              cards: Object.entries(ownedCounts).map(([typeId, count]) => ({ typeId, count }))
            } as T
          }
        }
        const typeId = String((request.body as { typeId?: string } | undefined)?.typeId ?? '')
        if (request.path === '/api/cards' && request.method === 'POST') {
          ownedCounts[typeId] = (ownedCounts[typeId] ?? 0) + 1
          return { ok: true, message: `已加入手牌：${typeId}`, data: { success: true, message: `已加入手牌：${typeId}` } as T }
        }
        if (request.path === '/api/cards' && request.method === 'DELETE' && (ownedCounts[typeId] ?? 0) > 0) {
          ownedCounts[typeId] = (ownedCounts[typeId] ?? 0) - 1
          const message = typeId === 'TestEquipment' ? `已删除场上装备：${typeId}` : `已从手牌删除卡牌：${typeId}`
          return { ok: true, message, data: { success: true, message } as T }
        }
        return { ok: false, message: '不支持的测试请求。' }
      },
      readCatalogCache: async () => null,
      writeCatalogCache: async () => ({ ok: true, message: '目录缓存已更新。' }),
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
      writePreferences: async () => ({ ok: true, message: '路径已保存。' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.0', message: '开发模式不检查更新。' }),
      onUpdateStatus: () => () => undefined
    } as unknown as typeof window.qaNative
  })

  await page.goto('/')
  await expect(page.getByText('Unity Editor · 卡牌操作测试')).toBeVisible()
  await page.getByText('Unity Editor · 卡牌操作测试').locator('xpath=../..').getByRole('button', { name: '连接' }).click()
  await page.getByRole('button', { name: '卡牌', exact: true }).click()

  const card = page.getByRole('button', { name: /测试战术牌/ })
  await expect(card).toHaveAttribute('aria-label', /拥有 2 张/)
  await page.screenshot({ path: 'test-results/card-inventory-actions.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/card-inventory-actions-narrow.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await card.click()
  await expect(card).toHaveAttribute('aria-label', /拥有 3 张/)
  await expect(page.getByRole('status')).toContainText('已加入手牌：TestCard')
  await card.click({ button: 'right' })
  await expect(card).toHaveAttribute('aria-label', /拥有 2 张/)
  await expect(page.getByRole('status')).toContainText('已从手牌删除卡牌：TestCard')

  const equipment = page.getByRole('button', { name: /测试装备牌/ })
  await expect(equipment).toHaveAttribute('aria-label', /拥有 1 张/)
  await equipment.click({ button: 'right' })
  await expect(equipment).toHaveAttribute('aria-label', /拥有 0 张/)
  await expect(page.getByRole('status')).toContainText('已删除场上装备：TestEquipment')
  await equipment.click()
  await expect(page.getByRole('heading', { name: '战斗工作台' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '已选择装备“测试装备牌”，请在地图上选择格子后放置。' })).toBeVisible()
})

test('switching game packages ignores stale Bridge inspection results', async ({ page }) => {
  const firstPath = 'C:\\Builds\\Package-A'
  const secondPath = 'C:\\Builds\\Package-B'
  await page.addInitScript(({ firstPath, secondPath }) => {
    const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
    window.qaNative = {
      selectDirectory: async (title: string) => title.includes('游戏包') ? secondPath : null,
      inspectUnityProject: async (path: string) => ({ path, valid: true, bridgeInstalled: false, message: 'Unity 项目可用' }),
      inspectGameBuild: async (path: string) => {
        if (path === firstPath) await wait(250)
        return { path, valid: true, backend: 'mono', message: `已识别 ${path}` }
      },
      inspectPackageBridge: async (path: string) => {
        if (path === firstPath) await wait(250)
        return {
          sourcePath: path,
          prepared: path === firstPath,
          backend: 'mono',
          message: path === firstPath ? 'Package-A 临时 Bridge 已准备' : 'Package-B 尚未准备临时 Bridge'
        }
      },
      listBridgeInstances: async () => [],
      readCatalogCache: async () => null,
      writeCatalogCache: async () => ({ ok: true, message: '目录缓存已更新。' }),
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: firstPath }),
      writePreferences: async () => ({ ok: true, message: '路径已保存。' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.0', message: '开发模式不检查更新。' }),
      onUpdateStatus: () => () => undefined
    } as unknown as typeof window.qaNative
  }, { firstPath, secondPath })

  await page.goto('/')
  await expect(page.getByLabel('游戏包路径')).toHaveValue(firstPath)
  await page.getByRole('button', { name: '选择游戏包' }).click()
  await expect(page.getByLabel('游戏包路径')).toHaveValue(secondPath)
  await expect(page.getByText('Package-B 尚未准备临时 Bridge')).toBeVisible()
  await page.waitForTimeout(700)
  await expect(page.getByText('Package-B 尚未准备临时 Bridge')).toBeVisible()
  await expect(page.getByText('Package-A 临时 Bridge 已准备')).toHaveCount(0)
})

test('tab selection and window focus refresh all connected data', async ({ page }) => {
  await page.addInitScript(() => {
    let catalogRevision = 0
    let battleRevision = 0
    const instance = {
      instanceId: 'refresh-test',
      kind: 'editor' as const,
      processId: 1234,
      displayName: 'Unity Editor · 刷新测试',
      gameVersion: '1.0',
      sceneName: 'Battle',
      port: 12345,
      lastSeenAt: new Date().toISOString()
    }
    window.qaNative = {
      selectDirectory: async () => null,
      inspectUnityProject: async (path) => ({ path, valid: true, bridgeInstalled: true, message: 'Unity 项目可用' }),
      installEditorBridge: async () => ({ ok: true, message: 'Editor Bridge 已安装。' }),
      uninstallEditorBridge: async () => ({ ok: true, message: 'Editor Bridge 已卸载。' }),
      inspectGameBuild: async (path) => ({ path, valid: true, backend: 'mono', message: '已识别 MONO 包。' }),
      inspectPackageBridge: async (path) => ({ sourcePath: path, prepared: false, backend: 'mono', message: '需要先安装打包版 Bridge。' }),
      preparePackageBridge: async () => ({ ok: false, message: '测试不安装 Bridge。' }),
      launchPackageBridge: async () => ({ ok: false, message: '测试不启动游戏。' }),
      removePackageBridge: async () => ({ ok: true, message: '没有需要移除的临时 Bridge。' }),
      listBridgeInstances: async () => [instance],
      connectBridge: async () => ({ ok: true, message: '已连接运行实例。', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        if (request.path === '/api/catalog') {
          catalogRevision += 1
          return {
            ok: true,
            message: '操作完成。',
            data: {
              cards: [{ typeId: `RefreshCard${catalogRevision}`, name: `刷新卡牌 ${catalogRevision}`, description: '刷新验证', category: 'effect', cost: 1, rarity: 'common', tags: [] }],
              equipment: [],
              buffs: [],
              blessings: [],
              intents: []
            } as T
          }
        }
        if (request.path === '/api/cards') {
          return { ok: true, message: '操作完成。', data: { available: true, cards: [] } as T }
        }
        if (request.path === '/api/battle/route-preview') return { ok: true, message: '操作完成。', data: null as T }
        battleRevision += 1
        return {
          ok: true,
          message: '操作完成。',
          data: {
            available: true,
            sceneName: 'Battle',
            mapName: 'RefreshMap',
            width: 3,
            height: 3,
            turn: battleRevision,
            phase: '玩家行动',
            player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 80, maxHp: 80, currentCost: 3, maxCost: 3, blessings: [], buffs: [] },
            entities: []
          } as T
        }
      },
      readCatalogCache: async () => null,
      writeCatalogCache: async () => ({ ok: true, message: '目录缓存已更新。' }),
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
      writePreferences: async () => ({ ok: true, message: '路径已保存。' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.0', message: '开发模式不检查更新。' }),
      checkForUpdates: async () => ({ ok: false, message: '开发模式不检查更新。' }),
      downloadUpdate: async () => ({ ok: false, message: '没有可下载的便携版更新。' }),
      restartForUpdate: async () => ({ ok: false, message: '没有可应用的更新。' }),
      onUpdateStatus: () => () => undefined
    }
  })

  await page.goto('/')
  await expect(page.getByText('Unity Editor · 刷新测试')).toBeVisible()
  await page.getByText('Unity Editor · 刷新测试').locator('xpath=../..').getByRole('button', { name: '连接' }).click()
  await expect(page.getByText('回合').locator('..')).toContainText('1')

  await page.getByRole('button', { name: '卡牌' }).click()
  await expect(page.getByRole('button', { name: /刷新卡牌 2/ })).toBeVisible()
  await expect(page.getByText('回合').locator('..')).toContainText('2')

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: /刷新卡牌 3/ })).toBeVisible()
  await expect(page.getByText('回合').locator('..')).toContainText('3')

  await page.getByRole('button', { name: '刷新运行时状态' }).click()
  await expect(page.getByRole('button', { name: /刷新卡牌 4/ })).toBeVisible()
  await expect(page.getByText('回合').locator('..')).toContainText('4')
  await expect(page.getByRole('status')).toContainText('目录与战斗数据已刷新。')
})

test('battle workspace renders a stable tactical grid', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '战斗工作台' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择格 0, 0' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择 角盔守卫' }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/battle-workspace.png', fullPage: true })
})

test('rectangular battle maps keep every grid cell square', async ({ page }) => {
  await page.addInitScript(() => {
    const instance = {
      instanceId: 'rectangular-map-test',
      kind: 'package' as const,
      processId: 9876,
      displayName: 'Game Package · 矩形地图测试',
      gameVersion: '1.0',
      sceneName: 'Battle',
      port: 12345,
      lastSeenAt: new Date().toISOString()
    }
    window.qaNative = {
      listBridgeInstances: async () => [instance],
      connectBridge: async () => ({ ok: true, message: '已连接运行实例。', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        if (request.path === '/api/catalog') {
          return { ok: true, message: '操作完成。', data: { cards: [], equipment: [], buffs: [], blessings: [], intents: [] } as T }
        }
        if (request.path === '/api/cards') {
          return { ok: true, message: '操作完成。', data: { available: true, cards: [] } as T }
        }
        return {
          ok: true,
          message: '操作完成。',
          data: {
            available: true,
            sceneName: 'Battle',
            mapName: 'WideMap',
            width: 11,
            height: 7,
            turn: 1,
            phase: '玩家行动',
            player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 80, maxHp: 80, currentCost: 3, maxCost: 3, blessings: [], buffs: [] },
            entities: []
          } as T
        }
      },
      readCatalogCache: async () => null,
      writeCatalogCache: async () => ({ ok: true, message: '目录缓存已更新。' }),
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.0', message: '开发模式不检查更新。' }),
      onUpdateStatus: () => () => undefined
    } as unknown as typeof window.qaNative
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByText('Game Package · 矩形地图测试')).toBeVisible()
  await page.getByText('Game Package · 矩形地图测试').locator('xpath=../..').getByRole('button', { name: '连接' }).click()
  const grid = page.getByTestId('battle-grid')
  await expect(grid).toBeVisible()
  const size = await grid.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
  const firstCell = page.getByRole('button', { name: /选择格/ }).first().locator('..')
  const cellSize = await firstCell.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })

  expect(Math.abs(cellSize.width - cellSize.height)).toBeLessThan(1)
  expect(size.width).not.toBe(size.height)
})

test('card filters and delayed tooltip work', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '卡牌' }).click()
  await expect(page.getByRole('heading', { name: '卡牌目录' })).toBeVisible()

  const card = page.getByRole('button', { name: /双手巨剑/ })
  await card.hover()
  await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1600 })

  await page.getByRole('checkbox', { name: '装备' }).check()
  await expect(page.getByText(/显示 4 \/ 12/)).toBeVisible()
  await page.screenshot({ path: 'test-results/card-workspace.png', fullPage: true })
})

test('workspaces remain usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '战斗工作台' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.getByRole('button', { name: '卡牌' }).click()
  await expect(page.getByRole('heading', { name: '卡牌目录' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.getByRole('button', { name: '连接' }).last().click()
  await expect(page.getByRole('heading', { name: '项目与连接' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole('heading', { name: '应用更新' }).scrollIntoViewIfNeeded()
  await expect(page.getByText('开发模式不检查更新。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/narrow-setup-workspace.png', fullPage: true })
})
