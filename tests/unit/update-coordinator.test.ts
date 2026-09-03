import { describe, expect, it } from 'vitest'
import { createUpdateCoordinator, type UpdateDriver, type UpdateDriverEvent } from '../../src/main/updateCoordinator'

class FakeUpdateDriver implements UpdateDriver {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkCalls = 0
  downloadCalls = 0
  installCalls = 0
  private readonly listeners = new Map<UpdateDriverEvent, Array<(...args: unknown[]) => void>>()

  on(event: UpdateDriverEvent, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  async checkForUpdates(): Promise<void> {
    this.checkCalls++
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls++
  }

  quitAndInstall(): void {
    this.installCalls++
  }

  emit(event: UpdateDriverEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

describe('update coordinator', () => {
  it('disables GitHub checks in development mode', async () => {
    const driver = new FakeUpdateDriver()
    const coordinator = createUpdateCoordinator({ driver, isPackaged: false, currentVersion: '0.1.0' })

    expect(coordinator.getStatus()).toMatchObject({ phase: 'disabled', currentVersion: '0.1.0' })
    expect((await coordinator.check()).ok).toBe(false)
    expect(driver.checkCalls).toBe(0)
  })

  it('moves from available through download to user-approved installation', async () => {
    const driver = new FakeUpdateDriver()
    const coordinator = createUpdateCoordinator({ driver, isPackaged: true, currentVersion: '0.1.0' })

    expect(driver.autoDownload).toBe(false)
    expect(driver.autoInstallOnAppQuit).toBe(false)
    expect(driver.allowPrerelease).toBe(false)

    expect((await coordinator.check()).ok).toBe(true)
    expect(driver.checkCalls).toBe(1)
    expect(coordinator.getStatus().phase).toBe('checking')

    driver.emit('update-available', { version: '0.2.0' })
    expect(coordinator.getStatus()).toMatchObject({ phase: 'available', latestVersion: '0.2.0' })

    expect((await coordinator.download()).ok).toBe(true)
    expect(driver.downloadCalls).toBe(1)
    driver.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 128 })
    expect(coordinator.getStatus()).toMatchObject({ phase: 'downloading', percent: 42.5 })

    driver.emit('update-downloaded', { version: '0.2.0' })
    expect(coordinator.getStatus().phase).toBe('downloaded')
    expect(coordinator.install().ok).toBe(true)
    expect(driver.installCalls).toBe(1)
  })

  it('guards invalid actions and preserves update errors', async () => {
    const driver = new FakeUpdateDriver()
    const coordinator = createUpdateCoordinator({ driver, isPackaged: true, currentVersion: '0.1.0' })

    expect((await coordinator.download()).ok).toBe(false)
    expect(coordinator.install().ok).toBe(false)
    driver.emit('error', new Error('GitHub 暂时不可用'))
    expect(coordinator.getStatus()).toMatchObject({ phase: 'error', message: 'GitHub 暂时不可用' })
  })
})
