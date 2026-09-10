import { expect, test } from '@playwright/test'
import type { BridgeRequest, OperationResult, QaBattleSnapshot, QaCatalog } from '@shared/contracts'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const controls = { failBlessing: false, delayBlessing: false, failPlacement: false, empty: false, longNames: false, finish: () => undefined as void, requests: [] as BridgeRequest[] }
    Object.assign(window, { inspectorTest: controls })
    const instance = { instanceId: 'inspector-test', kind: 'editor', processId: 4567, displayName: 'Unity Inspector Test', gameVersion: '1.0', sceneName: 'Battle', port: 12345, lastSeenAt: new Date().toISOString() }
    const catalog: QaCatalog = {
      cards: [{ typeId: 'Card01', name: '测试手牌', description: '造成伤害。', category: 'effect', cost: 2, rarity: 'common', tags: [] }],
      equipment: [{ typeId: 'Equipment01', name: '测试长剑' }, { typeId: 'Equipment02', name: '测试圆盾' }],
      buffs: [{ typeId: 'Buff01', name: '力量增幅', description: '提高攻击。', supportsStacks: true, supportsDuration: false }],
      blessings: [{ typeId: 'Blessing01', name: '试炼祝福', description: '提高生命上限。' }],
      intents: [{ typeId: 'Attack01', name: '普通攻击', description: '', parameters: [] }]
    }
    const battle: QaBattleSnapshot = {
      available: true, sceneName: 'Battle', mapName: 'TestMap', width: 7, height: 7, turn: 1, phase: '玩家行动',
      player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 50, maxHp: 80, currentCost: 2, maxCost: 4, shield: 6, baseAttack: 7, attack: 11, gold: 120, blessings: [], buffs: [] },
      entities: [{ instanceId: 'enemy-01#0', typeId: 'Enemy01', name: '测试怪物', kind: 'enemy', position: { x: 1, y: 1 }, currentHp: 30, maxHp: 30, baseAttack: 8, attack: 12, buffs: [{ instanceId: 'buff-0', typeId: 'Buff01', name: '力量增幅', stacks: 2, description: '提高攻击。' }], intents: [{ instanceId: 'intent-0', typeId: 'Attack01', name: '普通攻击', summary: '攻击主角。', parameters: { enabled: true, signal: 'DashStart', damage: 6 }, groupIndex: 0 }] }],
      routePreview: { startPosition: { x: 0, y: 0 }, steps: [{ x: 0, y: 1 }, { x: -1, y: 1 }], hasLoop: false, hasTerminalPosition: true, terminalPosition: { x: -1, y: 1 }, stopReason: 'MovementExhausted' }
    }
    window.qaNative = {
      listBridgeInstances: async () => [instance],
      connectBridge: async () => ({ ok: true, message: '已连接。', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        controls.requests.push(structuredClone(request))
        if (request.path === '/api/catalog') {
          const snapshot = structuredClone(catalog)
          if (controls.empty) { snapshot.blessings = []; snapshot.equipment = [] }
          if (controls.longNames) {
            snapshot.blessings = [{ typeId: 'Blessing_With_A_Very_Long_Registered_TypeId_0123456789', name: '试炼祝福的完整中文名称', description: '' }]
            snapshot.equipment = [{ typeId: 'Equipment_With_A_Very_Long_Registered_TypeId_0123456789', name: '测试装备的完整中文名称' }]
          }
          return { ok: true, message: '', data: snapshot as T }
        }
        if (request.path === '/api/battle/route-preview') return { ok: true, message: '', data: structuredClone(battle.routePreview) as T }
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
        if (request.path === '/api/equipment') {
          const moveTargetId = (request.body as { moveTargetId: string }).moveTargetId
          battle.entities = battle.entities.filter((entity) => entity.moveTargetId !== moveTargetId)
        }
        if (request.path === '/api/buffs' && request.method === 'PATCH') {
          const body = request.body as { targetInstanceId: string; instanceId: string; stacks: number }
          const target = battle.entities.find((entity) => entity.instanceId === body.targetInstanceId)
          const buff = target?.buffs.find((item) => item.instanceId === body.instanceId)
          if (buff) buff.stacks = body.stacks
        }
        if (request.path === '/api/intents') {
          const body = request.body as { instanceId: string; steps: Array<{ typeId: string; groupIndex: number }> }
          const target = battle.entities.find((entity) => entity.instanceId === body.instanceId)
          if (target) target.intents = body.steps.map((step, index) => ({ instanceId: `intent-${index}`, typeId: step.typeId, name: step.typeId === 'Attack01' ? '普通攻击' : step.typeId, summary: '', parameters: {}, groupIndex: step.groupIndex }))
        }
        if (request.path === '/api/gm') {
          if (controls.failPlacement) return { ok: false, message: '格子被占用。' }
          const [, typeId, x, y] = (request.body as { command: string }).command.split(' ')
          if (typeId !== 'Equipment01') throw new Error('Unexpected equipment TypeId')
          battle.entities.push({ instanceId: `equipment#${battle.entities.length}`, moveTargetId: `equipment-${battle.entities.length}`, typeId, name: '测试长剑', kind: 'equipment', position: { x: Number(x), y: Number(y) }, buffs: [] })
        }
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
  await expect(inspector.getByRole('tab', { name: '祝福', exact: true })).toHaveCSS('border-bottom-color', 'rgb(198, 164, 81)')
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

test('player base values, effective attack and BUFF stacks use the runtime mutation routes', async ({ page }) => {
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '对象检查器' })
  await expect(inspector.getByText('11', { exact: true })).toBeVisible()
  await inspector.getByLabel('护盾', { exact: true }).fill('9')
  await inspector.getByLabel('基础攻击', { exact: true }).fill('10')
  await inspector.getByLabel('金币', { exact: true }).fill('345')
  await inspector.getByRole('button', { name: '应用属性', exact: true }).click()
  const playerBody = await page.evaluate(() => {
    const requests = (window as unknown as { inspectorTest: { requests: BridgeRequest[] } }).inspectorTest.requests
    return requests.slice().reverse().find((request) => request.path === '/api/player')?.body
  })
  expect(playerBody).toMatchObject({ shield: 9, baseAttack: 10, gold: 345 })
  expect(playerBody).not.toMatchObject({ baseAttack: 11 })

  await page.getByRole('button', { name: '选择 测试怪物', exact: true }).click()
  await inspector.getByRole('tab', { name: 'BUFF', exact: true }).click()
  const stacks = inspector.locator('input[name="buff-buff-0-stacks"]')
  await stacks.fill('4')
  await inspector.getByRole('button', { name: '保存 力量增幅 层数', exact: true }).click()
  const buffRequest = await page.evaluate(() => {
    const requests = (window as unknown as { inspectorTest: { requests: BridgeRequest[] } }).inspectorTest.requests
    return requests.slice().reverse().find((request) => request.path === '/api/buffs' && request.method === 'PATCH')
  })
  expect(buffRequest?.body).toEqual({ targetInstanceId: 'enemy-01#0', instanceId: 'buff-0', typeId: 'Buff01', stacks: 4 })
  await expect(stacks).toHaveValue('4')
})

test('intent drafts survive automatic refresh and retain registered TypeIds', async ({ page }) => {
  await page.getByRole('button', { name: '选择 测试怪物', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '对象检查器' })
  await inspector.getByRole('tab', { name: '意图', exact: true }).click()
  await expect(inspector.getByText('Attack01', { exact: true })).toBeVisible()
  const enabled = inspector.locator('input[name="intent-intent-0-enabled"]')
  const signal = inspector.locator('input[name="intent-intent-0-signal"]')
  const damage = inspector.locator('input[name="intent-intent-0-damage"]')
  await expect(enabled).toHaveAttribute('type', 'checkbox')
  await expect(enabled).toBeChecked()
  await expect(signal).toHaveAttribute('type', 'text')
  await expect(signal).toHaveValue('DashStart')
  await expect(damage).toHaveAttribute('type', 'number')
  await enabled.uncheck()
  await signal.fill('DashReady')
  await damage.fill('9')
  await inspector.getByRole('button', { name: '添加意图', exact: true }).click()
  await expect(inspector.getByText('Attack01', { exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: '刷新运行时状态', exact: true }).click()
  await expect(inspector.getByText('Attack01', { exact: true })).toHaveCount(2)
  await inspector.getByRole('button', { name: '应用序列', exact: true }).click()
  const intentBody = await page.evaluate(() => {
    const requests = (window as unknown as { inspectorTest: { requests: BridgeRequest[] } }).inspectorTest.requests
    return requests.slice().reverse().find((request) => request.path === '/api/intents')?.body
  }) as { steps: Array<{ typeId: string; groupIndex: number }> }
  expect(intentBody.steps).toEqual([
    expect.objectContaining({ typeId: 'Attack01', groupIndex: 0, parameters: { enabled: false, signal: 'DashReady', damage: 9 } }),
    expect.objectContaining({ typeId: 'Attack01', groupIndex: 1 })
  ])
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
  await expect(page.getByRole('status').filter({ hasText: '祝福添加失败，请刷新后重试。' })).toBeVisible()
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
  await expect(page.getByRole('combobox', { name: '放置装备', exact: true })).toHaveValue('测试长剑 · Equipment01')
  await expect(page.getByText('Equipment01', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  await page.getByRole('tab', { name: '祝福', exact: true }).click()
  await expect(page.getByLabel('选择祝福').locator('option')).toHaveText('试炼祝福 · Blessing01')
  await expect(page.getByRole('complementary', { name: '对象检查器' }).getByText('Blessing01', { exact: true })).toBeVisible()
  await expect(page.getByText('LIVE OBJECTS', { exact: true })).toHaveCount(0)
})

test('equipment dropdown searches Chinese names and TypeIds and supports keyboard selection', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: '放置装备', exact: true })
  await picker.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(picker).toHaveValue('测试圆盾 · Equipment02')
  await picker.fill('长剑')
  await expect(page.getByRole('option', { name: '测试长剑 Equipment01', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/equipment-search-desktop.png' })
  await picker.fill('equipment01')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(picker).toHaveValue('测试长剑 · Equipment01')
  await expect(page.getByRole('listbox', { name: '装备目录' })).toHaveCount(0)
  await picker.fill('不存在')
  await expect(page.getByText('没有匹配的装备', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveValue('测试长剑 · Equipment01')
})

test('desktop controls use the daisyUI theme and the grid is named Battle Map', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ashes')
  await expect(page.getByRole('heading', { name: '战斗地图', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择 主角', exact: true }).click()
  await expect(page.getByRole('button', { name: '应用属性', exact: true })).toHaveClass(/btn-primary/)
  await expect(page.getByLabel('当前生命', { exact: true })).toHaveClass(/input/)
  await expect(page.getByRole('tablist', { name: '对象详情' })).toHaveClass(/tabs/)
})

test('the help entry opens an offline modal without navigation and restores focus', async ({ page }) => {
  const initialUrl = page.url()
  const help = page.getByRole('button', { name: '使用说明', exact: true })
  await expect(help).toBeVisible()
  await expect(help).toHaveAttribute('title', '使用说明')
  await page.context().setOffline(true)
  await help.click()
  const dialog = page.getByRole('dialog', { name: '使用说明', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '首次启动', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('heading', { name: '连接 Unity Editor', exact: true })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '对象长按拖动', exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('heading', { name: '怪物意图', exact: true })).toHaveCount(1)
  expect(page.context().pages()).toHaveLength(1)
  expect(page.url()).toBe(initialUrl)
  await expect(dialog.getByRole('button', { name: '关闭使用说明', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.screenshot({ path: 'test-results/help-dialog-desktop.png' })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(help).toBeFocused()
  await page.setViewportSize({ width: 1100, height: 680 })
  await help.click()
  await dialog.getByRole('heading', { name: '应用更新', exact: true }).scrollIntoViewIfNeeded()
  const bounds = (await dialog.locator('.modal-box').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(680)
  await page.screenshot({ path: 'test-results/help-dialog-minimum.png' })
  await dialog.getByRole('button', { name: '关闭使用说明', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await help.click()
  await page.mouse.click(8, 8)
  await expect(dialog).toHaveCount(0)
  await expect(help).toBeFocused()
  await page.context().setOffline(false)
})

test('placed equipment appears in both the object list and battle map after refreshing', async ({ page }) => {
  await page.getByRole('button', { name: '选择格 -2, 1', exact: true }).click()
  await page.getByRole('button', { name: '放置到 -2, 1', exact: true }).click()
  const equipment = page.getByTestId('battle-grid').getByRole('button', { name: '选择 测试长剑', exact: true })
  await expect(equipment).toBeVisible()
  await expect(page.getByRole('complementary', { name: '场上对象' }).getByRole('button', { name: /测试长剑.*Equipment01/ })).toBeVisible()
  await equipment.click()
  const inspector = page.getByRole('complementary', { name: '对象检查器' })
  await expect(inspector.getByRole('heading', { name: '测试长剑', exact: true })).toBeVisible()
  await expect(inspector.getByText('Equipment01', { exact: true })).toBeVisible()
  await expect(page.getByText('修改已同步。', { exact: true })).toHaveCount(1)
  await expect(page.getByText('目录与战斗数据已刷新。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.screenshot({ path: 'test-results/placed-equipment-desktop.png' })
  await page.evaluate(() => Object.assign((window as unknown as { inspectorTest: object }).inspectorTest, { failPlacement: true }))
  await page.getByRole('button', { name: '选择格 -1, 1', exact: true }).click()
  await page.getByRole('button', { name: '放置到 -1, 1', exact: true }).click()
  await expect(equipment).toHaveCount(1)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('complementary', { name: '场上对象' }).getByRole('button', { name: '删除 测试长剑', exact: true }).click()
  await expect(equipment).toHaveCount(0)
  const deleteRequest = await page.evaluate(() => {
    const requests = (window as unknown as { inspectorTest: { requests: BridgeRequest[] } }).inspectorTest.requests
    return requests.slice().reverse().find((request) => request.path === '/api/equipment')
  })
  expect(deleteRequest).toMatchObject({ method: 'DELETE', body: { moveTargetId: 'equipment-1' } })
})

test('battle map displays the game-provided predicted route and destination', async ({ page }) => {
  await expect(page.getByTestId('route-preview')).toBeVisible()
  await expect(page.getByTestId('route-summary')).toHaveText('预计路线 2 格 · 预计终点 -1, 1 · 移动力耗尽')
  const overlay = page.getByTestId('route-preview')
  await expect(overlay.locator('path[marker-end]')).toHaveAttribute('d', /M .+ L .+ L/)
  await expect(overlay.locator('circle')).toHaveCount(2)
  const requestedRoute = await page.evaluate(() => (window as unknown as { inspectorTest: { requests: BridgeRequest[] } }).inspectorTest.requests.some((request) => request.path === '/api/battle/route-preview'))
  expect(requestedRoute).toBe(true)
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
  await page.getByRole('checkbox', { name: '已持有', exact: true }).check()
  await expect(page.getByRole('checkbox', { name: '已持有', exact: true })).toBeChecked()
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
