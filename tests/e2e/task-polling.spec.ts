import { expect, test } from '@playwright/test';

for (const scenario of ['automations', 'detail', 'detail-control-failure']) test(`Tasks polling stays single-flight and visible-only: ${scenario}`, async ({ page, request }) => {
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': `poll-${scenario}` }, data: { goal: 'Synthetic polling task' } })).json();
  const path = scenario === 'automations' ? '/api/automations' : `/api/v2/tasks/${task.id}`;
  const payload = await (await request.get(path)).json();
  await page.addInitScript(target => {
    localStorage.setItem('mana-language', 'en');
    const original = window.fetch.bind(window);
    let count = 0;
    Object.defineProperty(window, 'taskPollRequests', { get: () => count });
    window.fetch = (input, init) => { if (input === target) count++; return original(input, init); };
  }, path);
  await page.clock.install();
  let requests = 0, finish: (() => void) | undefined;
  await page.route('**' + path, async route => {
    if (++requests === 1) await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ json: payload });
  });
  if (scenario === 'detail-control-failure') {
    let fail = true;
    await page.route(`**/api/v2/tasks/${task.id}/control`, route => {
      if (!fail) return route.continue();
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'Synthetic control unavailable' } });
    });
  }
  if (scenario === 'automations') await page.route(`**/api/v2/tasks/${task.id}`, () => new Promise(() => {}));
  await page.goto('/tasks/' + task.id);
  await expect.poll(() => requests).toBe(1);
  await page.clock.runFor(7000);
  const count = () => page.evaluate(() => (window as unknown as { taskPollRequests: number }).taskPollRequests);
  expect(await count()).toBe(1);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === path);
  finish!();
  await (await response).finished();
  await page.clock.runFor(3001);
  await expect.poll(count).toBe(2);
  if (scenario !== 'automations') await expect(page.getByRole('heading', { name: 'Synthetic polling task', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(7000);
  expect(await count()).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(count).toBe(3);
});

test('Task manual action refresh remains available while scheduled polling is hidden', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'poll-manual' }, data: { goal: 'Manual action polling task' } })).json();
  await page.goto('/tasks/' + task.id);
  await expect(page.getByRole('heading', { name: 'Manual action polling task', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(page.locator('.task-detail .task-status').first()).toHaveText('Cancelled');
  expect((await (await request.get(`/api/v2/tasks/${task.id}`)).json()).task.state).toBe('cancelled');
});

test('mounted task rule editor also stops background automation polling while hidden', async ({ page, request }) => {
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'poll-rules-hidden' }, data: { goal: 'Task rule polling' } })).json();
  await page.addInitScript(() => {
    localStorage.setItem('mana-language', 'en');
    const original = window.fetch.bind(window);
    let count = 0;
    Object.defineProperty(window, 'automationRequests', { get: () => count });
    window.fetch = (input, init) => { if (input === '/api/automations') count++; return original(input, init); };
  });
  await page.clock.install();
  await page.goto('/tasks/' + task.id);
  await expect(page.getByRole('heading', { name: 'Task rule polling', exact: true })).toBeVisible();
  const count = () => page.evaluate(() => (window as unknown as { automationRequests: number }).automationRequests);
  await expect.poll(count).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = await count();
  await page.clock.runFor(7000);
  expect(await count()).toBe(before);
});
