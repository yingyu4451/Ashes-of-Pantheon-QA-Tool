import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release contract', () => {
  it('targets the Ashes of Pantheon GitHub release feed', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      name: string
      dependencies: Record<string, string>
      scripts: Record<string, string>
      repository?: { type: string; url: string }
      build: {
        appId: string
        productName: string
        artifactName?: string
        publish?: Array<{ provider: string; owner: string; repo: string; releaseType?: string }>
      }
    }

    expect(packageJson.name).toBe('ashes-of-pantheon-qa-tool')
    expect(packageJson.build.appId).toBe('com.ashes-of-pantheon.qa-tool')
    expect(packageJson.build.productName).toBe('Ashes of Pantheon QA Tool')
    expect(packageJson.build.artifactName).toBe('Ashes-of-Pantheon-QA-Tool-Setup-${version}.${ext}')
    expect(packageJson.dependencies['electron-updater']).toBeDefined()
    expect(packageJson.scripts['build:win']).toContain('--publish never')
    expect(packageJson.repository?.url).toContain('yingyu4451/Ashes-of-Pantheon-QA-Tool')
    expect(packageJson.build.publish).toEqual([{
      provider: 'github',
      owner: 'yingyu4451',
      repo: 'Ashes-of-Pantheon-QA-Tool',
      releaseType: 'release'
    }])
  })

  it('publishes Windows update artifacts for v tags', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8')

    expect(workflow).toContain('tags:')
    expect(workflow).toContain("'v*'")
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('pnpm run build:win')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('release/latest.yml')
    expect(workflow).toContain('release/Ashes-of-Pantheon-QA-Tool-Setup-$packageVersion.exe')
  })
})
