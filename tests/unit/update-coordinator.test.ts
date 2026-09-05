import { describe, expect, it } from 'vitest'
import { createUpdateCoordinator, type PortableRelease, type UpdateDriver } from '../../src/main/updateCoordinator'

class FakeUpdateDriver implements UpdateDriver {
  release: PortableRelease = {
    version: '0.2.0',
    downloadUrl: 'https://github.com/example/releases/download/v0.2.0/App-Portable-0.2.0.exe'
  }
  checkCalls = 0
  openedUrls: string[] = []

  async getLatestRelease(): Promise<PortableRelease> {
    this.checkCalls++
    return this.release
  }

  async openExternal(url: string): Promise<void> {
    this.openedUrls.push(url)
  }
}

describe('portable update coordinator', () => {
  it('disables GitHub checks in development mode', async () => {
    const driver = new FakeUpdateDriver()
    const coordinator = createUpdateCoordinator({ driver, isPackaged: false, currentVersion: '0.1.3' })

    expect(coordinator.getStatus()).toMatchObject({ phase: 'disabled', currentVersion: '0.1.3' })
    expect((await coordinator.check()).ok).toBe(false)
    expect(driver.checkCalls).toBe(0)
  })

  it('finds a newer portable release and opens its download without installation', async () => {
    const driver = new FakeUpdateDriver()
    const coordinator = createUpdateCoordinator({ driver, isPackaged: true, currentVersion: '0.1.3' })

    expect((await coordinator.check()).ok).toBe(true)
    expect(driver.checkCalls).toBe(1)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'available', latestVersion: '0.2.0' })
    expect((await coordinator.openDownload()).ok).toBe(true)
    expect(driver.openedUrls).toEqual([driver.release.downloadUrl])
  })

  it('reports the current portable release and guards missing downloads', async () => {
    const driver = new FakeUpdateDriver()
    driver.release = { version: '0.1.3', downloadUrl: 'https://example.invalid/current.exe' }
    const coordinator = createUpdateCoordinator({ driver, isPackaged: true, currentVersion: '0.1.3' })

    expect((await coordinator.openDownload()).ok).toBe(false)
    expect((await coordinator.check()).ok).toBe(true)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'not-available', latestVersion: '0.1.3' })
    expect(driver.openedUrls).toEqual([])
  })

  it('preserves GitHub check errors', async () => {
    const driver = new FakeUpdateDriver()
    driver.getLatestRelease = async () => { throw new Error('GitHub 暂时不可用') }
    const coordinator = createUpdateCoordinator({ driver, isPackaged: true, currentVersion: '0.1.3' })

    expect((await coordinator.check()).ok).toBe(false)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'error', message: 'GitHub 暂时不可用' })
  })
})
