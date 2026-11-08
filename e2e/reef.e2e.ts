import { test, expect } from '@playwright/test';

test('reef replays the committed mainnet snapshot with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const snapshot = page.waitForResponse((r) => r.url().includes('/data/snapshot') && r.ok());

  await page.goto('/?replay'); // replay = what a visitor on rimba.edycu.dev gets (localhost would try LIVE first)
  await snapshot;
  await expect(page.getByText('REPLAY', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/checkpoint #\d+/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('the reef has no horizontal scroll on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?replay'); // replay = what a visitor on rimba.edycu.dev gets (localhost would try LIVE first)
  await expect(page.getByText('REPLAY', { exact: false }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
