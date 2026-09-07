import { expect, test } from '@playwright/test'

test('filtering and sorting have distinct visible labels and keep their existing behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 680 })
  await page.goto('/')
  await page.getByRole('button', { name: '卡牌', exact: true }).click()
  const filters = page.getByRole('group', { name: '筛选', exact: true })
  const sorting = page.getByRole('group', { name: '排序', exact: true })
  await expect(filters.getByText('筛选', { exact: true })).toBeVisible()
  await expect(sorting.getByText('排序', { exact: true })).toBeVisible()
  await filters.getByRole('checkbox', { name: '装备', exact: true }).check()
  await expect(page.getByText('显示 4 / 12', { exact: true })).toBeVisible()
  await sorting.getByLabel('排序字段').selectOption('typeId')
  await sorting.getByRole('button', { name: '切换为降序' }).click()
  await expect(sorting.getByRole('button', { name: '切换为升序' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100)
  await page.screenshot({ path: 'test-results/catalog-filter-sort-labels.png' })
})
