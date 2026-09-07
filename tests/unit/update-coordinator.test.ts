import { describe, expect, it } from 'vitest'
import { createUpdateCoordinator, type UpdateDriver } from '../../src/main/updateCoordinator'
import type { PortableRelease } from '../../src/main/portableArchive'

function fixture(isPackaged = true) {
  const release = { version: '0.2.0' } as PortableRelease
  let downloads = 0
  let restarts = 0
  const driver: UpdateDriver = {
    getLatestRelease: async () => release,
    download: async (_release, progress) => { downloads++; progress({ percent: 50, transferred: 5, total: 10, mode: 'delta' }) },
    restart: async () => { restarts++ }
  }
  const coordinator = createUpdateCoordinator({ driver, isPackaged, currentVersion: '0.1.4' })
  return { coordinator, driver, release, counts: () => ({ downloads, restarts }) }
}

describe('ZIP update coordinator', () => {
  it('downloads in-app and only restarts after the user requests a verified update', async () => {
    const { coordinator, counts } = fixture()
    const phases: string[] = []
    coordinator.subscribe((status) => phases.push(status.phase))
    expect((await coordinator.restart()).ok).toBe(false)
    expect((await coordinator.check()).ok).toBe(true)
    expect((await coordinator.download()).ok).toBe(true)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0', percent: 100 })
    expect(counts()).toEqual({ downloads: 1, restarts: 0 })
    expect((await coordinator.restart()).ok).toBe(true)
    expect(counts().restarts).toBe(1)
    expect(phases).toContain('downloading')
  })
  it('disables development updates and rejects duplicate downloads/checks', async () => {
    const dev = fixture(false)
    expect((await dev.coordinator.check()).ok).toBe(false)
    expect((await dev.coordinator.download()).ok).toBe(false)
    const { coordinator, driver, counts } = fixture()
    let finish!: () => void
    driver.download = () => new Promise<void>((resolve) => { finish = resolve })
    await coordinator.check()
    const downloading = coordinator.download()
    expect((await coordinator.download()).ok).toBe(false)
    expect((await coordinator.check()).ok).toBe(false)
    finish()
    await downloading
    expect(counts().restarts).toBe(0)
  })
  it('does not allow applying a failed download and supports retry', async () => {
    const { coordinator, driver } = fixture()
    driver.download = async () => { throw new Error('ZIP checksum failed') }
    await coordinator.check()
    expect((await coordinator.download()).ok).toBe(false)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'error', message: 'ZIP checksum failed' })
    expect((await coordinator.restart()).ok).toBe(false)
    expect((await coordinator.check()).ok).toBe(true)
  })
  it('reports check errors and skips releases at or below the current version', async () => {
    const { coordinator, release, driver } = fixture()
    release.version = '0.1.4'
    await coordinator.check()
    expect(coordinator.getStatus().phase).toBe('not-available')
    expect((await coordinator.download()).ok).toBe(false)
    driver.getLatestRelease = async () => { throw new Error('GitHub unavailable') }
    expect((await coordinator.check()).ok).toBe(false)
    expect(coordinator.getStatus().message).toBe('GitHub unavailable')
  })
})
