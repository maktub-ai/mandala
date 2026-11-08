import { test, expect } from './helpers/execution-fixture';

test.beforeEach(async ({ request, page }) => {
  await page.addInitScript(() => localStorage.setItem("mana-chat-preferences", JSON.stringify({ projectId: '', agentId: '', cli: 'codex', model: '', effort: '', onboardingCompleted: true })));
  const { revision, config } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, runtimes: ['codex'] } } })).ok()).toBe(true);
});

test('keeps composer settings in place while status changes and actions remain available', async ({ page, executionDirectory }, testInfo) => {
  await page.goto('/?cwd=' + encodeURIComponent(executionDirectory));
  const status = page.getByTestId('chat-status');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await expect(composer).toBeEnabled();
  await expect(status).toBeHidden();
  await composer.fill('hello');
  await send.click();
  await expect(page.getByText('Fixture reply: hello', { exact: true })).toBeVisible();
  await expect(status).toHaveText('就绪');
  await expect(status).toBeHidden();
  await page.reload();
  await expect(page.getByText('Fixture reply: hello', { exact: true })).toBeVisible();
  await expect(status).toBeHidden();
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  const idleLeft = (await model.boundingBox())!.x;
  await composer.fill('hold');
  await send.click();
  await expect(status).toHaveText('执行中');
  await expect.poll(async () => (await model.boundingBox())!.x).toBe(idleLeft);
  await expect(page.locator('.composer-toolbar')).not.toContainText('执行中');
  for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 768, 390]) {
    await page.evaluate(theme => localStorage.setItem('mana-theme', theme), theme);
    await page.setViewportSize({ width, height: 850 });
    await page.reload();
    await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeInViewport();
    await expect(page.locator('.turn-process').last()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`running-${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await expect(status).toHaveText('已中断');
  await expect.poll(async () => (await model.boundingBox())!.x).toBe(idleLeft);
  await composer.fill('approval');
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await expect(status).toHaveText('等待审批');
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await expect.poll(async () => (await model.boundingBox())!.x).toBe(idleLeft);
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(status).toHaveText('就绪');
  await expect(status).toBeHidden();
});

test('retains error status for assistive technology without occupying the toolbar', async ({ page, request }) => {
  const created = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.route('**/api/conversations/' + chat.id, route => route.fulfill({ json: { conversation: { ...chat, status: 'error' }, approvals: [] } }));
  await page.goto('/?conversation=' + chat.id);
  await expect(page.getByTestId('chat-status')).toHaveText('出错');
  await expect(page.getByTestId('chat-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('.composer-toolbar')).not.toContainText('出错');
});

test('announces startup without moving composer settings before creation', async ({ page, executionDirectory }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/conversations', async route => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  await page.goto('/?cwd=' + encodeURIComponent(executionDirectory));
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('hello');
  try {
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByTestId('chat-status')).toHaveText('启动中');
    await expect(page.locator('.composer-toolbar')).not.toContainText('启动中');
  } finally { release(); }
  await expect(page.getByText('Fixture reply: hello', { exact: true })).toBeVisible();
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await expect(page.getByTestId('chat-status')).toBeHidden();
});
