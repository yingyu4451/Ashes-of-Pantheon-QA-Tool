import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'
import { unzipSync } from 'fflate'
import { buildPortableRelease, sha256, validateRelease } from '../src/main/portableArchive.ts'

// Run only against extracted copies and the separate smoke-next build, never a user's running tool.
const release = validateRelease(JSON.parse(await readFile('release/artifacts/update.json', 'utf8')))
const versionParts = release.version.split('.').map(Number)
versionParts[2]++
const nextVersion = versionParts.join('.')
const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'qa-packaged-update-'))
assert.ok(root.startsWith(join(tmpdir(), 'qa-packaged-update-')))
console.log(`Extracting ZIP into isolated test directory: ${root}`)
const directory = join(root, 'app')
const userData = join(root, 'data')
await mkdir(userData, { recursive: true })
const zipped = await readFile(join('release/artifacts', release.full.name))
assert.equal(sha256(zipped), release.full.sha256)
for (const [name, bytes] of Object.entries(unzipSync(zipped))) {
  assert.ok(name === 'update-manifest.json' || release.manifest.files[name])
  if (name !== 'update-manifest.json') assert.equal(sha256(bytes), release.manifest.files[name].sha256)
  await mkdir(dirname(join(directory, name)), { recursive: true })
  await writeFile(join(directory, name), bytes)
}
await writeFile(join(directory, 'user-note.txt'), 'preserve me')
await writeFile(join(userData, 'settings.json'), '{"test":"preserved"}')
const nextIndexPath = join(root, 'next-release', 'update.json')
const cached = existsSync(nextIndexPath) ? JSON.parse(await readFile(nextIndexPath, 'utf8')) : undefined
console.log('Preparing the next-version ZIP fixture')
const next = cached?.version === nextVersion && cached.deltas.some((asset) => asset.fromManifestSha256 === sha256(JSON.stringify(release.manifest))) ? cached : await buildPortableRelease('release/smoke-next/win-unpacked', join(root, 'next-release'), nextVersion, release.manifest.entry, release)
const server = createServer((request, response) => {
  const name = decodeURIComponent((request.url || '').slice(1))
  if (![next.full, ...next.deltas].some((asset) => asset.name === name)) { response.writeHead(404).end(); return }
  createReadStream(join(root, 'next-release', name)).pipe(response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
console.log('Launching extracted app and exercising native update IPC')
const executablePath = join(directory, release.manifest.entry)
const app = await electron.launch({ executablePath, cwd: directory, args: [`--user-data-dir=${join(userData, 'chromium')}`],
  env: { ...process.env, ASHES_OF_PANTHEON_QA_USER_DATA_DIR: userData } })
let closed = false
app.process().on('exit', () => { closed = true })
try {
  assert.deepEqual(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() })), { packaged: true, version: release.version })
  await app.evaluate(({ net }, { index, baseUrl }) => {
    const originalFetch = net.fetch.bind(net)
    net.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: `v${index.version}`, assets: [{ name: 'update.json' }, index.full, ...index.deltas] }))
      if (url.endsWith('/update.json')) return new Response(JSON.stringify(index))
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop())
      if (![index.full, ...index.deltas].some((asset) => asset.name === name)) throw new Error(`Unexpected test request: ${url}`)
      return originalFetch(`${baseUrl}/${encodeURIComponent(name)}`)
    }
  }, { index: next, baseUrl })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const checked = await page.evaluate(() => window.qaNative.checkForUpdates())
  assert.equal(checked.data.phase, 'available')
  const downloaded = await page.evaluate(() => window.qaNative.downloadUpdate())
  assert.equal(downloaded.ok, true, downloaded.message)
  assert.equal(downloaded.data.phase, 'downloaded')
  assert.equal(downloaded.data.mode, 'delta')
  console.log('Delta downloaded and verified; requesting restart')
  await page.getByRole('heading', { name: '应用更新' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve('test-results/zip-packaged-ready.png') })
  const restarted = await page.evaluate(() => window.qaNative.restartForUpdate())
  assert.equal(restarted.ok, true, restarted.message)
  for (let attempt = 0; attempt < 600 && !closed; attempt++) await delay(100)
  assert.equal(closed, true, 'Old app must exit only after helper is ready')
  const pending = JSON.parse(await readFile(join(userData, 'pending-zip-update.json'), 'utf8'))
  let result
  for (let attempt = 0; attempt < 600; attempt++) {
    try { result = JSON.parse(await readFile(join(pending.stageDir, 'result.json'), 'utf8')) } catch { /* helper has not written yet */ }
    if (result && result.state !== 'applying') break
    await delay(100)
  }
  assert.equal(result?.state, 'applied', JSON.stringify(result))
  assert.equal(JSON.parse(await readFile(join(directory, 'update-manifest.json'), 'utf8')).version, next.version)
  assert.equal(await readFile(join(directory, 'user-note.txt'), 'utf8'), 'preserve me')
  assert.equal(await readFile(join(userData, 'settings.json'), 'utf8'), '{"test":"preserved"}')
  const quotedExe = executablePath.replaceAll("'", "''")
  let relaunched = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.Path -eq '${quotedExe}' -and $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.MainModule.FileVersionInfo.ProductVersion; $_.CloseMainWindow() | Out-Null }`])
    if (stdout.includes(next.version)) { relaunched = true; break }
    await delay(500)
  }
  assert.equal(relaunched, true, 'Updated EXE must relaunch with the new product version')
  console.log(JSON.stringify({ fullBytes: next.full.size, deltaBytes: next.deltas[0].size, mode: downloaded.data.mode, previous: release.version, updated: next.version, relaunched, preservedUserData: true, root }, null, 2))
} finally {
  if (!closed) await app.close()
  server.close()
}
