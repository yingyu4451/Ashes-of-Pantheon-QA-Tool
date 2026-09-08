import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useQaStore } from '@/stores/qa'

describe('QA store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('combines category, cost, and rarity filters', () => {
    const store = useQaStore()
    store.selectedCategories = ['equipment']
    store.selectedCosts = [0]
    store.selectedRarities = ['rare']

    expect(store.filteredCards.map((card) => card.typeId)).toEqual(['GuardCharm'])
    expect(store.activeFilterCount).toBe(3)
  })

  it('filters to owned cards and clears ownership with the other filters', () => {
    const store = useQaStore()
    store.ownedCardCounts = { Greatsword: 2, GuardCharm: 1 }
    store.selectedOwnedOnly = true

    expect(store.filteredCards.map((card) => card.typeId)).toEqual(['Greatsword', 'GuardCharm'])
    expect(store.activeFilterCount).toBe(1)

    store.clearFilters()
    expect(store.selectedOwnedOnly).toBe(false)
  })

  it('sorts cards by descending cost', () => {
    const store = useQaStore()
    store.sortKey = 'cost'
    store.sortDirection = 'desc'

    const costs = store.filteredCards.map((card) => card.cost)
    expect(costs).toEqual([...costs].sort((left, right) => right - left))
  })

  it('sorts cards by TypeId with numeric segments', () => {
    const store = useQaStore()
    store.catalog.cards = [
      { ...store.catalog.cards[0]!, typeId: 'Card10' },
      { ...store.catalog.cards[1]!, typeId: 'card2' },
      { ...store.catalog.cards[2]!, typeId: 'Card1' }
    ]
    store.sortKey = 'typeId' as typeof store.sortKey
    store.sortDirection = 'asc'

    expect(store.filteredCards.map((card) => card.typeId)).toEqual(['Card1', 'card2', 'Card10'])
  })

  it('places equipment only on an empty selected cell', async () => {
    const store = useQaStore()
    store.selectedEquipmentTypeId = 'Greatsword'
    store.selectCell({ x: 2, y: 2 })

    expect(await store.placeEquipment()).toBe(true)
    expect(store.battle.entities.some((entity) => entity.kind === 'equipment' && entity.position.x === 2 && entity.position.y === 2)).toBe(true)
    expect(await store.placeEquipment()).toBe(false)
  })

  it('reconciles catalog selections after an asynchronous catalog update', async () => {
    const store = useQaStore()
    store.selectedEquipmentTypeId = 'MissingEquipment'
    store.catalog = {
      cards: [],
      equipment: [{ typeId: 'Equipment01', name: '测试装备' }],
      buffs: [{ typeId: 'Buff01', name: '测试增益', description: '', supportsStacks: true, supportsDuration: false }],
      blessings: [{ typeId: 'Donum01', name: '测试祝福', description: '' }],
      intents: [{ typeId: 'Intent01', name: '测试意图', description: '', parameters: [] }]
    }
    await nextTick()

    expect({
      equipment: store.selectedEquipmentTypeId,
      buff: store.selectedBuffTypeId,
      blessing: store.selectedBlessingTypeId,
      intent: store.selectedIntentTypeId
    }).toEqual({
      equipment: 'Equipment01',
      buff: 'Buff01',
      blessing: 'Donum01',
      intent: 'Intent01'
    })
  })
})
