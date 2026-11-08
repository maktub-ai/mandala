import { test, expect, type Page } from '@playwright/test';

const dot = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString('base64');
const petFile = JSON.stringify({ format: 'mandala-pet', version: 1, name: '圆点', tint: true, states: { idle: dot, working: dot, waiting: dot, error: dot } });
async function openPanel(page: Page) {
  await page.goto('/mandala');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  const card = page.getByRole('region', { name: 'Mandala 状态', exact: true });
  if (!await card.isVisible()) await page.getByRole('button', { name: /面板|Panel/ }).first().click();
  await expect(card).toBeVisible();
  return card;
}

test('the panel pet follows recorded progress and opens what needs the person', async ({ page }) => {
  let rows: unknown[] = [];
  await page.route('**/api/conversation-progress', route => route.fulfill({ json: rows }));
  const card = await openPanel(page);
  await expect(card.getByRole('status')).toContainText('一切安静');
  await expect(card.locator('svg.mandala-pet')).toHaveAttribute('data-state', /idle|sleep/);
  rows = [{ id: 'busy', title: '修复登录', state: 'running', executionStatus: 'running', withinWindow: true }];
  await expect(card.getByRole('status')).toContainText('1 个在运行', { timeout: 10000 });
  await expect(card.locator('svg.mandala-pet')).toHaveAttribute('data-state', 'working');
  rows = [...rows, { id: 'approve-me', title: '补单测', state: 'attention', executionStatus: 'approval', withinWindow: true }];
  await expect(card.getByRole('status')).toContainText('1 件事等你处理', { timeout: 10000 });
  await expect(card.locator('svg.mandala-pet')).toHaveAttribute('data-state', 'waiting');
  await expect(card.getByRole('button', { name: /弹出到桌面/ })).toHaveCount(0);
  await card.locator('.mandala-pet-figure').click();
  await expect(page).toHaveURL(/conversation=approve-me/);
});

test('a pet imported from a file replaces the figure, and an invalid file is explained', async ({ page }) => {
  await page.goto('/mandala');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Mandala 设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mandala 设置' });
  const pets = dialog.getByRole('group', { name: '选择桌宠' });
  await expect(pets.getByRole('button', { name: /花瓣精灵/ })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('导入桌宠文件').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"mandala-pet","version":1,"name":"x","states":{}}') });
  await expect(dialog.getByRole('alert')).toContainText('无法导入');
  await dialog.getByLabel('导入桌宠文件').setInputFiles({ name: 'dot.json', mimeType: 'application/json', buffer: Buffer.from(petFile) });
  await expect(pets.getByRole('button', { name: /圆点/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(pets.getByRole('button', { name: /花瓣精灵/ })).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const card = page.getByRole('region', { name: 'Mandala 状态', exact: true });
  if (!await card.isVisible()) await page.getByRole('button', { name: /面板|Panel/ }).first().click();
  await expect(card.locator('.mandala-pet.is-pack')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Mandala 状态', exact: true }).locator('.mandala-pet.is-pack')).toBeVisible();
  // Leave the official figure for later tests.
  await page.evaluate(() => localStorage.removeItem('mandala-pet'));
});

test('the desktop pet page is only the pet on a transparent page, and reacts when poked', async ({ page }) => {
  await page.route('**/api/conversation-progress', route => route.fulfill({ json: [] }));
  await page.goto('/pet');
  const figure = page.locator('.pet-window-figure');
  await expect(figure.locator('svg.mandala-pet')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const bubble = page.getByRole('status');
  await expect(bubble).toContainText('一切安静');
  await page.mouse.move(0, 0);
  await expect(bubble).not.toHaveAttribute('data-visible', /.*/);
  await figure.click();
  await expect(page.locator('.pet-window-figure[data-poke]')).toHaveCount(1);
  await expect(bubble).toHaveAttribute('data-visible', 'true');
});
