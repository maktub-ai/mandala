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
