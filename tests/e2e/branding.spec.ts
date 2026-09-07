import { expect, test } from '@playwright/test'

test('QA emblem remains visible across workspaces and desktop window sizes', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const logo = navigation.getByRole('img', { name: 'Ashes of Pantheon QA Tool' })
  const faviconSize = await page.locator('link[rel="icon"]').evaluate(async (element: HTMLLinkElement) => {
    const image = new Image()
    image.src = element.href
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  })
  expect(faviconSize).toEqual({ width: 256, height: 256 })

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }]) {
    await page.setViewportSize(viewport)
    await expect(logo).toBeVisible()
    await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    const originalBounds = await logo.boundingBox()
    expect(originalBounds?.width).toBe(48)
    expect(originalBounds?.height).toBe(48)

    for (const workspace of ['战斗', '卡牌', '连接']) {
      const button = navigation.getByRole('button', { name: workspace, exact: true })
      await button.hover()
      await button.click()
      await expect(button).toHaveAttribute('aria-current', 'page')
      await button.focus()
      await expect(button).toBeFocused()
      await expect(logo).toBeVisible()
      expect(await logo.boundingBox()).toEqual(originalBounds)
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath(`branding-${viewport.width}.png`) })
  }
})
