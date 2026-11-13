import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

// Content-defined chunking keeps a patch small when large files such as the
// Electron executable shift internally between releases.
const MIN_CHUNK = 4 * 1024
const MAX_CHUNK = 128 * 1024
const AVERAGE_MASK = 32 * 1024 - 1
const COPY_CHUNK = 1024 * 1024

const GEAR = (() => {
  const table = new Uint32Array(256)
  let state = 0x9e3779b9
  for (let index = 0; index < table.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    table[index] = state
  }
  return table
})()

/** A copy from the base file, or a slice of the literal stream. */
export type PatchOp = readonly [kind: 0, copyOffset: number, copyLength: number] | readonly [kind: 1, literalOffset: number, literalLength: number]

export interface ChunkPatch {
  ops: PatchOp[]
  literals: Uint8Array
  copiedBytes: number
}

interface Chunk {
  offset: number
  length: number
  hash: number
}

function* chunks(data: Uint8Array): Generator<Chunk> {
  let start = 0
  while (start < data.length) {
    let hash = 0
    let index = start
    const limit = Math.min(data.length, start + MAX_CHUNK)
    while (index < limit) {
      hash = ((hash << 1) + GEAR[data[index]!]!) >>> 0
      index++
      if (index - start >= MIN_CHUNK && (hash & AVERAGE_MASK) === 0) break
    }
    yield { offset: start, length: index - start, hash }
    start = index
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

/**
 * Builds a copy/literal recipe that reconstructs `next` from `base`.
 * Returns undefined when the base contributes nothing, because a patch that is
 * entirely literal bytes is larger than the file it replaces.
 */
export function createChunkPatch(base: Uint8Array, next: Uint8Array): ChunkPatch | undefined {
  if (base.length === 0 || next.length === 0) return undefined
  const candidates = new Map<string, Chunk[]>()
  for (const chunk of chunks(base)) {
    const key = `${chunk.length}:${chunk.hash}`
    const bucket = candidates.get(key)
    if (bucket) bucket.push(chunk)
    else candidates.set(key, [chunk])
  }

  const ops: PatchOp[] = []
  const literals: Uint8Array[] = []
  let literalBytes = 0
  let copiedBytes = 0
  for (const chunk of chunks(next)) {
    const bytes = next.subarray(chunk.offset, chunk.offset + chunk.length)
    const bucket = candidates.get(`${chunk.length}:${chunk.hash}`)
    const match = bucket?.find((candidate) => sameBytes(base.subarray(candidate.offset, candidate.offset + candidate.length), bytes))
    if (match) {
      ops.push([0, match.offset, match.length])
      copiedBytes += match.length
    } else {
      ops.push([1, literalBytes, chunk.length])
      literals.push(bytes)
      literalBytes += chunk.length
    }
  }
  if (copiedBytes === 0) return undefined

  const stream = new Uint8Array(literalBytes)
  let cursor = 0
  for (const literal of literals) {
    stream.set(literal, cursor)
    cursor += literal.length
  }
  return { ops, literals: stream, copiedBytes }
}

/**
 * Applies a chunk patch to `basePath` and writes the reconstructed file to
 * `targetPath`, returning its size and SHA-256. Bounds are checked before any
 * read so a corrupt recipe cannot silently produce the wrong bytes.
 */
export async function writeChunkPatch(options: { basePath: string; targetPath: string; ops: readonly PatchOp[]; literals: Uint8Array }): Promise<{ size: number; sha256: string }> {
  const base = await open(options.basePath, 'r')
  try {
    const baseSize = (await base.stat()).size
    const target = await open(options.targetPath, 'w')
    try {
      const digest = createHash('sha256')
      let size = 0
      const buffer = Buffer.allocUnsafe(COPY_CHUNK)
      for (const op of options.ops) {
        if (!Array.isArray(op) || op.length !== 3) throw new Error('补丁包含无效的块定义。')
        const [, offset, length] = op
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error('补丁包含无效的块范围。')
        if (op[0] === 0) {
          if (offset + length > baseSize) throw new Error('补丁引用了基准文件之外的数据。')
          let copied = 0
          while (copied < length) {
            const wanted = Math.min(buffer.length, length - copied)
            const { bytesRead } = await base.read(buffer, 0, wanted, offset + copied)
            if (bytesRead !== wanted) throw new Error('基准文件比补丁预期的更短。')
            await target.write(buffer, 0, wanted)
            digest.update(buffer.subarray(0, wanted))
            copied += wanted
            size += wanted
          }
        } else if (op[0] === 1) {
          if (offset + length > options.literals.length) throw new Error('补丁引用了字面量流之外的数据。')
          const slice = options.literals.subarray(offset, offset + length)
          await target.write(slice)
          digest.update(slice)
          size += slice.length
        } else {
          throw new Error('补丁包含未知的块类型。')
        }
      }
      return { size, sha256: digest.digest('hex') }
    } finally {
      await target.close()
    }
  } finally {
    await base.close()
  }
}
