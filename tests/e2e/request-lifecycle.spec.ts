import { expect, test } from '@playwright/test';

// Hidden, preserved panels must stop background work without losing their UI state.
test('capability polling pauses when the sidebar is closed and refreshes on reopening', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '' } })).json();
  let requests = 0;
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/effective') requests++; });
  await page.clock.install();
  await page.goto('/?conversation=' + chat.id);
  await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  const panel = page.locator('#chat-environment-panel');
  await panel.getByRole('tab', { name: '能力', exact: true }).click();
  await expect(panel.locator('.effective-panel')).toBeVisible();
  await page.getByRole('button', { name: '收起右侧栏', exact: true }).click();
  const closedCount = requests;
  await page.clock.runFor(10000);
  expect(requests, 'a retained hidden panel must not keep polling').toBe(closedCount);
  await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  await expect(panel.getByRole('tab', { name: '能力', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => requests).toBeGreaterThan(closedCount);
  await expect(panel.locator('.effective-panel')).toBeVisible();
});
