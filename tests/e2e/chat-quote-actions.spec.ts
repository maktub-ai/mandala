import { test, expect } from './helpers/execution-fixture';

test.beforeEach(async ({ page, request, executionDirectory }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  const { config, revision } = await (await request.get('/api/config')).json();
  const agent = { id: 'quote-writer', name: 'Quote writer', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] };
  const project = { id: 'quote-project', name: 'Quote project', cwd: executionDirectory, agentIds: [agent.id], resources: [], mcp: [], skills: [] };
  const response = await request.put('/api/config', { data: { revision, config: { ...config, projects: [project], agents: [...config.agents.filter((item: { systemRole?: string }) => item.systemRole), agent] } } });
  expect(response.ok(), await response.text()).toBe(true);
});

for (const projectId of ['quote-project', '']) {
  test(`chat ${projectId || 'without a project'} offers Quote without transferring messages to Mandala`, async ({ page, request }, testInfo) => {
    const response = await request.post('/api/conversations', { data: { projectId, agentId: 'quote-writer', cli: 'codex' } });
    expect(response.ok(), await response.text()).toBe(true);
    const chat = await response.json();
    await page.goto(`/?conversation=${chat.id}`);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('quoted sentence');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const answer = page.locator('.agent-reply .markdown-text');
    await expect(answer).toContainText('Fixture reply: quoted sentence');
    await expect(page.getByRole('button', { name: /Reference (message )?in Mandala/ })).toHaveCount(0);
    await input.fill('existing draft');
    const transfers: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/references')) transfers.push(request.url()); });
    for (const [theme, width] of [['light', 1280], ['dark', 390]] as const) {
      await page.evaluate(theme => localStorage.setItem('mana-theme', theme), theme);
      await page.setViewportSize({ width, height: 850 });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(input).toHaveValue('existing draft');
      await answer.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect(page.getByRole('button', { name: 'Quote selection', exact: true })).toBeVisible();
      await expect(page.locator('.selection-quote button')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`quote-${theme}-${width}.png`) });
      await page.getByRole('button', { name: 'Quote selection', exact: true }).click();
      await expect(input).toHaveValue('existing draft');
      await expect(page).toHaveURL(new RegExp(`conversation=${chat.id}`));
      await page.getByRole('button', { name: 'Preview text Quoted text.txt', exact: true }).last().click();
      await expect(page.getByRole('dialog', { name: 'Text preview', exact: true }).locator('pre')).toHaveText('Fixture reply: quoted sentence');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Remove attachment Quoted text.txt', exact: true }).last().click();
    }
    expect(transfers).toEqual([]);
  });
}

for (const mandala of [false, true]) {
  test(`dragging a quote into the ${mandala ? 'Mandala' : 'ordinary chat'} composer keeps the draft`, async ({ page, request }, info) => {
    const response = mandala
      ? await request.get('/api/mandala')
      : await request.post('/api/conversations', { data: { projectId: 'quote-project', agentId: 'quote-writer', cli: 'codex' } });
    expect(response.ok(), await response.text()).toBe(true);
    const result = await response.json();
    if (mandala) {
      const settings = await request.put('/api/mandala', { data: { revision: result.revision, settings: { name: 'Mandala', soul: '', cli: 'codex', models: { codex: 'model-fixture' }, maxParallel: 3 } } });
      expect(settings.ok(), await settings.text()).toBe(true);
    }
    const id = mandala ? result.conversation.id : result.id;
    const route = `${mandala ? '/mandala' : '/'}?conversation=${id}`;
    await page.goto(route);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const prompt = `A sentence to quote from ${mandala ? 'Mandala' : 'chat'}`;
    await input.fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const turn = page.locator('.chat-turn').filter({ hasText: prompt });
    const answer = turn.locator('.agent-reply .markdown-text');
    await expect(answer).toContainText(prompt);
    const reply = turn.getByRole('button', { name: 'Quote reply', exact: true });
    await expect(reply).toBeEnabled();
    await input.fill('existing draft');
    type HistoryEvent = { kind: string; data: { text?: string } };
    const history = async (): Promise<HistoryEvent[]> => (await request.get(`/api/conversations/${id}/history`)).json();
    const before = await history();
    const replyText = before.filter(event => event.kind === 'text').map(event => event.data.text).join('\n\n');
    const quote = async (name: string, value: string) => {
      await page.getByRole('button', { name, exact: true }).dragTo(input);
      await expect(input).toHaveValue('existing draft');
      const preview = page.getByRole('button', { name: 'Preview text Quoted text.txt', exact: true });
      await expect(preview).toBeVisible();
      await preview.click();
      expect(await page.getByRole('dialog', { name: 'Text preview', exact: true }).locator('pre').textContent()).toBe(value);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Remove attachment Quoted text.txt', exact: true }).click();
    };
    await turn.getByRole('article', { name: 'Your message', exact: true }).hover();
    await quote('Quote message', prompt);
    await quote('Quote reply', replyText);
    await answer.evaluate(element => {
      const text = element.querySelector('p')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 'Fixture reply:'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await quote('Quote selection', 'Fixture reply:');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/drafts/entry')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON().draft.attachments.some((attachment: { name: string; size: number }) =>
        attachment.name === 'Quoted text.txt' && attachment.size === Buffer.byteLength(replyText)));
    await reply.press('Enter');
    await expect(input).toBeFocused();
    expect((await saved).ok()).toBe(true);
    await expect(page).toHaveURL(route);
    expect((await history()).filter(event => event.kind === 'user')).toEqual(before.filter(event => event.kind === 'user'));

    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1440, height: 850 });
      await page.evaluate(theme => localStorage.setItem('mana-theme', theme), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(input).toHaveValue('existing draft');
      await expect(page.getByRole('button', { name: 'Preview text Quoted text.txt', exact: true })).toBeVisible();
      if (mandala) await page.locator('#chat-environment-panel').getByRole('button', { name: 'Collapse right sidebar', exact: true }).click();
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 850 });
        await reply.scrollIntoViewIfNeeded();
        await expect(reply).toBeInViewport({ ratio: 1 });
        await expect(input).toBeInViewport();
        await turn.getByRole('article', { name: 'Your message', exact: true }).hover();
        await page.screenshot({ path: info.outputPath(`message-quote-${theme}-${width}.png`) });
      }
    }
  });
}
