import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildPortableRelease, stagePortableUpdate, validateManifest, validateRelease } from '../../src/main/portableArchive'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qa-zip-test-'))
  const app = join(root, 'app')
  await mkdir(app)
  await writeFile(join(app, 'QA.exe'), 'runtime-unchanged')
  await writeFile(join(app, 'app.txt'), 'old')
  return { root, app }
}

describe('ZIP portable release', () => {
  it('stages only changed files from a matching base while preserving user files', async () => {
    const { root, app } = await fixture()
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), 'runtime-unchanged')
    await writeFile(join(next, 'app.txt'), 'new')
    await writeFile(join(next, 'new.txt'), 'added')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    await writeFile(join(app, 'my-notes.txt'), 'keep')
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'staging'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return readFile(join(root, 'v2', asset.name)) }
    })
    expect(staged.mode).toBe('delta')
    expect(fetched).toEqual([second.deltas[0]!.name])
    expect(staged.changed).toEqual(['app.txt', 'new.txt'])
    expect(await readFile(join(staged.stageDir, 'app.txt'), 'utf8')).toBe('new')
    expect(await readFile(join(app, 'my-notes.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(app, 'app.txt'), 'utf8')).toBe('old')
  })

  it('stages a block patch for a large file in a nested directory', async () => {
    const { root, app } = await fixture()
    const asar = randomBytes(640_000)
    await mkdir(join(app, 'resources'))
    await writeFile(join(app, 'resources', 'app.asar'), asar)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(join(next, 'resources'), { recursive: true })
    const shifted = Buffer.concat([asar.subarray(0, 90_000), randomBytes(4_000), asar.subarray(90_000)])
    await writeFile(join(next, 'QA.exe'), 'runtime-unchanged')
    await writeFile(join(next, 'app.txt'), 'old')
    await writeFile(join(next, 'resources', 'app.asar'), shifted)
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first, [{ release: first, directory: app }])
    expect(second.patches).toHaveLength(1)
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return readFile(join(root, 'v2', asset.name)) }
    })
    expect(staged.mode).toBe('patch')
    expect(fetched).toEqual([second.patches![0]!.name])
    expect(staged.changed).toEqual(['resources/app.asar'])
    expect(new Uint8Array(await readFile(join(staged.stageDir, 'resources', 'app.asar')))).toEqual(new Uint8Array(shifted))
  }, 45_000)

  it('stages a block patch against the previous release when large files shift', async () => {
    const { root, app } = await fixture()
    const runtime = randomBytes(700_000)
    await writeFile(join(app, 'QA.exe'), runtime)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    const shifted = Buffer.concat([runtime.subarray(0, 120_000), randomBytes(3_000), runtime.subarray(120_000)])
    await writeFile(join(next, 'QA.exe'), shifted)
    await writeFile(join(next, 'app.txt'), 'new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first, [{ release: first, directory: app }])
    expect(second.patches).toHaveLength(1)
    const patch = second.patches![0]!
    expect(patch.name).toBe('Ashes-of-Pantheon-QA-Tool-1.0.1-win-x64-from-1.0.0.patch.zip')
    expect(patch.size).toBeLessThan(second.full.size / 4)
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return readFile(join(root, 'v2', asset.name)) }
    })
    expect(staged.mode).toBe('patch')
    expect(fetched).toEqual([patch.name])
    expect(staged.changed).toEqual(['app.txt', 'QA.exe'])
    expect(new Uint8Array(await readFile(join(staged.stageDir, 'QA.exe')))).toEqual(new Uint8Array(shifted))
    expect(await readFile(join(staged.stageDir, 'app.txt'), 'utf8')).toBe('new')
  }, 45_000)

  it('falls back to the file delta when the patch bundle is corrupt', async () => {
    const { root, app } = await fixture()
    const runtime = randomBytes(700_000)
    await writeFile(join(app, 'QA.exe'), runtime)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), Buffer.concat([runtime.subarray(0, 100_000), randomBytes(2_000), runtime.subarray(100_000)]))
    await writeFile(join(next, 'app.txt'), 'new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first, [{ release: first, directory: app }])
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return asset.name.endsWith('.patch.zip') ? Buffer.from('corrupt') : readFile(join(root, 'v2', asset.name)) }
    })
    expect(staged.mode).toBe('delta')
    expect(fetched).toEqual([second.patches![0]!.name, second.deltas[0]!.name])
    expect(await readFile(join(staged.stageDir, 'app.txt'), 'utf8')).toBe('new')
  }, 45_000)

  it('falls back to the full ZIP when patch and delta are both corrupt', async () => {
    const { root, app } = await fixture()
    const runtime = randomBytes(700_000)
    await writeFile(join(app, 'QA.exe'), runtime)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), Buffer.concat([runtime.subarray(0, 60_000), randomBytes(1_500), runtime.subarray(60_000)]))
    await writeFile(join(next, 'app.txt'), 'new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first, [{ release: first, directory: app }])
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return asset.name.includes('from-') ? Buffer.from('corrupt') : readFile(join(root, 'v2', asset.name)) }
    })
    expect(staged.mode).toBe('full')
    expect(fetched.at(-1)).toBe(second.full.name)
    expect(fetched).toHaveLength(3)
    expect(await readFile(join(staged.stageDir, 'app.txt'), 'utf8')).toBe('new')
  }, 45_000)

  it('serves the patch that matches the installed base when several bases are published', async () => {
    const { root, app } = await fixture()
    const runtime = randomBytes(700_000)
    await writeFile(join(app, 'QA.exe'), runtime)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const secondDir = join(root, 'second')
    await mkdir(secondDir)
    const shifted = Buffer.concat([runtime.subarray(0, 150_000), randomBytes(2_500), runtime.subarray(150_000)])
    await writeFile(join(secondDir, 'QA.exe'), shifted)
    await writeFile(join(secondDir, 'app.txt'), 'new')
    const second = await buildPortableRelease(secondDir, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    const thirdDir = join(root, 'third')
    await mkdir(thirdDir)
    await writeFile(join(thirdDir, 'QA.exe'), Buffer.concat([shifted.subarray(0, 300_000), randomBytes(2_000), shifted.subarray(300_000)]))
    await writeFile(join(thirdDir, 'app.txt'), 'newer')
    const third = await buildPortableRelease(thirdDir, join(root, 'v3'), '1.0.2', 'QA.exe', second, [
      { release: second, directory: secondDir },
      { release: first, directory: app }
    ])
    expect(third.patches).toHaveLength(2)
    const fetched: string[] = []
    const staged = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: third,
      download: async (asset) => { fetched.push(asset.name); return readFile(join(root, 'v3', asset.name)) }
    })
    expect(staged.mode).toBe('patch')
    expect(fetched[0]).toContain('-from-1.0.0.patch.zip')
    expect(await readFile(join(staged.stageDir, 'app.txt'), 'utf8')).toBe('newer')
  }, 60_000)

  it('applies a staged patch with the Windows helper', async () => {
    const { root, app } = await fixture()
    const runtime = randomBytes(700_000)
    await writeFile(join(app, 'QA.exe'), runtime)
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    const shifted = Buffer.concat([runtime.subarray(0, 200_000), randomBytes(2_000), runtime.subarray(200_000)])
    await writeFile(join(next, 'QA.exe'), shifted)
    await writeFile(join(next, 'app.txt'), 'new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first, [{ release: first, directory: app }])
    const plan = await stagePortableUpdate({
      directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: (asset) => readFile(join(root, 'v2', asset.name))
    })
    expect(plan.mode).toBe('patch')
    const planPath = join(plan.stageDir, 'plan.json')
    await writeFile(planPath, JSON.stringify({ ...plan, parentPid: 0 }))
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'resources/updater/apply-update.ps1', '-PlanPath', planPath, '-NoLaunch'])
    expect(new Uint8Array(await readFile(join(app, 'QA.exe')))).toEqual(new Uint8Array(shifted))
    expect(await readFile(join(app, 'app.txt'), 'utf8')).toBe('new')
    expect(JSON.parse(await readFile(join(app, 'update-manifest.json'), 'utf8')).version).toBe('1.0.1')
  }, 45_000)

  it('rejects a patch asset that is not a patch bundle', () => {
    const manifest = { schema: 1 as const, version: '1.0.1', platform: 'win32-x64' as const, entry: 'QA.exe', files: { 'QA.exe': { size: 1, sha256: 'a'.repeat(64) } } }
    const release = { schema: 1 as const, version: '1.0.1', manifest, full: { name: 'full.zip', size: 1, sha256: 'a'.repeat(64) }, deltas: [] }
    expect(() => validateRelease({ ...release, patches: [{ name: 'full.zip', size: 1, sha256: 'a'.repeat(64), fromVersion: '1.0.0', fromManifestSha256: 'a'.repeat(64) }] })).toThrow()
  })

  it('applies a full ZIP with the Windows helper and preserves unowned files', async () => {
    const { root, app } = await fixture()
    await writeFile(join(app, 'obsolete.txt'), 'remove')
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), 'new-runtime')
    await writeFile(join(next, 'app.txt'), 'new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe')
    await writeFile(join(app, 'notes.txt'), 'preserved')
    const plan = await stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: (asset) => readFile(join(root, 'v2', asset.name)) })
    const planPath = join(plan.stageDir, 'plan.json')
    await writeFile(planPath, JSON.stringify({ ...plan, parentPid: 0 }))
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'resources/updater/apply-update.ps1', '-PlanPath', planPath, '-NoLaunch'])
    expect(await readFile(join(app, 'QA.exe'), 'utf8')).toBe('new-runtime')
    expect(await readFile(join(app, 'notes.txt'), 'utf8')).toBe('preserved')
    await expect(readFile(join(app, 'obsolete.txt'))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(app, 'update-manifest.json'), 'utf8')).version).toBe('1.0.1')
    expect(JSON.parse(await readFile(join(plan.stageDir, 'result.json'), 'utf8')).state).toBe('applied')
  }, 45_000)

  it('restores earlier replacements when a later destination is locked', async () => {
    const { root, app } = await fixture()
    await writeFile(join(app, 'z-locked.txt'), 'locked-old')
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), 'new-runtime')
    await writeFile(join(next, 'app.txt'), 'new')
    await writeFile(join(next, 'z-locked.txt'), 'locked-new')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    const plan = await stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: (asset) => readFile(join(root, 'v2', asset.name)) })
    const planPath = join(plan.stageDir, 'plan.json')
    await writeFile(planPath, JSON.stringify({ ...plan, parentPid: 0 }))
    await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'tests/fixtures/run-update-with-lock.ps1', '-PlanPath', planPath, '-LockedFile', join(app, 'z-locked.txt')])).rejects.toThrow()
    expect(await readFile(join(app, 'app.txt'), 'utf8')).toBe('old')
    expect(await readFile(join(app, 'QA.exe'), 'utf8')).toBe('runtime-unchanged')
    expect(await readFile(join(app, 'z-locked.txt'), 'utf8')).toBe('locked-old')
    expect(JSON.parse(await readFile(join(app, 'update-manifest.json'), 'utf8')).version).toBe('1.0.0')
    expect(JSON.parse(await readFile(join(plan.stageDir, 'result.json'), 'utf8')).state).toBe('rolled-back')
    expect((await readFile(join(plan.stageDir, 'journal.json'), 'utf8')).includes('z-locked.txt')).toBe(true)
  }, 45_000)

  it('preserves a user file created while the helper waits for app exit', async () => {
    const { root, app } = await fixture()
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), 'runtime-unchanged')
    await writeFile(join(next, 'new.txt'), 'release-owned')
    const second = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    const plan = await stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: (asset) => readFile(join(root, 'v2', asset.name)) })
    const parent = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    const planPath = join(plan.stageDir, 'plan.json')
    await writeFile(planPath, JSON.stringify({ ...plan, parentPid: parent.pid }))
    const helper = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'resources/updater/apply-update.ps1', '-PlanPath', planPath, '-NoLaunch']).then(() => true, () => false)
    try {
      let ready = false
      for (let attempt = 0; attempt < 300; attempt++) {
        try { await readFile(join(plan.stageDir, 'helper.ready')); ready = true; break } catch { await delay(100) }
      }
      expect(ready).toBe(true)
      await writeFile(join(app, 'new.txt'), 'user-created')
    } finally { parent.stdin.end() }
    expect(await helper).toBe(false)
    expect(await readFile(join(app, 'new.txt'), 'utf8')).toBe('user-created')
  }, 45_000)

  it.each(['corrupt-delta', 'modified-base', 'skipped-version'])('falls back to the full ZIP: %s', async (scenario) => {
    const { root, app } = await fixture()
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const second = await buildPortableRelease(app, join(root, 'v2'), '1.0.2', 'QA.exe', first)
    if (scenario === 'modified-base') await writeFile(join(app, 'app.txt'), 'local-changes')
    if (scenario === 'skipped-version') second.deltas[0]!.fromVersion = '1.0.1'
    const fetched: string[] = []
    const plan = await stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release: second,
      download: async (asset) => { fetched.push(asset.name); return scenario === 'corrupt-delta' && asset.name.includes('.delta.') ? Buffer.from('corrupt') : readFile(join(root, 'v2', asset.name)) } })
    expect(plan.mode).toBe('full')
    expect(fetched.at(-1)).toBe(second.full.name)
    if (scenario !== 'corrupt-delta') expect(fetched).toHaveLength(1)
  })

  it('refuses a corrupted full ZIP without modifying the installed app', async () => {
    const { root, app } = await fixture()
    const release = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(release.manifest))
    await expect(stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release,
      download: async () => Buffer.from('bad') })).rejects.toThrow('校验失败')
    expect(await readFile(join(app, 'app.txt'), 'utf8')).toBe('old')
  })

  it.each(['../escape', '/absolute', 'C:/absolute', 'dir/file:stream', 'AUX.txt', 'dir/file.', 'dir\\file', '__proto__'])('rejects unsafe managed path %s', (name) => {
    const files = Object.fromEntries([['QA.exe', { size: 1, sha256: 'a'.repeat(64) }], [name, { size: 1, sha256: 'a'.repeat(64) }]])
    expect(() => validateManifest({ schema: 1, version: '1.0.0', platform: 'win32-x64', entry: 'QA.exe', files })).toThrow()
  })

  it('rejects a linked parent directory', async () => {
    const { root, app } = await fixture()
    const release = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(release.manifest))
    const link = join(root, 'linked')
    await symlink(root, link, 'junction')
    await expect(stagePortableUpdate({ directory: join(link, 'app'), stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release,
      download: (asset) => readFile(join(root, 'v1', asset.name)) })).rejects.toThrow('Linked update path')
  })

  it('does not treat inherited object property names as owned application files', async () => {
    const { root, app } = await fixture()
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    await writeFile(join(app, 'toString'), 'user file')
    const next = join(root, 'next')
    await mkdir(next)
    await writeFile(join(next, 'QA.exe'), 'runtime-unchanged')
    await writeFile(join(next, 'toString'), 'release file')
    const release = await buildPortableRelease(next, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    await expect(stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release,
      download: (asset) => readFile(join(root, 'v2', asset.name)) })).rejects.toThrow('用户文件')
  })

  it('runs the hidden Windows update launcher through to a completed update', async () => {
    const { root, app } = await fixture()
    const first = await buildPortableRelease(app, join(root, 'v1'), '1.0.0', 'QA.exe')
    await writeFile(join(app, 'update-manifest.json'), JSON.stringify(first.manifest))
    const release = await buildPortableRelease(app, join(root, 'v2'), '1.0.1', 'QA.exe', first)
    const plan = await stagePortableUpdate({ directory: app, stagingRoot: join(root, 'stage'), currentVersion: '1.0.0', release,
      download: (asset) => readFile(join(root, 'v2', asset.name)) })
    const planPath = join(plan.stageDir, 'plan.json')
    await writeFile(planPath, JSON.stringify({ ...plan, parentPid: 0 }))
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'resources/updater/start-update.ps1', '-PlanPath', planPath, '-NoLaunch'])
    expect(Number.parseInt(stdout.trim(), 10)).toBeGreaterThan(0)
    let state = ''
    for (let attempt = 0; attempt < 300; attempt++) {
      try { state = JSON.parse(await readFile(join(plan.stageDir, 'result.json'), 'utf8')).state } catch { /* waiting for helper */ }
      if (state === 'applied') break
      await delay(100)
    }
    expect(state).toBe('applied')
  }, 45_000)
})
