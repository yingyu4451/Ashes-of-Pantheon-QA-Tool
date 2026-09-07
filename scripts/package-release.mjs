import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { buildPortableRelease } from '../src/main/portableArchive.ts'

const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const previousPath = 'release-previous/update.json'
const previous = existsSync(previousPath) ? JSON.parse(await readFile(previousPath, 'utf8')) : undefined
const release = await buildPortableRelease('release/win-unpacked', 'release/artifacts', metadata.version, `${metadata.build.productName}.exe`, previous)
console.log(`Full ZIP: ${release.full.name} (${release.full.size} bytes)`)
for (const delta of release.deltas) console.log(`Delta ZIP: ${delta.name} (${delta.size} bytes, ${(delta.size / release.full.size * 100).toFixed(1)}% of full)`)
if (!release.deltas.length) console.log('First ZIP release: no previous ZIP baseline; subsequent releases generate deltas automatically.')
