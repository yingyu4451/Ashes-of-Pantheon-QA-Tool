import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { BridgeRequest, OperationResult, QaBattleSnapshot, QaCatalog, QaCatalogSpriteEntry, QaEntity } from '@shared/contracts'

/** Valid 1x1 PNG standing in for the game-provided texture data URL. */
const ENEMY_TEXTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const EQUIPMENT_TEXTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const CARD_TEXTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** Same-origin URL that never resolves to a real texture, so the <img> fires `error`. */
const BROKEN_TEXTURE = '/__missing-texture__.png'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ enemyTexture, equipmentTexture, cardTexture, brokenTexture }) => {
      const instance = { instanceId: 'sprite-test', kind: 'editor', processId: 4567, displayName: 'Unity Sprite Test', gameVersion: '1.0', sceneName: 'Battle', port: 12345, lastSeenAt: new Date().toISOString() }
      const equipment: QaCatalogSpriteEntry[] = [
        { typeId: 'Equipment01', name: '测试长剑', iconUrl: equipmentTexture },
        { typeId: 'Card07Plus', name: '测试升级装备' },
        { typeId: 'Equipment04', name: '测试缺图盾' }
      ]
      const catalog: QaCatalog = {
        cards: [{ typeId: 'Card07', name: '测试手牌', description: '', category: 'effect', cost: 1, rarity: 'common', tags: [], imageUrl: cardTexture }],
        equipment,
        enemies: [{ typeId: 'Enemy01', name: '测试怪物', iconUrl: enemyTexture }, { typeId: 'Enemy02', name: '测试坏图怪', iconUrl: brokenTexture }],
        buffs: [{ typeId: 'Buff01', name: '力量增幅', description: '', supportsStacks: true, supportsDuration: false }],
        blessings: [{ typeId: 'Blessing01', name: '试炼祝福', description: '' }],
        intents: [{ typeId: 'Attack01', name: '普通攻击', description: '', parameters: [] }]
      }
      const battle: QaBattleSnapshot = {
        available: true, sceneName: 'Battle', mapName: 'SpriteMap', width: 7, height: 7, turn: 1, phase: '玩家行动',
        player: { instanceId: 'player-main', name: '主角', position: { x: 0, y: 0 }, currentHp: 50, maxHp: 80, currentCost: 2, maxCost: 4, shield: 0, baseAttack: 7, attack: 7, gold: 0, blessings: [], buffs: [] },
        entities: [
          { instanceId: 'enemy-01#0', typeId: 'Enemy01', name: '测试怪物', kind: 'enemy', position: { x: 1, y: 1 }, currentHp: 30, maxHp: 30, buffs: [] },
          { instanceId: 'enemy-02#0', typeId: 'Enemy02', name: '测试坏图怪', kind: 'enemy', position: { x: 1, y: 2 }, currentHp: 30, maxHp: 30, buffs: [] }
        ],
        routePreview: { startPosition: { x: 0, y: 0 }, steps: [{ x: 0, y: 1 }], hasLoop: false, hasTerminalPosition: true, terminalPosition: { x: 0, y: 1 }, stopReason: 'MovementExhausted' }
      }
      let nextEntityIndex = 0
      window.qaNative = {
        listBridgeInstances: async () => [instance],
        connectBridge: async () => ({ ok: true, message: '已连接。', data: instance }),
        requestBridge: async <T>(request: BridgeRequest): Promise<OperationResult<T>> => {
          if (request.path === '/api/catalog') return { ok: true, message: '', data: structuredClone(catalog) as T }
          if (request.path === '/api/battle/route-preview') return { ok: true, message: '', data: structuredClone(battle.routePreview) as T }
          if (request.path === '/api/battle') return { ok: true, message: '', data: structuredClone(battle) as T }
          if (request.path === '/api/cards') return { ok: true, message: '', data: { available: true, cards: [] } as T }
          if (request.path === '/api/blessings') return { ok: true, message: '', data: { success: true } as T }
          if (request.path === '/api/gm') {
            const [, typeId, x, y] = (request.body as { command: string }).command.split(' ')
            const entry = catalog.equipment.find((item) => item.typeId === typeId)
            if (!entry) throw new Error(`Unexpected equipment TypeId ${String(typeId)}`)
            const index = nextEntityIndex++
            const entity: QaEntity = {
              instanceId: `equipment#${index}`,
              moveTargetId: `equipment-${index}`,
              typeId: entry.typeId,
              name: entry.name,
              kind: 'equipment',
              position: { x: Number(x), y: Number(y) },
              buffs: []
            }
            battle.entities.push(entity)
            return { ok: true, message: '修改已同步。', data: { success: true, message: '修改已同步。' } as T }
          }
          if (request.path === '/api/equipment') {
            const moveTargetId = (request.body as { moveTargetId: string }).moveTargetId
            battle.entities = battle.entities.filter((entity) => entity.moveTargetId !== moveTargetId)
          }
          return { ok: true, message: '修改已同步。', data: { success: true, message: '修改已同步。' } as T }
        },
        readCatalogCache: async () => null,
        writeCatalogCache: async () => ({ ok: true, message: '' }),
        readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
        getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.4', message: '开发模式不检查更新。' }),
        onUpdateStatus: () => () => undefined
      } as unknown as typeof window.qaNative
    },
    { enemyTexture: ENEMY_TEXTURE, equipmentTexture: EQUIPMENT_TEXTURE, cardTexture: CARD_TEXTURE, brokenTexture: BROKEN_TEXTURE }
  )
  await page.goto('/')
  await page.getByText('Unity Sprite Test').locator('xpath=../..').getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
})

async function placeEquipment(page: Page, name: string, cell: string): Promise<void> {
  const [x, y] = cell.split(',').map((part) => part.trim())
  await page.getByRole('button', { name: `选择格 ${x}, ${y}`, exact: true }).click()
  const picker = page.getByRole('combobox', { name: '放置装备', exact: true })
  await picker.fill(name)
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await page.getByRole('button', { name: `放置到 ${x}, ${y}`, exact: true }).click()
  const dismiss = page.getByRole('button', { name: '关闭提示', exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
}

function mapEntity(page: Page, name: string) {
  return page.getByTestId('battle-grid').getByRole('button', { name: `选择 ${name}`, exact: true })
}

test('battle map and object list render the enemy catalog texture', async ({ page }) => {
  const texture = mapEntity(page, '测试怪物').locator('img')
  await expect(texture).toHaveCount(1)
  await expect(texture).toHaveAttribute('src', ENEMY_TEXTURE)
  await expect(texture).toHaveClass(/object-contain/)
  expect(await texture.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(await texture.evaluate((element) => getComputedStyle(element).objectFit)).toBe('contain')

  const row = page.getByRole('complementary', { name: '场上对象' }).getByRole('button', { name: /测试怪物 Enemy01/ })
  await expect(row.locator('img')).toHaveAttribute('src', ENEMY_TEXTURE)
  await expect(row.locator('img')).toHaveClass(/object-contain/)
})

test('equipment textures come from the equipment catalog and upgraded equipment falls back to the base card art', async ({ page }) => {
  await placeEquipment(page, '测试长剑', '-2, 1')
  await expect(mapEntity(page, '测试长剑').locator('img')).toHaveAttribute('src', EQUIPMENT_TEXTURE)

  await placeEquipment(page, '测试升级装备', '-2, 0')
  await expect(mapEntity(page, '测试升级装备').locator('img')).toHaveAttribute('src', CARD_TEXTURE)
  await page.screenshot({ path: 'test-results/battle-sprites-textures.png' })
})

test('entities without artwork keep the lucide fallback icon', async ({ page }) => {
  await placeEquipment(page, '测试缺图盾', '-1, 2')
  const plain = mapEntity(page, '测试缺图盾')
  await expect(plain.locator('img')).toHaveCount(0)
  await expect(plain.locator('svg')).toHaveCount(1)

  const player = mapEntity(page, '主角')
  await expect(player.locator('img')).toHaveCount(0)
  await expect(player.locator('svg')).toHaveCount(1)
})

test('a texture that fails to load falls back to the lucide icon', async ({ page }) => {
  const broken = mapEntity(page, '测试坏图怪')
  await expect(broken.locator('img')).toHaveCount(0)
  await expect(broken.locator('svg')).toHaveCount(1)
  await expect(mapEntity(page, '测试怪物').locator('img')).toHaveCount(1)
})
