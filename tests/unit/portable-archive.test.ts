import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildPortableRelease, stagePortableUpdate, validateManifest } from '../../src/main/portableArchive'

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
  })

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
  })

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
      for (let attempt = 0; attempt < 50; attempt++) {
        try { await readFile(join(plan.stageDir, 'helper.ready')); ready = true; break } catch { await delay(100) }
      }
      expect(ready).toBe(true)
      await writeFile(join(app, 'new.txt'), 'user-created')
    } finally { parent.stdin.end() }
    expect(await helper).toBe(false)
    expect(await readFile(join(app, 'new.txt'), 'utf8')).toBe('user-created')
  }, 15_000)

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
    for (let attempt = 0; attempt < 50; attempt++) {
      try { state = JSON.parse(await readFile(join(plan.stageDir, 'result.json'), 'utf8')).state } catch { /* waiting for helper */ }
      if (state === 'applied') break
      await delay(100)
    }
    expect(state).toBe('applied')
  }, 15_000)
})
