import { test, expect } from './helpers/execution-fixture';
test.use({ hasTouch: true });

test.beforeEach(async ({ request, executionDirectory }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, runtimes: ['codex'],
    projects: [{ id: 'personal-chat', name: 'Personal chat', cwd: executionDirectory, agentIds: ['personal-agent'], resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'personal-agent', name: 'Personal agent', instructions: 'Synthetic fixture.', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
  } } })).ok()).toBe(true);
});

test('long replay first reveals the end, preserves upward reading during live updates and switches', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'personal-chat', agentId: 'personal-agent' } })).json();
  expect((await request.post(`/__test__/personal-history/${chat.id}`)).ok()).toBe(true);
  await request.patch(`/api/conversations/${chat.id}`, { data: { title: 'Long synthetic conversation' } });
  const other = await (await request.post('/api/conversations', { data: { projectId: 'personal-chat', agentId: 'personal-agent' } })).json();
  await request.patch(`/api/conversations/${other.id}`, { data: { title: 'Other synthetic conversation' } });
  await page.addInitScript(() => {
    (window as any).historyFrames = [];
    const inspect = () => {
      const viewport = document.querySelector('.conversation'), messages = document.querySelector('.messages') as HTMLElement | null;
      if (viewport && messages && getComputedStyle(messages).display !== 'none' && getComputedStyle(messages).visibility !== 'hidden' && messages.textContent?.includes('History reply')) {
        (window as any).historyFrames.push({ text: messages.textContent, gap: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight });
      }
      requestAnimationFrame(inspect);
    }; requestAnimationFrame(inspect);
  });
  await page.goto(`/?project=personal-chat&conversation=${chat.id}`);
  await expect(page.getByText(/^History reply 79:/)).toBeVisible();
  const frames = await page.evaluate(() => (window as any).historyFrames);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0].text).toContain('History reply 79:');
  expect(frames[0].gap).toBeLessThan(5);
  if (process.env.OPEN_MANA_CHAT_REVIEW_DIR) await page.screenshot({ path: `${process.env.OPEN_MANA_CHAT_REVIEW_DIR}/history-first-frame.png` });
  await page.locator('.conversation').evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  await request.post(`/__test__/personal-live/${chat.id}`);
  await expect(page.getByText('Live synthetic update', { exact: true })).toHaveCount(1);
  expect(await page.locator('.conversation').evaluate(element => element.scrollTop)).toBeLessThan(5);
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect(page.getByText('Live synthetic update', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Other synthetic conversation', exact: true }).click();
  await expect(page.getByText(/^History reply 79:/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Long synthetic conversation', exact: true }).click();
  await expect(page.getByText('Live synthetic update', { exact: true })).toBeVisible();
});

for (const mobile of [false, true]) test(`slash references search, choose, remove and send exact identities; mobile=${mobile}`, async ({ page, request }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'personal-chat', agentId: 'personal-agent' } })).json();
  const items = [
    { id: 'skill:project:review', kind: 'skill', name: 'review', source: 'Project · personal-chat', detail: '/synthetic/project/SKILL.md', status: 'available' },
    { id: 'skill:native:review', kind: 'skill', name: 'review', source: 'Native · Codex', detail: '/synthetic/native/SKILL.md', status: 'shadowed' },
    { id: 'mcp:agent:knowledge', kind: 'mcp', name: 'knowledge', source: 'Agent · personal-agent', detail: 'Read-only MCP', status: 'available' },
    { id: 'task:exact-task', kind: 'task', name: 'Delivery', source: 'Project · personal-chat', detail: 'exact-task', status: 'open' },
  ];
  await page.route(`**/api/conversations/${chat.id}/references`, route => route.fulfill({ json: { items } }));
  let sent: any;
  await page.route(`**/api/conversations/${chat.id}/queue`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON(); await route.fulfill({ status: 202, json: { id: 'reference-input', commandKey: sent.commandKey, state: 'queued' } });
  });
  await page.goto(`/?project=personal-chat&conversation=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeVisible();
  await composer.fill('/review');
  const menu = page.getByRole('listbox', { name: '上下文与引用' });
  await expect(menu).toBeVisible(); await expect(menu).toContainText('Project · personal-chat'); await expect(menu).toContainText('Native · Codex');
  if (process.env.OPEN_MANA_CHAT_REVIEW_DIR) await page.screenshot({ path: `${process.env.OPEN_MANA_CHAT_REVIEW_DIR}/references-${mobile ? 'mobile' : 'desktop'}-light-zh.png` });
  if (mobile) await menu.getByRole('option').first().tap();
  else { await composer.press('ArrowDown'); await composer.press('ArrowUp'); await composer.press('Enter'); }
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: '移除引用 review' })).toBeVisible();
  if (mobile) { await composer.fill('/knowledge'); await menu.getByRole('option').tap(); }
  else { await composer.fill('/'); await composer.press('ArrowDown'); await composer.press('Enter'); }
  await page.getByRole('button', { name: '移除引用 knowledge' }).click();
  await composer.fill('/Delivery'); await composer.press('Escape'); await expect(menu).toHaveCount(0);
  await composer.click(); await composer.fill('/Delivery'); await menu.getByRole('option').click();
  await composer.fill('Use these precise references');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => sent).toBeTruthy();
  expect(sent.references).toEqual([{ id: 'skill:project:review' }, { id: 'task:exact-task' }]);
  expect(sent.text).toBe('Use these precise references');
  await expect(page.getByRole('button', { name: '移除引用 review' })).toHaveCount(0);
  if (mobile) {
    await page.evaluate(() => { localStorage.setItem('mana-language', 'en'); localStorage.setItem('mana-theme', 'dark'); });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Rename chat', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/review');
    const englishMenu = page.getByRole('listbox', { name: 'Context and references' });
    await expect(englishMenu).toBeVisible(); await expect(englishMenu.getByRole('img', { name: 'Overridden by higher priority' })).toHaveCount(1);
    expect(await englishMenu.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
    if (process.env.OPEN_MANA_CHAT_REVIEW_DIR) await page.screenshot({ path: `${process.env.OPEN_MANA_CHAT_REVIEW_DIR}/references-mobile-dark-en.png` });
  }
});

test('new conversation slash catalog uses current context and references survive conversation creation', async ({ page }) => {
  const item = { id: 'skill:project:before-first-message', kind: 'skill', name: 'first-message-skill', source: 'Project · Personal chat', detail: '/synthetic/SKILL.md', status: 'available' };
  await page.route('**/api/composer-references?**', route => route.fulfill({ json: { items: [item] } }));
  const attempts: any[] = [];
  let confirmed = false;
  await page.route('**/api/conversations/*/queue', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({json: confirmed && attempts.length ? [{id:'reference-input',commandKey:attempts[0].commandKey,state:'completed'}] : []});
    attempts.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'Synthetic response lost' } });
  });
  await page.goto('/?project=personal-chat&agent=personal-agent');
  await expect(page.getByRole('combobox', { name: '当前 智能体', exact: true })).toHaveAttribute('data-value', 'personal-agent');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('/first-message-skill');
  await page.getByRole('listbox', { name: '上下文与引用' }).getByRole('option').click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提交状态待确认');
  await expect(page.getByRole('button', { name: '移除引用 first-message-skill' })).toBeVisible();
  confirmed = true;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除引用 first-message-skill' })).toHaveCount(0);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].references).toEqual([{ id: item.id }]);
  expect(attempts[0].text).toBe('');
  expect(new URL(page.url()).searchParams.get('conversation')).toBeTruthy();
});
