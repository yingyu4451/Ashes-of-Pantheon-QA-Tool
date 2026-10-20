import { resolveEntityImageUrl } from '@shared/catalog'
import type { QaCatalog, QaEntity } from '@shared/contracts'

/** What an entity tile should render: the real in-game texture or its lucide placeholder. */
export type EntitySpriteSource =
  | { kind: 'image'; src: string }
  | { kind: 'fallback'; reason: 'missing' | 'failed' }

/**
 * Decides between the bridge-provided texture and the lucide fallback icon.
 * `failedSrc` is the texture the browser already failed to decode; it stays a
 * fallback until the catalog serves a different URL (for example after a refresh).
 */
export function resolveEntitySpriteSource(
  catalog: QaCatalog | null | undefined,
  entity: Pick<QaEntity, 'kind' | 'typeId'> | null | undefined,
  failedSrc?: string
): EntitySpriteSource {
  const src = resolveEntityImageUrl(catalog, entity)
  if (!src) return { kind: 'fallback', reason: 'missing' }
  if (failedSrc && failedSrc === src) return { kind: 'fallback', reason: 'failed' }
  return { kind: 'image', src }
}
