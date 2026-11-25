import { expect, test } from '@playwright/test';
import { planSection } from '../fixtures/data-plugin';
import { storedUiState } from './helpers/preferences';

test.use({ storageState: storedUiState('en'), viewport: { width: 390, height: 844 } });

test('English library tabs put the third plugin in More and keep its URL on return', async ({ page }, info) => {
  const choices = ['Delivery plan', 'Product plan', 'Release plan'];
  const items = choices.map((name, i) => ({
    id: 'plan-' + i, pluginId: 'todo-' + i, catalogId: 'todo-section-' + i,
    data: { ...planSection, label: { zh: '计划', en: name } },
  }));
  await page.route('**/api/market/extensions', route => route.fulfill({ json: { revision: 'fixture', items, plugins: [] } }));
  await page.route('**/api/v2/library-sections/*/files', route => route.fulfill({
    json: { projects: [{ projectId: 'todo', projectName: 'Todo project', files: [{
      id: 'todo-app', title: 'Todo launch', filename: 'view.html', badge: 0, needsUpdate: false, modifiedAt: null, viewUrl: null,
    }] }] },
  }));
  await page.goto('/library');
  await expect(page.getByRole('tab', { name: 'Knowledge base' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Release plan' }).click();
  await expect(page).toHaveURL(/tab=plan-2$/);
  await expect(page.getByRole('link', { name: 'Open Todo project' })).toBeVisible();
  await expect(page.getByText('Todo launch', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const lastTab = await page.getByRole('tab', { name: 'Product plan' }).boundingBox();
  const more = await page.getByRole('button', { name:'More' }).boundingBox();
  expect(Math.abs(lastTab!.y - more!.y)).toBeLessThan(10);
  await page.getByRole('heading', { name: 'Library' }).click();
  await page.screenshot({ path: info.outputPath('library-plans-global-narrow.png'), animations: 'disabled' });
  const entries = await page.evaluate(() => history.length);
  await page.getByRole('tab', { name: 'Knowledge base' }).click();
  await expect(page).toHaveURL(/tab=wiki$/);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await page.goBack();
  await expect(page).toHaveURL(/tab=plan-2$/);
  await page.reload();
  await expect(page.getByRole('button', { name:'More' })).toHaveAttribute('data-selected', 'true');
});
