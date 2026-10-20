import { describe, expect, it } from 'vitest'
import type { QaCatalog, QaEntity } from '@shared/contracts'
import { resolveEntitySpriteSource } from '@/components/entitySprite'

const ENEMY_ART = 'data:image/png;base64,ENEMY00A'
const PROP_ART = 'data:image/png;base64,PROP07'
const CARD_ART = 'data:image/png;base64,CARD07'

function catalogWith(overrides: Partial<QaCatalog> = {}): QaCatalog {
  return {
    cards: [
      { typeId: 'Card07', name: '军团短剑', description: '', category: 'equipment', cost: 0, rarity: 'common', tags: [], imageUrl: CARD_ART },
      { typeId: 'Card07Plus', name: '军团短剑+', description: '', category: 'equipment', cost: 0, rarity: 'common', tags: [] }
    ],
    equipment: [{ typeId: 'Card07', name: '军团短剑', iconUrl: PROP_ART }],
    enemies: [{ typeId: 'Enemy00A', name: '狼', iconUrl: ENEMY_ART }],
    buffs: [],
    blessings: [],
    intents: [],
    ...overrides
  }
}

function entity(kind: QaEntity['kind'], typeId: string): Pick<QaEntity, 'kind' | 'typeId'> {
  return { kind, typeId }
}

describe('battle entity sprites', () => {
  it('renders the real enemy texture when the catalog has one', () => {
    expect(resolveEntitySpriteSource(catalogWith(), entity('enemy', 'Enemy00A'))).toEqual({ kind: 'image', src: ENEMY_ART })
  })

  it('falls back to the icon when an enemy has no texture or the catalog is legacy', () => {
    expect(resolveEntitySpriteSource(catalogWith(), entity('enemy', 'Enemy99A'))).toEqual({ kind: 'fallback', reason: 'missing' })
    expect(resolveEntitySpriteSource(catalogWith({ enemies: undefined }), entity('enemy', 'Enemy00A'))).toEqual({ kind: 'fallback', reason: 'missing' })
    expect(resolveEntitySpriteSource(catalogWith({ enemies: [{ typeId: 'Enemy00A', name: '狼' }] }), entity('enemy', 'Enemy00A'))).toEqual({ kind: 'fallback', reason: 'missing' })
  })

  it('prefers field artwork over card artwork for equipment and falls back to the base card', () => {
    expect(resolveEntitySpriteSource(catalogWith(), entity('equipment', 'Card07'))).toEqual({ kind: 'image', src: PROP_ART })
    expect(resolveEntitySpriteSource(catalogWith({ equipment: [] }), entity('equipment', 'Card07'))).toEqual({ kind: 'image', src: CARD_ART })
    expect(resolveEntitySpriteSource(catalogWith({ equipment: [] }), entity('equipment', 'Card07Plus'))).toEqual({ kind: 'image', src: CARD_ART })
    expect(resolveEntitySpriteSource(catalogWith(), entity('equipment', 'Card99'))).toEqual({ kind: 'fallback', reason: 'missing' })
  })

  it('never invents artwork for the player or when no catalog is available', () => {
    expect(resolveEntitySpriteSource(catalogWith(), entity('player', 'MainCharacter'))).toEqual({ kind: 'fallback', reason: 'missing' })
    expect(resolveEntitySpriteSource(null, entity('enemy', 'Enemy00A'))).toEqual({ kind: 'fallback', reason: 'missing' })
    expect(resolveEntitySpriteSource(catalogWith(), null)).toEqual({ kind: 'fallback', reason: 'missing' })
  })

  it('replaces a texture that failed to load with the icon fallback', () => {
    expect(resolveEntitySpriteSource(catalogWith(), entity('enemy', 'Enemy00A'), ENEMY_ART)).toEqual({ kind: 'fallback', reason: 'failed' })
    // A refreshed catalog serving different bytes gets another attempt.
    expect(resolveEntitySpriteSource(catalogWith(), entity('enemy', 'Enemy00A'), 'data:image/png;base64,STALE')).toEqual({ kind: 'image', src: ENEMY_ART })
    // Another entity's texture is not affected by a previous failure.
    expect(resolveEntitySpriteSource(catalogWith(), entity('equipment', 'Card07'), ENEMY_ART)).toEqual({ kind: 'image', src: PROP_ART })
  })
})
