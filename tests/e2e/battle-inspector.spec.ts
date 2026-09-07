import { expect, test } from '@playwright/test'
import type { BridgeRequest, OperationResult, QaBattleSnapshot, QaCatalog } from '@shared/contracts'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const controls = { failBlessing: false, delayBlessing: false, empty: false, longNames: false, finish: () => undefined as void }
    Object.assign(window, { inspectorTest: controls })
    const instance = { instanceId: 'inspector-test', kind: 'editor', processId: 4567, displayName: 'Unity Inspector Test', gameVersion: '1.0', sceneName: 'Battle', port: 12345, lastSeenAt: new Date().toISOString() }
    const catalog: QaCatalog = {
      cards: [{ typeId: 'Card01', name: '测试手牌', description: '造成伤害。', category: 'effect', cost: 2, rarity: 'common', tags: [] }],
      equipment: [{ typeId: 'Equipment01', name: '测试长剑' }], buffs: [],
      blessings: [{ typeId: 'Blessing01', name: '试炼祝福', description: '提高生命上限。' }],
      intents: [{ typeId: 'Attack01', name: '普通攻击', description: '', parameters: [] }]
    }
    const battle: QaBattleSnapshot = {
      available: true, sceneName: 'Battle', mapName: 'TestMap', width: 7, height: 7, turn: 1, phase: '玩家行动',
      player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 50, maxHp: 80, currentCost: 2, maxCost: 4, blessings: [], buffs: [] },
      entities: [{ instanceId: 'enemy-01#0', typeId: 'Enemy01', name: '测试怪物', kind: 'enemy', position: { x: 1, y: 1 }, currentHp: 30, maxHp: 30, buffs: [], intents: [] }]
    }
    window.qaNative = {
      listBridgeInstances: async () => [instance],
      connectBridge: async () => ({ ok: true, message: '已连接。', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        if (request.path === '/api/catalog') {
          const snapshot = structuredClone(catalog)
          if (controls.empty) { snapshot.blessings = []; snapshot.equipment = [] }
          if (controls.longNames) {
            snapshot.blessings = [{ typeId: 'Blessing_With_A_Very_Long_Registered_TypeId_0123456789', name: '试炼祝福的完整中文名称', description: '' }]
            snapshot.equipment = [{ typeId: 'Equipment_With_A_Very_Long_Registered_TypeId_0123456789', name: '测试装备的完整中文名称' }]
          }
          return { ok: true, message: '', data: snapshot as T }
        }
        if (request.path === '/api/battle') return { ok: true, message: '', data: structuredClone(battle) as T }
        if (request.path === '/api/cards') return { ok: true, message: '', data: { available: true, cards: [{ typeId: 'Card01', count: 3 }] } as T }
        if (request.path === '/api/blessings') {
          if (controls.delayBlessing) await new Promise<void>((resolve) => { controls.finish = resolve })
          if (controls.failBlessing) return { ok: false, message: '祝福添加失败，请刷新后重试。' }
          const typeId = (request.body as { typeId: string }).typeId
          if (request.method === 'POST') battle.player.blessings.push(catalog.blessings.find((item) => item.typeId === typeId)!)
          else battle.player.blessings = battle.player.blessings.filter((item) => item.typeId !== typeId)
        }
        if (request.path === '/api/player') Object.assign(battle.player, request.body)
        return { ok: true, message: '修改已同步。', data: { success: true, message: '修改已同步。' } as T }
      },
      readCatalogCache: async () => null,
      writeCatalogCache: async () => ({ ok: true, message: '' }),
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.4', message: '开发模式不检查更新。' }),
      onUpdateStatus: () => () => undefined
    } as unknown as typeof window.qaNative
  })
  await page.goto('/')
  await page.getByText('Unity Inspector Test').locator('xpath=../..').getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
})

test('player properties and blessings are separate battle tabs, with no player intent tab', async ({ page }) => {
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '玩家', exact: true })).toHaveCount(0)
  const inspector = page.getByRole('complementary', { name: '对象检查器' })
  await inspector.getByRole('tab', { name: '意图', exact: true }).click()
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  await expect(inspector.getByRole('tab', { name: '意图', exact: true })).toHaveCount(0)
  await expect(inspector.getByRole('tab', { name: '属性', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('heading', { name: '持有祝福' })).toHaveCount(0)
  await inspector.getByRole('tab', { name: '祝福', exact: true }).click()
  await expect(inspector.getByRole('tab', { name: '祝福', exact: true })).toHaveCSS('border-bottom-color', 'rgb(196, 69, 54)')
  await expect(inspector.getByRole('heading', { name: '持有祝福' })).toBeVisible()
  await inspector.getByRole('button', { name: '添加祝福', exact: true }).click()
  await expect(inspector.getByRole('button', { name: '移除 试炼祝福', exact: true })).toBeVisible()
  await expect(inspector.getByRole('button', { name: '添加祝福', exact: true })).toBeDisabled()
  page.once('dialog', (dialog) => void dialog.accept())
  await inspector.getByRole('button', { name: '移除 试炼祝福', exact: true }).click()
  await expect(inspector.getByText('当前没有祝福', { exact: true })).toBeVisible()
  await inspector.getByRole('tab', { name: '属性', exact: true }).click()
  await inspector.getByLabel('当前生命', { exact: true }).fill('42')
  await inspector.getByRole('button', { name: '应用属性', exact: true }).click()
  await expect(inspector.getByLabel('当前生命', { exact: true })).toHaveValue('42')
  await inspector.getByRole('tab', { name: '祝福', exact: true }).click()
  await page.getByRole('button', { name: '选择 测试怪物', exact: true }).click()
  await expect(inspector.getByRole('tab', { name: '祝福', exact: true })).toHaveCount(0)
  await expect(inspector.getByRole('tab', { name: '属性', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('tab', { name: '意图', exact: true })).toBeVisible()
})

test('blessing errors do not fabricate owned state, and pending or empty choices are disabled', async ({ page }) => {
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '对象检查器' })
  await inspector.getByRole('tab', { name: '祝福', exact: true }).click()
  const add = inspector.getByRole('button', { name: '添加祝福', exact: true })
  await page.evaluate(() => Object.assign((window as unknown as { inspectorTest: object }).inspectorTest, { failBlessing: true, delayBlessing: true }))
  await add.click()
  await expect(add).toBeDisabled()
  await expect(inspector.getByLabel('选择祝福')).toBeDisabled()
  await page.screenshot({ path: 'test-results/blessing-loading.png' })
  await page.evaluate(() => (window as unknown as { inspectorTest: { finish: () => void } }).inspectorTest.finish())
  await expect(inspector.getByText('祝福添加失败，请刷新后重试。', { exact: true })).toBeVisible()
  await expect(inspector.getByText('当前没有祝福', { exact: true })).toBeVisible()
  await expect(add).toBeEnabled()
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  await page.screenshot({ path: 'test-results/blessing-error.png' })
  await page.evaluate(() => Object.assign((window as unknown as { inspectorTest: object }).inspectorTest, { empty: true }))
  await page.getByRole('button', { name: '刷新运行时状态', exact: true }).click()
  await expect(add).toBeDisabled()
  await expect(page.getByLabel('放置装备', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '放置到 0, 0', exact: true })).toBeDisabled()
})

test('long names and TypeIds wrap within battle panels', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.evaluate(() => Object.assign((window as unknown as { inspectorTest: object }).inspectorTest, { longNames: true }))
  await page.getByRole('button', { name: '刷新运行时状态', exact: true }).click()
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  await page.getByRole('tab', { name: '祝福', exact: true }).click()
  for (const typeId of ['Blessing_With_A_Very_Long_Registered_TypeId_0123456789', 'Equipment_With_A_Very_Long_Registered_TypeId_0123456789']) {
    const label = page.getByText(typeId, { exact: true })
    await label.scrollIntoViewIfNeeded()
    await expect(label).toBeVisible()
    const fits = await label.evaluate((element) => element.scrollWidth <= element.clientWidth)
    expect(fits).toBe(true)
  }
  await page.screenshot({ path: 'test-results/battle-long-identifiers.png' })
})

test('blessing and equipment choices retain both names and TypeIds', async ({ page }) => {
  await expect(page.getByLabel('放置装备', { exact: true }).locator('option')).toHaveText('测试长剑 · Equipment01')
  await expect(page.getByText('Equipment01', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  await page.getByRole('tab', { name: '祝福', exact: true }).click()
  await expect(page.getByLabel('选择祝福').locator('option')).toHaveText('试炼祝福 · Blessing01')
  await expect(page.getByRole('complementary', { name: '对象检查器' }).getByText('Blessing01', { exact: true })).toBeVisible()
  await expect(page.getByText('LIVE OBJECTS', { exact: true })).toHaveCount(0)
})

test('battle properties remain reachable at supported desktop sizes', async ({ page }) => {
  for (const [width, height] of [[1440, 900], [1180, 720], [1100, 680]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await page.getByRole('button', { name: '选择 主角', exact: true }).click()
    const inspector = page.getByRole('complementary', { name: '对象检查器' })
    await expect(inspector).toBeVisible()
    await inspector.getByLabel('当前生命', { exact: true }).scrollIntoViewIfNeeded()
    const bounds = await inspector.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width!)
    await inspector.getByRole('tab', { name: '属性', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(inspector.getByRole('tab', { name: '祝福', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(inspector.getByRole('tab', { name: 'BUFF', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(inspector.getByRole('tab', { name: '属性', exact: true })).toBeFocused()
    await page.screenshot({ path: `test-results/battle-inspector-${width}.png` })
  }
})

test('card actions are discoverable and the owned badge differs from cost', async ({ page }) => {
  await page.getByRole('button', { name: '卡牌', exact: true }).click()
  await expect(page.getByText('CARD REGISTRY', { exact: true })).toHaveCount(0)
  const card = page.getByRole('button', { name: /测试手牌/ })
  await card.hover()
  await expect(page.getByRole('tooltip')).toContainText('左键获得 1 张，右键删除 1 张')
  const cost = card.getByTestId('card-cost')
  const owned = card.getByTestId('card-owned-count')
  await expect(owned).toContainText('3')
  const costStyle = await cost.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }))
  const ownedStyle = await owned.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }))
  expect(ownedStyle.color).not.toBe(costStyle.color)
  expect(ownedStyle.background).not.toBe(costStyle.background)
  expect(ownedStyle.radius).not.toBe(costStyle.radius)
  const costBox = (await cost.boundingBox())!
  const ownedBox = (await owned.boundingBox())!
  expect(ownedBox.x + ownedBox.width).toBeLessThanOrEqual(costBox.x)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: 'test-results/card-owned-desktop.png' })
})
