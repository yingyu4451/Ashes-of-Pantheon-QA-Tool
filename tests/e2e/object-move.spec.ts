import { expect, test, type Page } from '@playwright/test'
import type { BridgeRequest, OperationResult, QaBattleSnapshot } from '@shared/contracts'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const control = { moves: [] as unknown[], fail: false, delay: false, finish: () => undefined as void }
    Object.assign(window, { moveTest: control })
    const instance = { instanceId: 'move-test', kind: 'editor', processId: 1, displayName: 'Drag QA', gameVersion: '1', sceneName: 'Battle', port: 1234, lastSeenAt: new Date().toISOString() }
    const snapshot = {
      available: true, sceneName: 'Battle', mapName: 'MoveMap', width: 7, height: 7, turn: 1, phase: '玩家行动', movement: { allowed: true, reason: '' },
      player: { instanceId: 'player-main', moveTargetId: '101', name: '主角', position: { x: 0, y: 0 }, currentHp: 80, maxHp: 80, currentCost: 3, maxCost: 3, blessings: [], buffs: [] },
      entities: [
        { instanceId: 'Enemy01#0', moveTargetId: '102', typeId: 'Enemy01', name: '测试怪物', kind: 'enemy', position: { x: 1, y: 1 }, buffs: [] },
        { instanceId: 'equipment#103', moveTargetId: '103', typeId: 'Equipment01', name: '测试装备', kind: 'equipment', position: { x: -1, y: 1 }, buffs: [] }
      ]
    } as QaBattleSnapshot
    Object.assign(control, { snapshot })
    window.qaNative = {
      readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }), readCatalogCache: async () => null, writeCatalogCache: async () => ({ ok: true, message: '' }),
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: 'test', message: '' }), onUpdateStatus: () => () => undefined,
      listBridgeInstances: async () => [instance], connectBridge: async () => ({ ok: true, message: '', data: instance }),
      requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
        if (request.path === '/api/catalog') return { ok: true, message: '', data: { cards: [], equipment: [], buffs: [], blessings: [], intents: [] } as T }
        if (request.path === '/api/cards') return { ok: true, message: '', data: { available: true, cards: [] } as T }
        if (request.path === '/api/battle') return { ok: true, message: '', data: structuredClone(snapshot) as T }
        if (request.path === '/api/entities/move') {
          control.moves.push(request.body)
          if (control.delay) await new Promise<void>((resolve) => { control.finish = resolve })
          if (control.fail) return { ok: true, message: '', data: { success: false, message: '游戏拒绝移动：目标不可通行。' } as T }
          const body = request.body as { moveTargetId: string; to: { x: number; y: number } }
          const target = [snapshot.player, ...snapshot.entities].find((item) => item.moveTargetId === body.moveTargetId)!
          target.position = body.to
          return { ok: true, message: '', data: { success: true, message: '对象已移动。' } as T }
        }
        return { ok: false, message: 'unexpected route' }
      }
    } as unknown as typeof window.qaNative
  })
  await page.goto('/')
  await page.getByText('Drag QA', { exact: true }).locator('xpath=../..').getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.clock.install()
})

async function pressObject(page: Page, name: string, duration = 650) {
  const object = page.getByTestId('battle-grid').getByRole('button', { name: `选择 ${name}`, exact: true })
  await object.hover()
  await page.mouse.down()
  await page.clock.runFor(duration)
  return object
}

async function pointAt(page: Page, x: number, y: number) {
  const box = (await page.getByRole('button', { name: `选择格 ${x}, ${y}`, exact: true }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

test('long press shows progress and commits a game movement only on drop', async ({ page }) => {
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const object = await pressObject(page, '主角', 300)
  const progress = page.getByRole('progressbar', { name: '长按移动进度' })
  await expect(progress).toBeVisible()
  const percent = Number(await progress.getAttribute('aria-valuenow'))
  expect(percent).toBeGreaterThan(0)
  expect(percent).toBeLessThan(100)
  await page.screenshot({ path: 'test-results/object-hold-progress.png' })
  await page.clock.runFor(350)
  await pointAt(page, -2, -2)
  await expect(page.getByTestId('move-preview')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(0)
  await page.screenshot({ path: 'test-results/object-drag-preview.png' })
  await page.mouse.up()
  await expect(object).toHaveAttribute('data-grid-position', '-2,-2')
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toEqual([{ moveTargetId: '101', from: { x: 0, y: 0 }, to: { x: -2, y: -2 } }])
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  await expect(page.getByText('对象已移动。', { exact: true })).toHaveCount(1)
  await page.clock.runFor(180)
  await expect(page.getByRole('status').filter({ hasText: '对象已移动。' })).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/notice-single-result.png' })
  await page.clock.runFor(2200)
  await expect(page.getByText('对象已移动。', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/notice-after-dismissal.png' })
})

test('short press, early motion, Escape, window blur and off-map drops never move the game', async ({ page }) => {
  await pressObject(page, '主角', 250)
  await page.mouse.up()
  await expect(page.getByRole('complementary', { name: '对象检查器' }).getByRole('heading', { name: '主角', exact: true })).toBeVisible()
  await pressObject(page, '主角', 200)
  await pointAt(page, -2, -2)
  await page.clock.runFor(650)
  await page.mouse.up()
  await pressObject(page, '主角')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await pressObject(page, '主角')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  await pressObject(page, '主角')
  await page.mouse.move(5, 5)
  await page.mouse.up()
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(0)
  await page.getByRole('complementary', { name: '场上对象' }).getByRole('button', { name: /测试怪物/ }).click()
  await expect(page.getByRole('complementary', { name: '对象检查器' }).getByRole('heading', { name: '测试怪物', exact: true })).toBeVisible()
})

test('occupied drops are cancelled and server failures retain the actual position', async ({ page }) => {
  const object = await pressObject(page, '测试装备')
  await pointAt(page, 1, 1)
  await page.mouse.up()
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(0)
  await page.evaluate(() => { (window as unknown as { moveTest: { fail: boolean } }).moveTest.fail = true })
  await pressObject(page, '测试装备')
  await pointAt(page, -2, -2)
  await page.mouse.up()
  await expect(object).toHaveAttribute('data-grid-position', '-1,1')
  await expect(page.getByRole('status').filter({ hasText: '游戏拒绝移动' }).first()).toBeVisible()
})

test('a delayed movement keeps the original position and blocks duplicate drags until confirmed', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as { moveTest: { delay: boolean } }).moveTest.delay = true })
  const object = await pressObject(page, '测试怪物')
  await pointAt(page, 2, -2)
  await page.mouse.up()
  await expect(object).toHaveAttribute('data-grid-position', '1,1')
  await expect(page.getByRole('status').filter({ hasText: '正在同步游戏位置' })).toBeVisible()
  await pressObject(page, '主角')
  await page.mouse.up()
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(1)
  await page.evaluate(() => (window as unknown as { moveTest: { finish: () => void } }).moveTest.finish())
  await expect(object).toHaveAttribute('data-grid-position', '2,-2')
})

test('keyboard and click targeting use the same movement command at minimum desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 680 })
  await page.getByTestId('battle-grid').getByRole('button', { name: '选择 主角', exact: true }).click()
  await page.getByRole('button', { name: '移动所选对象', exact: true }).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('battle-grid').getByRole('button', { name: '选择 主角', exact: true })).toHaveAttribute('data-grid-position', '0,-1')
  await page.getByRole('button', { name: '移动所选对象', exact: true }).click()
  await page.getByRole('button', { name: '选择格 -2, -2', exact: true }).click()
  await expect(page.getByTestId('battle-grid').getByRole('button', { name: '选择 主角', exact: true })).toHaveAttribute('data-grid-position', '-2,-2')
  await page.screenshot({ path: 'test-results/object-move-minimum.png' })
})

test('older Bridges and busy battle snapshots disable movement', async ({ page }) => {
  await pressObject(page, '主角')
  await page.evaluate(() => {
    const snapshot = (window as unknown as { moveTest: { snapshot: QaBattleSnapshot } }).moveTest.snapshot
    snapshot.movement = { allowed: false, reason: '战斗正在结算。' }
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  await page.mouse.up()
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(0)
  await page.evaluate(() => {
    const snapshot = (window as unknown as { moveTest: { snapshot: QaBattleSnapshot } }).moveTest.snapshot
    snapshot.movement = undefined
    snapshot.player.moveTargetId = undefined
  })
  await page.getByRole('button', { name: '刷新运行时状态' }).click()
  await pressObject(page, '主角')
  await page.mouse.up()
  await expect(page.getByRole('progressbar', { name: '长按移动进度' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '移动所选对象' })).toBeDisabled()
})

test('snapshot changes, pointer cancellation and workspace switches clear a drag', async ({ page }) => {
  const target = await pressObject(page, '测试装备')
  await target.dispatchEvent('pointercancel')
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  await page.mouse.up()
  await pressObject(page, '测试怪物')
  await page.evaluate(() => {
    const snapshot = (window as unknown as { moveTest: { snapshot: QaBattleSnapshot } }).moveTest.snapshot
    snapshot.entities = snapshot.entities.filter((item) => item.moveTargetId !== '102')
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  await page.mouse.up()
  await pressObject(page, '主角')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '卡牌' }).dispatchEvent('click')
  await expect(page.getByTestId('move-preview')).toHaveCount(0)
  await page.mouse.up()
  expect(await page.evaluate(() => (window as unknown as { moveTest: { moves: unknown[] } }).moveTest.moves)).toHaveLength(0)
})
