import { expect, test } from '@playwright/test';
import { chooseOption } from './helpers/select';
import { setAppearanceMode } from './helpers/navigation';

const agents = ['writer', 'reviewer', 'historical'].map(id => ({ id, name: id === 'writer' ? 'Research writer' : id === 'reviewer' ? 'Evidence reviewer' : 'Past collaborator', instructions: 'Synthetic review fixture; prepare and verify project evidence.', defaultCli: 'codex', models: {}, mcp: [], skills: [], runtime: { codex: { approvalMode: 'default' } } }));
const projects = [{ id: 'review', name: 'Research workspace', agentIds: ['writer', 'reviewer'] }, { id: 'empty', name: 'Empty workspace', agentIds: [] }].map(p => ({ ...p, cwd: '/tmp', resources: [], mcp: [], skills: [], background: 'Review evidence together and keep the project decision traceable.' }));
test.beforeEach(async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  const { revision } = await (await request.get('/api/config')).json();
  const saved = await request.put('/api/config', { data: { revision, config: { version: 2, projects, agents } } });
  expect(saved.ok(), await saved.text()).toBe(true);
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark'] as const) test(`Team states, project choice and approval scope ${width} ${theme}`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/agents');
  await setAppearanceMode(page, theme);
  const executions = ['running', 'approval', 'queued', 'unknown'].map(state => ({ id: state, kind: 'run', conversationId: null, taskId: state, projectId: 'review', agentId: 'writer', state, title: `Synthetic ${state}`, href: null, time: '', accessible: false }));
  await page.route('**/api/workbench', route => route.fulfill({ json: { agents: [{ id: 'writer', name: 'Research writer', executions }], errors: [] } }));
  await page.reload();
  const node = page.locator('[data-graph-agent="writer"]');
  await expect(node.locator('[data-state="queued"]')).toBeVisible();
  await page.screenshot({ path: `audit/2026-10-20-rework/team-${width}-${theme}.png`, fullPage: true });
  await page.locator('.organization-layout').screenshot({ path: `audit/2026-10-20-rework/team-graph-${width}-${theme}.png` });
  for (const state of ['running', 'approval', 'queued', 'unknown']) await expect(node.locator(`[data-state="${state}"] .organization-node-state-label`)).toBeVisible();
  await expect(page.locator('[data-graph-project="review"] small')).toContainText('2 Agents');
  await expect(page.locator('.organization-count-note')).toContainText('current executions');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Agent list', exact: true }).click();
  await expect(page.locator('[data-team-agent="writer"]')).toContainText('Queued 1');
  await page.screenshot({ path: `audit/2026-10-20-rework/team-list-${width}-${theme}.png`, fullPage: true });
  await page.goto('/projects/review/workbench');
  const picker = page.getByRole('combobox', { name: 'Start with Agent', exact: true });
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole('option', { name: 'Research writer', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Past collaborator', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await chooseOption(page, picker, 'reviewer');
  await page.screenshot({ path: `audit/2026-10-20-rework/project-${width}-${theme}.png`, fullPage: true });
  await page.locator('.project-start-chat').getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/project=review&agent=reviewer/);
  await page.goto('/projects/empty/workbench');
  await expect(picker).toHaveAttribute('data-value', '');
  await page.locator('.project-start-chat').getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/project=empty&agent=/);
  expect((await request.patch('/api/chat-preferences/approval', { data: { agentId: 'writer', cli: 'codex', approvalMode: 'auto' } })).ok()).toBe(true);
  await page.goto('/agents?agent=writer&tab=execution');
  const approval = page.getByRole('region', { name: 'Approval policy', exact: true });
  await expect(approval).toContainText('Remembered for you');
  await expect(approval).toContainText('New chats use');
  await expect(approval).toContainText('Auto approve');
  await approval.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `audit/2026-10-20-rework/approval-${width}-${theme}.png`, fullPage: true });
  await approval.getByRole('button', { name: 'Use Agent default', exact: true }).click();
  await expect(approval).toContainText('Using Agent default');
  expect((await (await request.get('/api/chat-preferences/approval?agentId=writer&cli=codex')).json()).approvalMode).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('approval reset stays scoped and a failed reset keeps the remembered choice recoverable', async ({ page, request }) => {
  for (const [agentId, cli] of [['writer', 'codex'], ['reviewer', 'codex'], ['writer', 'omp']]) {
    expect((await request.patch('/api/chat-preferences/approval', { data: { agentId, cli, approvalMode: 'auto' } })).ok()).toBe(true);
  }
  let failReset = true;
  await page.route('**/api/chat-preferences/approval', route => route.request().method() === 'PATCH' && failReset
    ? route.fulfill({ status: 503, json: { error: 'Synthetic reset unavailable' } }) : route.continue());
  await page.goto('/agents?agent=writer&tab=execution');
  const approval = page.getByRole('region', { name: 'Approval policy', exact: true });
  await expect(approval).toContainText('Remembered for you');
  await approval.getByRole('button', { name: 'Use Agent default', exact: true }).click();
  await expect(approval.getByRole('alert')).toContainText('Synthetic reset unavailable');
  expect((await (await request.get('/api/chat-preferences/approval?agentId=writer&cli=codex')).json()).approvalMode).toBe('auto');
  failReset = false;
  await approval.getByRole('button', { name: 'Use Agent default', exact: true }).click();
  await expect(approval).toContainText('Using Agent default');
  for (const [agentId, cli] of [['reviewer', 'codex'], ['writer', 'omp']]) {
    expect((await (await request.get(`/api/chat-preferences/approval?agentId=${agentId}&cli=${cli}`)).json()).approvalMode).toBe('auto');
  }
  const { config } = await (await request.get('/api/config')).json();
  expect(config.agents.find((a: {id: string}) => a.id === 'writer').runtime.codex.approvalMode).toBe('default');
});

test('approval read failure never labels an unconfirmed preference as effective', async ({ page }) => {
  let finish: (() => void) | undefined;
  await page.route('**/api/chat-preferences/approval?**', async route => {
    await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ status: 503, json: { error: 'Synthetic preference unavailable' } });
  });
  await page.goto('/agents?agent=writer&tab=execution');
  const approval = page.getByRole('region', { name: 'Approval policy', exact: true });
  await expect(approval.getByRole('status')).toHaveText('Loading chat preference…');
  await expect(approval).not.toContainText('New chats use');
  finish!();
  await expect(approval.getByRole('alert')).toContainText('Synthetic preference unavailable');
  await expect(approval).not.toContainText('Using Agent default');
});

test('Team runtime polling waits for a stalled request across multiple intervals', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let count = 0;
    Object.defineProperty(window, 'teamPollRequests', { get: () => count });
    window.fetch = (input, init) => {
      if (input === '/api/workbench') count++;
      return original(input, init);
    };
  });
  await page.clock.install();
  let requests = 0;
  let finish: (() => void) | undefined;
  await page.route('**/api/workbench', async route => {
    const number = ++requests;
    if (number === 1) await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ json: { agents: [{ id: 'writer', executions: [{ id: 'poll', agentId: 'writer', projectId: 'review', state: number === 1 ? 'queued' : 'running' }] }], errors: [] } });
  });
  await page.goto('/agents');
  await expect.poll(() => requests).toBe(1);
  await page.clock.runFor(11000);
  expect(await page.evaluate(() => (window as unknown as { teamPollRequests: number }).teamPollRequests)).toBe(1);
  finish!();
  const node = page.locator('[data-graph-agent="writer"]');
  await expect(node.locator('[data-state="queued"]')).toBeVisible();
  await page.clock.runFor(5000);
  await expect.poll(() => requests).toBe(2);
  await expect(node.locator('[data-state="running"]')).toBeVisible();
  await expect(node.locator('[data-state="queued"]')).toHaveCount(0);
});

test('Team runtime polling pauses while hidden and resumes once when visible', async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/workbench', route => {
    requests++;
    return route.fulfill({ json: { agents: [], errors: [] } });
  });
  await page.goto('/agents');
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('[data-graph-agent="writer"] .organization-node-status')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(16000);
  expect(requests).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests).toBe(2);
});
