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

test('the chat context keeps a single quiet icon while running', async ({ page, request }) => {
  const created = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
  await expect(created).toBeOK();
  const { id } = await created.json();
  await page.route('**/api/conversations/' + id + '/environment', route => route.fulfill({
    json: { cwd: '/tmp/example', git: true, branch: 'main', changes: { files: 3, additions: 577, deletions: 406 } },
  }));
  await page.goto('/?conversation=' + id);
  const runtime = page.getByRole('button', { name: '执行端状态', exact: true });
  const context = page.getByRole('button', { name: '对话上下文', exact: true });
  const icons = context.locator('svg');
  await expect(runtime.locator('.status-dot.idle')).toBeVisible();
  await expect(icons).toHaveCount(1);
  await expect(context).toHaveText('');
  // The context sits right beside the side panel toggle.
  const toggle = await page.getByRole('button', { name: '展开右侧栏', exact: true }).boundingBox();
  const own = await context.boundingBox();
  expect(Math.abs(toggle!.x - (own!.x + own!.width))).toBeLessThan(8);
  const restingColor = await icons.first().evaluate(icon => getComputedStyle(icon).color);

  await page.getByRole('textbox', { name: '消息', exact: true }).fill('hold');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible();
  await expect(context).toHaveAccessibleDescription('执行中');
  await expect(icons).toHaveCount(1);
  await expect(icons.first()).toHaveCSS('color', restingColor);
  await expect(context).toHaveText('');
  await expect(context).toHaveAttribute('title', '对话上下文 · 执行中');
  await expect(runtime.locator('.status-dot.idle')).toBeVisible();

  await context.click();
  await expect(context).toHaveText('');
  await expect(icons).toHaveCount(1);
  const changes = page.getByRole('dialog', { name: '对话上下文', exact: true }).getByRole('button', { name: /改动 · 3 个文件/ });
  await expect(changes).toContainText('+577');
  await expect(changes).toContainText('−406');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await expect(context).not.toHaveAttribute('aria-description');
  await expect(icons).toHaveCount(1);
});

test('the chat context opens from an icon without a text label', async ({ page, request }) => {
  const created = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
  await expect(created).toBeOK();
  const { id } = await created.json();
  await page.route('**/api/conversations/' + id + '/environment', route => route.fulfill({
    json: { cwd: '/tmp/example', git: false },
  }));
  await page.goto('/?conversation=' + id);
  const context = page.getByRole('button', { name: '对话上下文', exact: true });
  await expect(context).toHaveText('');
  await expect(context.locator('svg')).toHaveCount(1);
  await expect(context).toHaveAttribute('title', '对话上下文');
  await context.press('Enter');
  await expect(page.getByRole('dialog', { name: '对话上下文', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(context).toBeFocused();
});
