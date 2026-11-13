import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { createChunkPatch, writeChunkPatch, type PatchOp } from './patchArchive.ts'

// Electron's patched fs treats app.asar as a directory; update hashes need the actual file bytes.
const fileSystem: typeof nodeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs
const { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } = fileSystem.promises

const manifestName = 'update-manifest.json'
const maxExpandedBytes = 2 * 1024 ** 3
const patchBundleName = 'patch.json'
const literalBundleName = 'literals.bin'
const patchPrefix = 'files/'
const patchMinFileBytes = 512 * 1024
type FileRecord = { size: number; sha256: string }
export interface PortableManifest {
  schema: 1
  version: string
  platform: 'win32-x64'
  entry: string
  files: Record<string, FileRecord>
}
export interface UpdateAsset extends FileRecord { name: string }
export interface DeltaAsset extends UpdateAsset { fromVersion: string; fromManifestSha256: string }
export interface PatchAsset extends DeltaAsset {}
export interface PortableRelease {
  schema: 1
  version: string
  manifest: PortableManifest
  full: UpdateAsset
  deltas: DeltaAsset[]
  patches?: PatchAsset[]
}
export type UpdateMode = 'full' | 'delta' | 'patch'
export interface PatchBase { release: PortableRelease; directory: string }
export interface StagedUpdate {
  mode: UpdateMode
  targetDir: string
  stageDir: string
  manifest: PortableManifest
  previous: PortableManifest
  changed: string[]
  removed: string[]
}
interface PatchFileEntry {
  name: string
  size: number
  sha256: string
  full?: true
  ops?: PatchOp[]
}
interface PatchIndex {
  schema: 1
  fromVersion: string
  toVersion: string
  fromManifestSha256: string
  files: PatchFileEntry[]
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validPath(name: string): void {
  if (!name || name.length > 220 || name.includes('\\') || name.split('/').some((part) =>
    !part || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part.toLowerCase()) || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe update path: ${name}`)
}

function validRecord(value: FileRecord): void {
  if (!value || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maxExpandedBytes ||
    !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid update checksum or size')
}

export function validateManifest(value: PortableManifest): PortableManifest {
  if (!value || value.schema !== 1 || value.platform !== 'win32-x64' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Invalid portable manifest')
  const names = new Set<string>()
  let total = 0
  for (const [name, record] of Object.entries(value.files)) {
    validPath(name)
    const folded = name.toLowerCase()
    if (folded === manifestName || names.has(folded)) throw new Error('Duplicate or reserved update path')
    names.add(folded)
    validRecord(record)
    total += record.size
  }
  for (const name of names) {
    const parts = name.split('/')
    parts.pop()
    while (parts.length) {
      if (names.has(parts.join('/'))) throw new Error('Update file/directory collision')
      parts.pop()
    }
  }
  validPath(value.entry)
  if (!value.files[value.entry] || !value.entry.endsWith('.exe') || total > maxExpandedBytes) throw new Error('Invalid portable entry or size')
  return value
}

export function validateRelease(value: PortableRelease): PortableRelease {
  if (!value || value.schema !== 1 || !Array.isArray(value.deltas) || (value.patches !== undefined && !Array.isArray(value.patches))) throw new Error('Invalid update release')
  validateManifest(value.manifest)
  if (value.version !== value.manifest.version) throw new Error('Update version mismatch')
  for (const asset of [value.full, ...value.deltas, ...(value.patches ?? [])]) {
    validRecord(asset)
    validPath(asset.name)
    if (asset.name.includes('/') || !asset.name.endsWith('.zip')) throw new Error('Invalid ZIP asset name')
  }
  for (const delta of [...value.deltas, ...(value.patches ?? [])]) {
    if (!/^\d+\.\d+\.\d+$/.test(delta.fromVersion) || !/^[a-f0-9]{64}$/.test(delta.fromManifestSha256)) throw new Error('Invalid delta base')
  }
  for (const patch of value.patches ?? []) {
    if (!patch.name.endsWith('.patch.zip')) throw new Error('Invalid patch asset name')
  }
  return value
}

function manifestHash(manifest: PortableManifest): string {
  return sha256(JSON.stringify({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b, 'en'))) }))
}

async function safePath(directory: string, name: string): Promise<string> {
  validPath(name)
  const root = resolve(directory)
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Linked update path is not allowed: ${ancestor}`)
    if (dirname(ancestor) === ancestor) break
  }
  let path = root
  for (const part of ['', ...name.split('/')]) {
    if (part) path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Linked update path is not allowed: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const bytes = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    bytes.set(part, cursor)
    cursor += part.length
  }
  return bytes
}

function parsePatchIndex(text: string): PatchIndex {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('更新补丁索引无效。') }
  const index = value as Partial<PatchIndex>
  if (!index || typeof index !== 'object' || index.schema !== 1 || typeof index.fromVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(index.fromVersion) ||
    typeof index.toVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(index.toVersion) || typeof index.fromManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(index.fromManifestSha256) ||
    !Array.isArray(index.files)) throw new Error('更新补丁索引无效。')
  const files: PatchFileEntry[] = []
  const seen = new Set<string>()
  for (const raw of index.files as unknown[]) {
    const entry = raw as Partial<PatchFileEntry> | null
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') throw new Error('更新补丁索引无效。')
    validPath(entry.name)
    if (seen.has(entry.name)) throw new Error('更新补丁包含重复文件。')
    seen.add(entry.name)
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('更新补丁索引无效。')
    if (entry.full === true) { files.push({ name: entry.name, size: entry.size!, sha256: entry.sha256, full: true }); continue }
    if (!Array.isArray(entry.ops) || entry.ops.length === 0) throw new Error('更新补丁缺少块定义。')
    for (const op of entry.ops as unknown[]) {
      if (!Array.isArray(op) || op.length !== 3 || (op[0] !== 0 && op[0] !== 1) || !Number.isSafeInteger(op[1]) || !Number.isSafeInteger(op[2]) || op[1] < 0 || op[2] < 0) throw new Error('更新补丁包含无效的块定义。')
    }
    files.push({ name: entry.name, size: entry.size!, sha256: entry.sha256, ops: entry.ops as PatchOp[] })
  }
  return { schema: 1, fromVersion: index.fromVersion, toVersion: index.toVersion, fromManifestSha256: index.fromManifestSha256, files }
}

export async function buildPortableRelease(directory: string, output: string, version: string, entry: string, previous?: PortableRelease, patchBases: PatchBase[] = []): Promise<PortableRelease> {
  const bytes: Record<string, Uint8Array> = Object.create(null)
  const walk = async (relative = ''): Promise<void> => {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name
      if (name === manifestName) continue
      validPath(name)
      if (item.isSymbolicLink()) throw new Error(`Cannot package linked file: ${name}`)
      if (item.isDirectory()) await walk(name)
      else if (item.isFile()) bytes[name] = await readFile(join(directory, name))
    }
  }
  await walk()
  const files = Object.fromEntries(Object.entries(bytes).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, data]) => [name, { size: data.length, sha256: sha256(data) }]))
  const manifest = validateManifest({ schema: 1, platform: 'win32-x64', version, entry, files })
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  await mkdir(output, { recursive: true })
  const archive = async (name: string, selected: string[]): Promise<UpdateAsset> => {
    const contents = Object.fromEntries(selected.map((path) => [path, bytes[path]!]))
    contents[manifestName] = manifestBytes
    const zipped = zipSync(contents, { level: 6 })
    await writeFile(join(output, name), zipped)
    return { name, size: zipped.length, sha256: sha256(zipped) }
  }
  const prefix = `Ashes-of-Pantheon-QA-Tool-${version}-win-x64`
  const full = await archive(`${prefix}.zip`, Object.keys(files))
  const deltas: DeltaAsset[] = []
  if (previous) {
    validateRelease(previous)
    if (previous.manifest.entry !== entry) throw new Error('Portable executable name cannot change during incremental updates')
    const changed = Object.keys(files).filter((name) => previous.manifest.files[name]?.sha256 !== files[name]!.sha256)
    const delta = await archive(`${prefix}-from-${previous.version}.delta.zip`, changed)
    deltas.push({ ...delta, fromVersion: previous.version, fromManifestSha256: manifestHash(previous.manifest) })
  }

  const buildPatch = async (base: PatchBase): Promise<PatchAsset | undefined> => {
    validateRelease(base.release)
    if (base.release.version === version || base.release.manifest.entry !== entry) return undefined
    const baseFiles = base.release.manifest.files
    const changed = Object.keys(files).filter((name) => baseFiles[name]?.sha256 !== files[name]!.sha256)
    if (changed.length === 0) return undefined
    const contents: Record<string, Uint8Array> = {}
    const entries: PatchFileEntry[] = []
    const literalParts: Uint8Array[] = []
    let literalBytes = 0
    let blockFiles = 0
    for (const name of changed) {
      const data = bytes[name]!
      const record = files[name]!
      const baseRecord = baseFiles[name]
      let ops: PatchOp[] | undefined
      if (data.length >= patchMinFileBytes && baseRecord) {
        let baseData: Uint8Array | undefined
        try { baseData = await readFile(join(base.directory, name)) } catch { baseData = undefined }
        if (baseData && baseData.length === baseRecord.size && sha256(baseData) === baseRecord.sha256) {
          const chunkPatch = createChunkPatch(baseData, data)
          if (chunkPatch && chunkPatch.copiedBytes >= data.length * 0.5 && chunkPatch.literals.length <= data.length * 0.4) {
            const usage = chunkPatch.literals.length + chunkPatch.ops.length * 16
            if (usage < data.length * 0.8) {
              ops = chunkPatch.ops.map((op) => op[0] === 0 ? op : [1, op[1] + literalBytes, op[2]] as PatchOp)
              literalParts.push(chunkPatch.literals)
              literalBytes += chunkPatch.literals.length
              blockFiles++
            }
          }
        }
      }
      if (ops) entries.push({ name, size: record.size, sha256: record.sha256, ops })
      else {
        entries.push({ name, size: record.size, sha256: record.sha256, full: true })
        contents[`${patchPrefix}${name}`] = data
      }
    }
    if (blockFiles === 0) return undefined
    const index: PatchIndex = {
      schema: 1,
      fromVersion: base.release.version,
      toVersion: version,
      fromManifestSha256: manifestHash(base.release.manifest),
      files: entries
    }
    contents[patchBundleName] = Buffer.from(JSON.stringify(index))
    contents[literalBundleName] = concatBytes(literalParts)
    contents[manifestName] = manifestBytes
    const name = `${prefix}-from-${base.release.version}.patch.zip`
    const zipped = zipSync(contents, { level: 6 })
    await writeFile(join(output, name), zipped)
    return { name, size: zipped.length, sha256: sha256(zipped), fromVersion: base.release.version, fromManifestSha256: index.fromManifestSha256 }
  }

  const patches: PatchAsset[] = []
  for (const base of patchBases.slice(0, 3)) {
    if (patches.some((patch) => patch.fromVersion === base.release.version)) continue
    const patch = await buildPatch(base)
    if (patch) patches.push(patch)
  }
  const release: PortableRelease = { schema: 1, version, manifest, full, deltas, ...(patches.length ? { patches } : {}) }
  validateRelease(release)
  await writeFile(join(output, 'update.json'), JSON.stringify(release, null, 2))
  return release
}

export async function stagePortableUpdate(options: {
  directory: string
  stagingRoot: string
  currentVersion: string
  release: PortableRelease
  download: (asset: UpdateAsset, mode: UpdateMode) => Promise<Uint8Array>
}): Promise<StagedUpdate> {
  const release = validateRelease(options.release)
  const previous = validateManifest(JSON.parse(await readFile(await safePath(options.directory, manifestName), 'utf8')))
  if (previous.version !== options.currentVersion || previous.entry !== release.manifest.entry) throw new Error('本地 ZIP 版本清单不匹配，请重新解压完整 ZIP。')
  const previousHash = manifestHash(previous)
  const removed = Object.keys(previous.files).filter((name) => !Object.hasOwn(release.manifest.files, name))
  const changed = Object.keys(release.manifest.files).filter((name) => previous.files[name]?.sha256 !== release.manifest.files[name]!.sha256)
  for (const name of [...Object.keys(previous.files), ...Object.keys(release.manifest.files)]) {
    const path = await safePath(options.directory, name)
    if (!Object.hasOwn(previous.files, name)) {
      try { await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      throw new Error(`更新会覆盖用户文件，已停止：${name}`)
    }
  }
  let patch = (release.patches ?? []).find((item) => item.fromVersion === previous.version && item.fromManifestSha256 === previousHash)
  let delta = release.deltas.find((item) => item.fromVersion === previous.version && item.fromManifestSha256 === previousHash)
  if (patch || delta) {
    for (const [name, record] of Object.entries(previous.files)) {
      try {
        const current = await readFile(join(options.directory, name))
        if (current.length !== record.size || sha256(current) !== record.sha256) { patch = undefined; delta = undefined; break }
      } catch { patch = undefined; delta = undefined; break }
    }
  }
  await mkdir(options.stagingRoot, { recursive: true })
  const stageDir = await mkdtemp(join(options.stagingRoot, 'staged-'))
  const writeStaged = async (name: string, data: Uint8Array): Promise<void> => {
    await mkdir(dirname(join(stageDir, name)), { recursive: true })
    await writeFile(join(stageDir, name), data)
  }
  const checkArchive = (zipped: Uint8Array, asset: UpdateAsset): void => {
    if (zipped.length !== asset.size || sha256(zipped) !== asset.sha256) throw new Error('更新 ZIP 校验失败，原文件未修改。')
  }
  const extractArchive = async (asset: UpdateAsset, mode: 'full' | 'delta'): Promise<void> => {
    const zipped = await options.download(asset, mode)
    checkArchive(zipped, asset)
    const selected = mode === 'delta' ? changed : Object.keys(release.manifest.files)
    const expected = new Set([...selected, manifestName])
    let expanded = 0
    const contents = unzipSync(zipped, { filter: (file) => {
      validPath(file.name)
      expanded += file.originalSize
      if (!expected.has(file.name) || expanded > maxExpandedBytes) throw new Error('Unexpected file in update ZIP')
      return true
    } })
    if (Object.keys(contents).length !== expected.size) throw new Error('更新 ZIP 缺少文件。')
    const embedded = validateManifest(JSON.parse(Buffer.from(contents[manifestName]!).toString('utf8')))
    if (manifestHash(embedded) !== manifestHash(release.manifest)) throw new Error('ZIP manifest mismatch')
    for (const name of selected) {
      const data = contents[name]!
      const record = release.manifest.files[name]!
      if (data.length !== record.size || sha256(data) !== record.sha256) throw new Error(`更新文件校验失败：${name}`)
      await writeStaged(name, data)
    }
    await writeStaged(manifestName, contents[manifestName]!)
  }
  const extractPatch = async (asset: PatchAsset): Promise<void> => {
    const zipped = await options.download(asset, 'patch')
    checkArchive(zipped, asset)
    const selected = new Set(changed)
    const allowed = (name: string): boolean => name === patchBundleName || name === literalBundleName || name === manifestName ||
      (name.startsWith(patchPrefix) && selected.has(name.slice(patchPrefix.length)))
    let expanded = 0
    const contents = unzipSync(zipped, { filter: (file) => {
      validPath(file.name)
      expanded += file.originalSize
      if (!allowed(file.name) || expanded > maxExpandedBytes) throw new Error('Unexpected file in update patch')
      return true
    } })
    if (!contents[patchBundleName] || !contents[manifestName]) throw new Error('更新补丁缺少索引或清单。')
    const index = parsePatchIndex(Buffer.from(contents[patchBundleName]!).toString('utf8'))
    if (index.fromVersion !== previous.version || index.toVersion !== release.version || index.fromManifestSha256 !== previousHash) throw new Error('更新补丁基准不匹配。')
    const embedded = validateManifest(JSON.parse(Buffer.from(contents[manifestName]!).toString('utf8')))
    if (manifestHash(embedded) !== manifestHash(release.manifest)) throw new Error('补丁清单不匹配。')
    const entries = new Map(index.files.map((entry) => [entry.name, entry]))
    if (entries.size !== changed.length || !changed.every((name) => entries.has(name))) throw new Error('更新补丁文件集合不匹配。')
    const literals = contents[literalBundleName] ?? new Uint8Array()
    for (const name of changed) {
      const entry = entries.get(name)!
      const record = release.manifest.files[name]!
      if (entry.size !== record.size || entry.sha256 !== record.sha256) throw new Error(`更新补丁清单不匹配：${name}`)
      if (entry.full) {
        const data = contents[`${patchPrefix}${name}`]
        if (!data || data.length !== record.size || sha256(data) !== record.sha256) throw new Error(`更新文件校验失败：${name}`)
        await writeStaged(name, data)
        continue
      }
      const target = join(stageDir, name)
      await mkdir(dirname(target), { recursive: true })
      const applied = await writeChunkPatch({ basePath: join(options.directory, name), targetPath: target, ops: entry.ops!, literals })
      if (applied.size !== record.size || applied.sha256 !== record.sha256) throw new Error(`更新文件校验失败：${name}`)
    }
    await writeStaged(manifestName, contents[manifestName]!)
  }

  let mode: UpdateMode = 'full'
  let staged = false
  const candidates: Array<{ asset: UpdateAsset; mode: 'patch' | 'delta' }> = []
  if (patch) candidates.push({ asset: patch, mode: 'patch' })
  if (delta) candidates.push({ asset: delta, mode: 'delta' })
  for (const candidate of candidates) {
    try {
      if (candidate.mode === 'patch') await extractPatch(candidate.asset as PatchAsset)
      else await extractArchive(candidate.asset, 'delta')
      mode = candidate.mode
      staged = true
      break
    } catch { /* fall through to the next smaller option */ }
  }
  if (!staged) {
    await extractArchive(release.full, 'full')
    mode = 'full'
  }
  return { mode, targetDir: resolve(options.directory), stageDir, manifest: release.manifest, previous, changed: mode === 'full' ? Object.keys(release.manifest.files) : changed, removed }
}
