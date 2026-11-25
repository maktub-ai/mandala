import { expect, test } from '@playwright/test';

test('opens recent turns first and keeps earlier turns and execution links available', async ({ page, request }) => {
  const { id } = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '' } })).json();
  const createdAt = new Date().toISOString();
  const events = Array.from({ length: 40 }, (_, index) => {
    const runId = 'history-run-' + index;
    return [
      { kind: 'user', data: { text: 'History request ' + index, runId } },
      { kind: 'text', data: { text: 'History reply ' + index, runId } },
      { kind: 'status', data: { status: 'idle', runId } },
    ];
  }).flat().map((event, index) => ({ ...event, id: index + 1, conversationId: id, createdAt }));
  await page.route('**/api/conversations/' + id + '/events', route => route.fulfill({
    contentType: 'text/event-stream',
    body: events.map(event => 'id: ' + event.id + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')
      + 'event: history-ready\ndata: {}\n\n',
  }));

  const url = '/?conversation=' + id;
  await page.goto(url);
  await expect(page.getByText('History reply 39', { exact: true })).toBeVisible();
  await expect(page.getByText('History reply 0', { exact: true })).toHaveCount(0);
  const earlier = page.getByRole('button', { name: '显示更早的消息' });
  await earlier.click();
  await expect(page.getByText('History reply 15', { exact: true })).toBeAttached();
  await earlier.click();
  await expect(page.getByText('History reply 0', { exact: true })).toBeAttached();

  await page.reload();
  await expect(page.getByText('History reply 39', { exact: true })).toBeVisible();
  await expect(page.getByText('History reply 0', { exact: true })).toHaveCount(0);
  await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+F');
  await page.getByRole('searchbox', { name: '对话内查找' }).fill('History reply 0');
  await expect(page.getByTestId('conversation-find-count')).toHaveText('1 / 1');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(url + '&run=history-run-0');
  await expect(page.locator('[data-run-id="history-run-0"]')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
