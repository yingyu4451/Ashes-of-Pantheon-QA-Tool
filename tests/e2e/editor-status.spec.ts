import { expect, test } from '@playwright/test'

interface EditorTestState {
  status: 'current' | 'outdated' | 'not-installed'
  delay: number
  fail: boolean
  nextPath: string
  installs: number
}
declare global { interface Window { editorTest: EditorTestState } }

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const state: EditorTestState = { status: 'current', delay: 0, fail: false, nextPath: 'C:/Unity/Other', installs: 0 }
    window.editorTest = state
    window.qaNative = {
      readPreferences: async () => ({ unityProjectPath: 'C:/Unity/Selected', gameBuildPath: '' }),
      writePreferences: async () => ({ ok: true, message: '已保存' }),
      readCatalogCache: async () => null,
      listBridgeInstances: async () => [],
      getUpdateStatus: async () => ({ phase: 'disabled', currentVersion: '0.1.12', message: '开发模式不检查更新。' }),
      onUpdateStatus: () => () => undefined,
      selectDirectory: async () => state.nextPath,
      inspectUnityProject: async (path: string) => {
        const status = state.status
        const fail = state.fail
        if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
        if (fail) throw new Error('无法读取项目目录，请检查访问权限。')
        return {
          path, valid: true, unityVersion: '2022.3', bridgeInstalled: status !== 'not-installed',
          bridgeStatus: status, installedBridgeVersion: status === 'not-installed' ? undefined : '0.3.4', bundledBridgeVersion: '0.3.4',
          message: status === 'current' ? 'Bridge 已是当前工具内置版本。' : status === 'outdated' ? 'Bridge 文件与当前工具内置版本不一致，请更新。' : 'Bridge 未安装。'
        }
      },
      installEditorBridge: async () => { state.installs++; state.status = 'current'; return { ok: true, message: '已安装。' } },
      uninstallEditorBridge: async () => { state.status = 'not-installed'; return { ok: true, message: '已卸载。' } }
    } as unknown as typeof window.qaNative
  })
  await page.goto('/')
})

test('Editor Bridge actions follow file status and support manual and focus checks', async ({ page }, testInfo) => {
  const editor = page.getByRole('region', { name: 'Editor Bridge', exact: true })
  const refresh = editor.getByRole('button', { name: '检查 Bridge 状态', exact: true })
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
  const primaryWidth = (await editor.getByRole('button', { name: 'Bridge 已是最新', exact: true }).boundingBox())!.width
  await refresh.hover()
  await refresh.focus()
  await expect(refresh).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('editor-current.png') })
  await page.evaluate(() => Object.assign(window.editorTest, { status: 'outdated', delay: 350 }))
  await refresh.click()
  await expect(editor.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '检查 Bridge 状态…', exact: true })).toBeDisabled()
  const update = editor.getByRole('button', { name: '更新 Bridge', exact: true })
  await expect(update).toBeEnabled()
  expect((await update.boundingBox())!.width).toBe(primaryWidth)
  await page.evaluate(() => { window.editorTest.delay = 0 })
  await update.click()
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.editorTest.installs)).toBe(1)

  await page.evaluate(() => { window.editorTest.status = 'not-installed'; window.dispatchEvent(new Event('focus')) })
  await expect(editor.getByRole('button', { name: '安装 Bridge', exact: true })).toBeEnabled()
  await expect(editor.getByRole('button', { name: '卸载 Bridge', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '安装 Bridge', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
  page.once('dialog', (dialog) => dialog.accept())
  await editor.getByRole('button', { name: '卸载 Bridge', exact: true }).click()
  await expect(editor.getByRole('button', { name: '安装 Bridge', exact: true })).toBeEnabled()

  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 720 })
    await page.screenshot({ path: testInfo.outputPath(`editor-status-${width}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  await page.evaluate(() => { window.editorTest.fail = true })
  await refresh.click()
  await expect(editor.getByRole('status')).toContainText('无法读取项目目录')
  await page.screenshot({ path: testInfo.outputPath('editor-error.png') })
  await expect(editor.getByRole('button', { name: '安装 Bridge', exact: true })).toBeDisabled()
  await expect(refresh).toBeEnabled()
  await page.evaluate(() => { window.editorTest.fail = false; window.editorTest.status = 'current' })
  await refresh.click()
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
})

test('a stale project check cannot overwrite the newly selected project', async ({ page }) => {
  const editor = page.getByRole('region', { name: 'Editor Bridge', exact: true })
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
  await page.evaluate(() => Object.assign(window.editorTest, { delay: 600, status: 'current' }))
  await editor.getByRole('button', { name: '检查 Bridge 状态', exact: true }).click()
  await page.evaluate(() => Object.assign(window.editorTest, { delay: 0, status: 'not-installed' }))
  await editor.getByRole('button', { name: '选择项目', exact: true }).click()
  await expect(page.getByLabel('Unity 项目路径')).toHaveValue('C:/Unity/Other')
  await expect(editor.getByRole('button', { name: '安装 Bridge', exact: true })).toBeEnabled()
  await page.waitForTimeout(700)
  await expect(editor.getByRole('button', { name: '安装 Bridge', exact: true })).toBeEnabled()
})

test('clicking the connection tab again and returning to it refreshes Bridge status', async ({ page }) => {
  const editor = page.getByRole('region', { name: 'Editor Bridge', exact: true })
  const navigation = page.getByRole('navigation', { name: '主导航' })
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
  await page.evaluate(() => { window.editorTest.status = 'outdated' })
  await navigation.getByRole('button', { name: '连接', exact: true }).click()
  await expect(editor.getByRole('button', { name: '更新 Bridge', exact: true })).toBeEnabled()
  await navigation.getByRole('button', { name: '卡牌', exact: true }).click()
  await page.evaluate(() => { window.editorTest.status = 'current' })
  await navigation.getByRole('button', { name: '连接', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Bridge 已是最新', exact: true })).toBeDisabled()
})
