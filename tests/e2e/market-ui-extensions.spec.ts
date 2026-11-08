import { legacyArabicEntry } from '../fixtures/language-plugin';
import { test, expect } from '@playwright/test';
import { chooseOption } from './helpers/select';
test.beforeEach(async ({ request }) => {
  const sources = await (await request.get('/api/market/sources')).json();
  const response = await request.put('/api/market/sources', { data: {
    revision: sources.revision, sources: [], enabled: ['mandala-themes', 'mandala-languages'],
  } });
  expect(response.ok(), await response.text()).toBe(true);
});
test('theme installation preserves appearance until applied, persists, and can be removed offline', async ({ page }) => {
  await page.goto('/market?kind=theme');
  const palette = await page.locator('html').getAttribute('data-palette');
  await page.getByRole('button', { name: '查看详情 Community Paper', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '安装', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '应用主题', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-palette', palette!);
  await dialog.getByRole('button', { name: '应用主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'market:paper:light');
  await page.reload();
  await page.goto('/market?tab=installed&kind=theme');
  await page.getByRole('button', { name: '查看详情 Community Paper', exact: true }).click();
  await page.route('**/api/market/detail?*', route => route.abort());
  await dialog.getByRole('button', { name: '卸载', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看详情 Community Paper', exact: true })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'market:paper:light');
});
for (const variant of ['light', 'dark']) test(`language installation, RTL, fallback and removal in ${variant}`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('mana-theme', value), variant);
  await page.goto('/market?kind=language');
  await page.getByRole('button', { name: '查看详情 العربية', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '安装', exact: true }).click();
  const sidebarBefore = (await page.locator('.area-sidebar').boundingBox())!;
  const drawerBefore = (await page.getByRole('dialog').boundingBox())!;
  await page.getByRole('dialog').getByRole('button', { name: '使用此语言', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', variant);
  // Changing text language must not move navigation or details to the opposite edge.
  expect((await page.locator('.area-sidebar').boundingBox())!.x).toBeCloseTo(sidebarBefore.x, 0);
  expect((await page.getByRole('dialog').boundingBox())!.x).toBeCloseTo(drawerBefore.x, 0);
  const title = (await page.locator('.market-drawer-header h2').boundingBox())!;
  const close = (await page.getByRole('button', { name: 'Close details', exact: true }).boundingBox())!;
  expect(close.x).toBeGreaterThan(title.x + title.width);
  await page.getByRole('dialog').getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'السوق', exact: true })).toBeVisible();
  // Arabic glyphs still read right-to-left inside the unchanged left-to-right shell.
  const arabicGlyphs = await page.getByRole('heading', { name: 'السوق', exact: true }).evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 1);
    const first = range.getBoundingClientRect().x;
    range.setStart(text, text.textContent!.length - 1); range.setEnd(text, text.textContent!.length);
    return { first, last: range.getBoundingClientRect().x };
  });
  expect(arabicGlyphs.first).toBeGreaterThan(arabicGlyphs.last);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', variant);
  expect((await page.locator('.area-sidebar').boundingBox())!.x).toBeCloseTo(sidebarBefore.x, 0);
  await page.goto('/settings/general');
  await expect(page.getByRole('heading', {name: 'اختصارات', exact: true})).toBeVisible();
  const headingTextOffset = await page.getByRole('heading', { name: 'اختصارات', exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return range.getBoundingClientRect().left - element.getBoundingClientRect().left;
  });
  expect(headingTextOffset).toBeLessThan(2);
  await expect(page.getByLabel('Language / 语言')).toContainText('العربية');
  const languageLabel = (await page.locator('.general-settings .settings-form-row > span').boundingBox())!;
  const languageControl = (await page.getByLabel('Language / 语言').boundingBox())!;
  expect(languageControl.x).toBeGreaterThan(languageLabel.x);
  await page.getByLabel('Language / 语言').scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: `/tmp/mandala-language-settings-${variant}.png` });
  await chooseOption(page, page.getByLabel('Language / 语言'), 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await chooseOption(page, page.getByLabel('Language / 语言'), 'ar');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await page.goto('/market?tab=installed&kind=language');
  await page.getByRole('button', { name: 'View details العربية', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({width, height:900});
    const bounds = (await page.getByRole('dialog').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(width - bounds.x - bounds.width).toBeLessThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({animations:'disabled',path:`/tmp/mandala-language-rtl-${variant}-${width}.png`});
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
test('market filters show migrated languages once when both sources are enabled', async ({ page, request }) => {
  const sources = await (await request.get('/api/market/sources')).json();
  expect((await request.put('/api/market/sources', { data: { revision: sources.revision, sources: [], enabled: ['mandala-plugins', 'mandala-languages', 'mandala-themes'] } })).ok()).toBe(true);
  await page.goto('/market');
  await expect(page.getByRole('button', { name: '查看详情 العربية', exact: true })).toHaveCount(1);
  await chooseOption(page, '能力类型', 'theme');
  await expect(page.getByRole('button', { name: '查看详情 Community Paper', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看详情 العربية', exact: true })).toHaveCount(0);
});

for (const variant of ['light', 'dark']) test(`migrates an installed Arabic pack without changing the active locale in ${variant}`, async ({ page, request }) => {
  const initial = await (await request.get('/api/market/extensions')).json();
  expect((await request.post('/api/market/extensions/install', { data: { catalogId: 'language:arabic-starter', version: legacyArabicEntry.version, digest: legacyArabicEntry.package.sha256, revision: initial.revision } })).ok()).toBe(true);
  await page.addInitScript(value => { localStorage.setItem('mana-language', 'ar'); localStorage.setItem('mana-theme', value); }, variant);
  await page.goto('/market?kind=language&source=mandala-languages');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await page.getByRole('button', { name: 'View details العربية', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Use this language', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('data-theme', variant);
  const installed = await (await request.get('/api/market/extensions')).json();
  expect(installed.items.filter((item: any) => item.data.locale === 'ar')).toHaveLength(1);
  expect(installed.items.some((item: any) => item.catalogId === 'language:arabic-starter')).toBe(false);
  await page.goto('/market?tab=installed&kind=language&source=mandala-languages');
  await page.getByRole('button', { name: 'View details العربية', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
