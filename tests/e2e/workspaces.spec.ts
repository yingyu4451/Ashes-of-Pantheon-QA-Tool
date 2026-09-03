import { expect, test } from '@playwright/test'

test('battle workspace renders a stable tactical grid', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '战斗工作台' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择格 0, 0' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择 角盔守卫' }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/battle-workspace.png', fullPage: true })
})

test('card filters and delayed tooltip work', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '卡牌' }).click()
  await expect(page.getByRole('heading', { name: '卡牌目录' })).toBeVisible()

  const card = page.getByRole('button', { name: /双手巨剑/ })
  await card.hover()
  await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1600 })

  await page.getByRole('checkbox', { name: '装备' }).check()
  await expect(page.getByText(/显示 4 \/ 12/)).toBeVisible()
  await page.screenshot({ path: 'test-results/card-workspace.png', fullPage: true })
})

test('workspaces remain usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '战斗工作台' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.getByRole('button', { name: '卡牌' }).click()
  await expect(page.getByRole('heading', { name: '卡牌目录' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.getByRole('button', { name: '连接' }).last().click()
  await expect(page.getByRole('heading', { name: '项目与连接' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole('heading', { name: '应用更新' }).scrollIntoViewIfNeeded()
  await expect(page.getByText('开发模式不检查更新。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/narrow-setup-workspace.png', fullPage: true })
})
