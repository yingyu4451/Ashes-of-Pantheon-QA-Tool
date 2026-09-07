import { expect, test } from '@playwright/test'
import type { UpdateStatus } from '@shared/contracts'

for (const width of [1440, 390]) {
  test(`ZIP update states and restart at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      let status = { phase: 'idle', currentVersion: '0.1.4', message: '尚未检查更新。' } as UpdateStatus
      let listener: (value: UpdateStatus) => void = () => undefined
      let finishDownload: () => void = () => undefined
      const emit = (value: Partial<UpdateStatus>) => { status = { ...status, ...value }; listener(status) }
      const result = () => ({ ok: true, message: status.message, data: status })
      Object.assign(window, { updateTest: {
        finish: () => finishDownload(),
        fail: () => emit({ phase: 'error', message: 'ZIP 校验失败，原文件未修改。请重新检查更新。' })
      } })
      window.qaNative = {
        readCatalogCache: async () => null,
        readPreferences: async () => ({ unityProjectPath: '', gameBuildPath: '' }),
        listBridgeInstances: async () => [],
        getUpdateStatus: async () => status,
        onUpdateStatus: (callback: typeof listener) => { listener = callback; return () => undefined },
        checkForUpdates: async () => {
          emit({ phase: 'available', latestVersion: '0.1.5', message: '发现 ZIP 便携版 0.1.5。' })
          return result()
        },
        downloadUpdate: async () => {
          emit({ phase: 'downloading', mode: 'delta', percent: 50, transferred: 1048576, total: 2097152, message: '正在下载增量 ZIP…' })
          await new Promise<void>((resolve) => { finishDownload = resolve })
          emit({ phase: 'downloaded', percent: 100, message: '更新已校验，等待重启。' })
          return result()
        },
        restartForUpdate: async () => { emit({ phase: 'applying', message: '正在准备重启并更新…' }); return result() }
      } as unknown as typeof window.qaNative
    })
    await page.goto('/')
    const check = page.getByRole('button', { name: '检查更新', exact: true })
    await check.scrollIntoViewIfNeeded()
    await expect(check).toBeEnabled()
    await check.hover()
    await check.focus()
    await expect(check).toBeFocused()
    await page.screenshot({ path: `test-results/zip-update-idle-${width}.png` })
    await check.click()
    await page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(page.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '50')
    await expect(page.getByRole('button', { name: '更新准备中…', exact: true })).toBeDisabled()
    await page.getByRole('progressbar').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/zip-update-progress-${width}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.evaluate(() => (window as unknown as { updateTest: { finish: () => void } }).updateTest.finish())
    await page.getByRole('button', { name: '重启并更新', exact: true }).click()
    await expect(page.getByRole('button', { name: '重启中…', exact: true })).toBeDisabled()
    await page.evaluate(() => (window as unknown as { updateTest: { fail: () => void } }).updateTest.fail())
    await expect(page.getByRole('region', { name: '应用更新' }).getByRole('status')).toContainText('ZIP 校验失败')
    await expect(check).toBeEnabled()
    await page.screenshot({ path: `test-results/zip-update-error-${width}.png` })
  })
}
