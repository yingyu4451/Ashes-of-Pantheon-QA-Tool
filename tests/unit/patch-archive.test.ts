import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createChunkPatch, writeChunkPatch } from '../../src/main/patchArchive'

// Deterministic pseudo-random bytes keep the fixtures independent of node:crypto.
function bytes(size: number, seed: number): Uint8Array {
  const buffer = new Uint8Array(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    buffer[index] = state >>> 24
  }
  return buffer
}

async function writePatch(base: Uint8Array, next: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), 'qa-chunk-patch-'))
  await writeFile(join(root, 'base.bin'), base)
  const patch = createChunkPatch(base, next)
  expect(patch).toBeDefined()
  const applied = await writeChunkPatch({ basePath: join(root, 'base.bin'), targetPath: join(root, 'next.bin'), ops: patch!.ops, literals: patch!.literals })
  return { patch: patch!, applied, root }
}

describe('chunk patch', () => {
  it('reuses most of the base file after an insertion shifts the tail', async () => {
    const base = bytes(1_500_000, 7)
    const inserted = bytes(2_048, 99)
    const next = new Uint8Array(base.length + inserted.length)
    next.set(base.subarray(0, 400_000), 0)
    next.set(inserted, 400_000)
    next.set(base.subarray(400_000), 400_000 + inserted.length)
    const { patch, applied, root } = await writePatch(base, next)
    expect(patch.copiedBytes).toBeGreaterThan(next.length * 0.9)
    expect(patch.ops.length).toBeGreaterThan(1)
    expect(patch.literals.length).toBeLessThan(next.length * 0.1)
    expect(applied).toEqual({ size: next.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(new Uint8Array(await readFile(join(root, 'next.bin')))).toEqual(next)
  })

  it('returns no patch when the base shares no content', () => {
    expect(createChunkPatch(bytes(600_000, 1), bytes(600_000, 2))).toBeUndefined()
  })

  it('copies an identical file and keeps the literal stream empty', async () => {
    const base = bytes(900_000, 3)
    const { patch, applied, root } = await writePatch(base, base)
    expect(patch.literals).toHaveLength(0)
    expect(applied.size).toBe(base.length)
    expect(new Uint8Array(await readFile(join(root, 'next.bin')))).toEqual(base)
  })

  it('rejects an out-of-range copy instead of writing a corrupt file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-chunk-patch-'))
    const base = bytes(64_000, 5)
    await writeFile(join(root, 'base.bin'), base)
    await expect(writeChunkPatch({ basePath: join(root, 'base.bin'), targetPath: join(root, 'next.bin'), ops: [[0, 63_000, 8_000]], literals: new Uint8Array() })).rejects.toThrow()
  })

  it('rejects a literal slice outside the literal stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-chunk-patch-'))
    await writeFile(join(root, 'base.bin'), bytes(32_000, 9))
    await expect(writeChunkPatch({ basePath: join(root, 'base.bin'), targetPath: join(root, 'next.bin'), ops: [[1, 8, 4]], literals: new Uint8Array(4) })).rejects.toThrow()
  })
})
