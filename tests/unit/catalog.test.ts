import { describe, expect, it } from 'vitest'
import { baseCardTypeId, isUpgradedCard, resolveEntityImageUrl } from '@shared/catalog'
import type { QaCatalog } from '@shared/contracts'

const catalog: QaCatalog = {
  cards: [
    { typeId: 'Card07', name: '军团短剑', description: '', category: 'equipment', cost: 0, rarity: 'common', tags: [], imageUrl: 'data:image/png;base64,CARD07' },
    { typeId: 'Card07Plus', name: '军团短剑+', description: '', category: 'equipment', cost: 0, rarity: 'common', tags: [] }
  ],
  equipment: [
    { typeId: 'Card07', name: '军团短剑', iconUrl: 'data:image/png;base64,PROP07' },
    { typeId: 'Card07Plus', name: '军团短剑+', iconUrl: 'data:image/png;base64,PROP07PLUS' }
  ],
  enemies: [{ typeId: 'Enemy00A', name: '狼', iconUrl: 'data:image/png;base64,ENEMY00A' }],
  buffs: [],
  blessings: [],
  intents: []
}

describe('catalog helpers', () => {
  it('detects upgraded card TypeIds and their base TypeId', () => {
    expect(isUpgradedCard('Card07Plus')).toBe(true)
    expect(isUpgradedCard('Card07')).toBe(false)
    expect(isUpgradedCard('Enemy27SummonCard')).toBe(false)
    expect(baseCardTypeId('Card07Plus')).toBe('Card07')
    expect(baseCardTypeId('Card07')).toBe('Card07')
  })

  it('resolves the real enemy artwork from the catalog', () => {
    expect(resolveEntityImageUrl(catalog, { kind: 'enemy', typeId: 'Enemy00A' })).toBe('data:image/png;base64,ENEMY00A')
    expect(resolveEntityImageUrl(catalog, { kind: 'enemy', typeId: 'Enemy99A' })).toBeUndefined()
  })

  it('prefers the field prop artwork over the card artwork for equipment', () => {
    expect(resolveEntityImageUrl(catalog, { kind: 'equipment', typeId: 'Card07' })).toBe('data:image/png;base64,PROP07')
    expect(resolveEntityImageUrl(catalog, { kind: 'equipment', typeId: 'Card07Plus' })).toBe('data:image/png;base64,PROP07PLUS')
  })

  it('falls back to card artwork when a prop or enemy entry is missing', () => {
    const legacy: QaCatalog = { ...catalog, equipment: [], enemies: undefined }
    expect(resolveEntityImageUrl(legacy, { kind: 'equipment', typeId: 'Card07' })).toBe('data:image/png;base64,CARD07')
    expect(resolveEntityImageUrl(legacy, { kind: 'enemy', typeId: 'Enemy00A' })).toBeUndefined()
    expect(resolveEntityImageUrl(legacy, { kind: 'player', typeId: 'MainCharacter' })).toBeUndefined()
  })
})
