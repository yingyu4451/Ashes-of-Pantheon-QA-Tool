import type { QaCatalog, QaCard, QaCatalogSpriteEntry, QaEntity } from './contracts.js'

const UPGRADED_SUFFIX = 'Plus'

/** Upgraded cards share the base TypeId with a `Plus` suffix (Card07 / Card07Plus). */
export function isUpgradedCard(typeId: string): boolean {
  return typeId.endsWith(UPGRADED_SUFFIX)
}

/** Base TypeId of an upgraded card, or the TypeId itself when it has no upgraded variant. */
export function baseCardTypeId(typeId: string): string {
  return isUpgradedCard(typeId) ? typeId.slice(0, -UPGRADED_SUFFIX.length) : typeId
}

/**
 * Resolves the real in-game artwork for a battle entity.
 * Enemies and equipment come from the bridge catalog; anything without a
 * matching sprite returns undefined and the caller keeps its placeholder icon.
 */
export function resolveEntityImageUrl(catalog: QaCatalog | null | undefined, entity: Pick<QaEntity, 'kind' | 'typeId'> | null | undefined): string | undefined {
  if (!catalog || !entity || !entity.typeId) return undefined
  const typeId = entity.typeId
  const candidates: Array<string | undefined> = []

  if (entity.kind === 'enemy') {
    candidates.push(findIcon(catalog.enemies, typeId))
  } else if (entity.kind === 'equipment') {
    candidates.push(findIcon(catalog.equipment, typeId), findCardImage(catalog, typeId))
    if (isUpgradedCard(typeId)) candidates.push(findCardImage(catalog, baseCardTypeId(typeId)))
  }

  return candidates.find((value): value is string => Boolean(value))
}

function findIcon(entries: QaCatalogSpriteEntry[] | undefined, typeId: string): string | undefined {
  return entries?.find((entry) => entry.typeId === typeId)?.iconUrl
}

function findCardImage(catalog: QaCatalog, typeId: string): string | undefined {
  return catalog.cards.find((card: QaCard) => card.typeId === typeId)?.imageUrl
}
