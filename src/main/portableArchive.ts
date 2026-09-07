import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'

// Electron's patched fs treats app.asar as a directory; update hashes need the actual file bytes.
const fileSystem: typeof nodeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs
const { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } = fileSystem.promises

const manifestName = 'update-manifest.json'
const maxExpandedBytes = 2 * 1024 ** 3
type FileRecord = { size: number; sha256: string }
export interface PortableManifest {
  schema: 1
  version: string
  platform: 'win32-x64'
  entry: string
  files: Record<string, FileRecord>
}
export interface UpdateAsset extends FileRecord { name: string }
export interface PortableRelease {
  schema: 1
  version: string
  manifest: PortableManifest
  full: UpdateAsset
  deltas: Array<UpdateAsset & { fromVersion: string; fromManifestSha256: string }>
}
export interface StagedUpdate {
  mode: 'full' | 'delta'
  targetDir: string
  stageDir: string
  manifest: PortableManifest
  previous: PortableManifest
  changed: string[]
  removed: string[]
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
  if (!value || value.schema !== 1 || !Array.isArray(value.deltas)) throw new Error('Invalid update release')
  validateManifest(value.manifest)
  if (value.version !== value.manifest.version) throw new Error('Update version mismatch')
  for (const asset of [value.full, ...value.deltas]) {
    validRecord(asset)
    validPath(asset.name)
    if (asset.name.includes('/') || !asset.name.endsWith('.zip')) throw new Error('Invalid ZIP asset name')
  }
  for (const delta of value.deltas) {
    if (!/^\d+\.\d+\.\d+$/.test(delta.fromVersion) || !/^[a-f0-9]{64}$/.test(delta.fromManifestSha256)) throw new Error('Invalid delta base')
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

export async function buildPortableRelease(directory: string, output: string, version: string, entry: string, previous?: PortableRelease): Promise<PortableRelease> {
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
  const deltas: PortableRelease['deltas'] = []
  if (previous) {
    validateRelease(previous)
    if (previous.manifest.entry !== entry) throw new Error('Portable executable name cannot change during incremental updates')
    const changed = Object.keys(files).filter((name) => previous.manifest.files[name]?.sha256 !== files[name]!.sha256)
    const delta = await archive(`${prefix}-from-${previous.version}.delta.zip`, changed)
    deltas.push({ ...delta, fromVersion: previous.version, fromManifestSha256: manifestHash(previous.manifest) })
  }
  const release: PortableRelease = { schema: 1, version, manifest, full, deltas }
  await writeFile(join(output, 'update.json'), JSON.stringify(release, null, 2))
  return release
}

export async function stagePortableUpdate(options: {
  directory: string
  stagingRoot: string
  currentVersion: string
  release: PortableRelease
  download: (asset: UpdateAsset, mode: 'full' | 'delta') => Promise<Uint8Array>
}): Promise<StagedUpdate> {
  const release = validateRelease(options.release)
  const previous = validateManifest(JSON.parse(await readFile(await safePath(options.directory, manifestName), 'utf8')))
  if (previous.version !== options.currentVersion || previous.entry !== release.manifest.entry) throw new Error('本地 ZIP 版本清单不匹配，请重新解压完整 ZIP。')
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
  let delta = release.deltas.find((item) => item.fromVersion === previous.version && item.fromManifestSha256 === manifestHash(previous))
  if (delta) {
    for (const [name, record] of Object.entries(previous.files)) {
      try {
        const current = await readFile(join(options.directory, name))
        if (current.length !== record.size || sha256(current) !== record.sha256) { delta = undefined; break }
      } catch { delta = undefined; break }
    }
  }
  await mkdir(options.stagingRoot, { recursive: true })
  const stageDir = await mkdtemp(join(options.stagingRoot, 'staged-'))
  const extract = async (asset: UpdateAsset, mode: 'full' | 'delta'): Promise<void> => {
    const zipped = await options.download(asset, mode)
    if (zipped.length !== asset.size || sha256(zipped) !== asset.sha256) throw new Error('更新 ZIP 校验失败，原文件未修改。')
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
    }
    for (const [name, data] of Object.entries(contents)) {
      await mkdir(dirname(join(stageDir, name)), { recursive: true })
      await writeFile(join(stageDir, name), data)
    }
  }
  let mode: 'full' | 'delta' = delta ? 'delta' : 'full'
  if (delta) {
    try { await extract(delta, 'delta') } catch { mode = 'full'; await extract(release.full, 'full') }
  } else await extract(release.full, 'full')
  return { mode, targetDir: resolve(options.directory), stageDir, manifest: release.manifest, previous, changed: mode === 'delta' ? changed : Object.keys(release.manifest.files), removed }
}
