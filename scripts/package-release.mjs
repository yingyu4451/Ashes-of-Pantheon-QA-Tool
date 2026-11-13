import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildPortableRelease, validateRelease } from '../src/main/portableArchive.ts'

const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const baselineRoot = 'release-previous'

function compareVersions(left, right) {
  const parts = (version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const leftParts = parts(left)
  const rightParts = parts(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

// Each directory under release-previous holds one published release: its
// update.json plus the extracted win-x64 ZIP, so patches compare real shipped bytes.
const baselines = []
if (existsSync(baselineRoot)) {
  for (const entry of await readdir(baselineRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(baselineRoot, entry.name, 'update.json')
    const unpacked = join(baselineRoot, entry.name, 'win-unpacked')
    if (!existsSync(manifestPath) || !existsSync(unpacked)) continue
    try {
      const release = validateRelease(JSON.parse(await readFile(manifestPath, 'utf8')))
      if (`v${release.version}` !== entry.name) throw new Error(`baseline directory ${entry.name} declares ${release.version}`)
      baselines.push({ release, directory: unpacked })
    } catch (error) {
      console.warn(`Skipping unusable update baseline ${entry.name}: ${error.message}`)
    }
  }
}
baselines.sort((left, right) => compareVersions(right.release.version, left.release.version))
const patchBases = baselines.slice(0, 3)
// Old updaters only understand file-level deltas. Publish one last legacy delta
// while the newest baseline predates patches; later releases rely on patches only.
const deltaBase = baselines[0] && !baselines[0].release.patches?.length ? baselines[0].release : undefined

const release = await buildPortableRelease('release/win-unpacked', 'release/artifacts', metadata.version, `${metadata.build.productName}.exe`, deltaBase, patchBases)
console.log(`Full ZIP: ${release.full.name} (${release.full.size} bytes)`)
for (const delta of release.deltas) console.log(`Legacy delta ZIP: ${delta.name} (${delta.size} bytes, ${(delta.size / release.full.size * 100).toFixed(1)}% of full)`)
for (const patch of release.patches ?? []) console.log(`Block patch: ${patch.name} (${patch.size} bytes, ${(patch.size / release.full.size * 100).toFixed(2)}% of full)`)
if (!release.deltas.length && !release.patches?.length) console.log('First ZIP release: no previous ZIP baseline; subsequent releases generate patches automatically.')
