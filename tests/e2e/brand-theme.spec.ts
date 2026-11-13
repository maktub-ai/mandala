import { test, expect } from '@playwright/test';

test('the new conversation keeps real controls, sends and continues with the selected brand', async ({ page, request }) => {
  const { revision, config } = await (await request.get('/api/config')).json();
  const agent = { id: 'brand-review', name: '多模型运行接入设计伙伴', emoji: '🔌', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] };
  const saved = await request.put('/api/config', { data: { revision, config: { ...config, agents: [...config.agents, agent] } } });
  await expect(saved).toBeOK();
  await page.goto('/?agent=brand-review');
  await expect(page.getByRole('heading', { name: '从一个想法开始', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前 CLI', exact: true })).toBeVisible();
  const avatar = page.getByRole('combobox', { name: '当前 智能体', exact: true }).locator('.identity-avatar');
  await expect(avatar).toBeVisible();
  const conversation = page.locator('.conversation-viewport > .conversation');
  for (const { width, height, theme } of [
    { width: 1440, height: 900, theme: 'light' },
    { width: 390, height: 660, theme: 'dark' },
    { width: 320, height: 900, theme: 'light' },
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.setViewportSize({ width, height });
    expect.soft(await avatar.boundingBox()).toMatchObject({ width: 18, height: 18 });
    expect.soft(await conversation.evaluate(node => getComputedStyle(node).maskImage)).toBe('none');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('brand check');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: brand check', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '从一个想法开始', exact: true })).toHaveCount(0);
  await expect(conversation).toHaveCSS('mask-image', /^linear-gradient/);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('continue brand check');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: continue brand check', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fixture reply: brand check', { exact: true })).toBeVisible();
});

test('the header distinguishes a running conversation from a ready runtime', async ({ page, request }) => {
  const created = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
  await expect(created).toBeOK();
  const { id } = await created.json();
  await page.route('**/api/conversations/' + id + '/environment', route => route.fulfill({
    json: { cwd: '/tmp/example', git: true, branch: 'main', changes: { files: 3, additions: 577, deletions: 406 } },
  }));
  await page.goto('/?conversation=' + id);
  const runtime = page.getByRole('button', { name: '执行端状态', exact: true });
  const context = page.getByRole('button', { name: '对话上下文', exact: true });
  const activity = context.locator('svg.context-popover-running');
  await expect(runtime.locator('.status-dot.idle')).toBeVisible();
  await expect(context).toContainText('+577');
  await expect(activity).toHaveCount(0);

  await page.getByRole('textbox', { name: '消息', exact: true }).fill('hold');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible();
  await expect.soft(activity).toBeVisible({ timeout: 2000 });
  await expect.soft(context.locator('.status-dot')).toHaveCount(0, { timeout: 2000 });
  await expect.soft(context).toHaveAccessibleDescription('执行中', { timeout: 2000 });
  await expect(runtime.locator('.status-dot.idle')).toBeVisible();
  await expect(context).toContainText('−406');

  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await expect(activity).toHaveCount(0);
  await expect(context).not.toHaveAttribute('aria-description');
});
