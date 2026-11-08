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

test('the field log receipts are the snapshot’s own counts', async ({ page, request }) => {
  const snap = (await (await request.get('/data/snapshot.json')).json()) as {
    score: { all_rows: { counts: { resolved: number } }; headline: { counts: { resolved: number } } };
  };
  await page.goto('/?replay');
  await expect(page.locator('#fl-rounds')).toHaveText(snap.score.all_rows.counts.resolved.toLocaleString('en-US'));
  await expect(page.locator('#fl-head')).toHaveText(snap.score.headline.counts.resolved.toLocaleString('en-US'));
});

test('every page links the source code', async ({ page }) => {
  for (const hash of ['', '#/notebook', '#/how']) {
    await page.goto(`/?replay${hash}`);
    await expect(page.locator('header.top a[href="https://github.com/edycutjong/rimba"]')).toBeVisible();
    await expect(page.locator('footer.colophon a[href="https://github.com/edycutjong/rimba"]')).toBeVisible();
  }
});

test('on a phone, a cited note still says which memory it came from', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?replay');
  const where = page.locator('#slips .slip-where').first();
  await expect(where).toBeVisible({ timeout: 10_000 });
  await expect(where).toHaveText(/Walrus/);
});

test('the notebook and the explainer have no horizontal scroll on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?replay#/notebook');
  await expect(page.locator('.nb-count')).toContainText('in this replay');
  await expect(page.locator('.nb tbody tr').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.goto('/?replay#/how');
  await expect(page.locator('.loop-list')).toBeVisible(); // the stacked loop replaces the wide diagram on phones
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
