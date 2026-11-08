import { expect, test } from '@playwright/test';
import {editAgentProfile,openUserMenu} from './helpers/navigation';
import { waitForAutosave } from './helpers/settings';

async function openSettingsFromAccount(page:import('@playwright/test').Page){const menu=await openUserMenu(page);await menu.locator('[data-area=settings]').click();}
test.beforeEach(async ({ request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, projects: [], agents: [{ id: 'refresh-agent', name: 'Writer', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
});

test('entering the skill library reads tool-registered content and saves against its current revision', async ({ page, request }) => {
  await page.goto('/agents');
  await expect(page.locator('.workspace-directory-row[href="/agents/refresh-agent"]')).toBeVisible();
  const { config, revision } = await (await request.get('/api/config')).json();
  config.skillLibrary = [{ id: 'tool-skill', name: 'tool-skill', path: '', content: '---\nname: tool-skill\ndescription: Registered by a tool\n---\n\nCheck changes.' }];
  expect((await request.put('/api/config', { data: { config, revision } })).ok()).toBe(true);
  await openSettingsFromAccount(page);
  await expect(page).toHaveURL(/\/settings\/general$/);await page.getByRole('link',{name:'Skills',exact:true}).click();await expect(page.getByRole('heading',{name:'tool-skill',exact:true})).toBeVisible();
  await page.getByRole('checkbox', { name: '分配给 Writer', exact: true }).check();
  await waitForAutosave(page);
  expect((await (await request.get('/api/config')).json()).config.agents[0].skillIds).toEqual(['tool-skill']);
});

test('a late configuration refresh preserves edits made while navigating', async ({ page, request }) => {
  await page.goto('/agents?agent=refresh-agent');await editAgentProfile(page);
  const name = page.getByRole('textbox', { name: '智能体 名称', exact: true });
  await expect(name).toHaveValue('Writer');
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      requested();
      await waiting;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await openSettingsFromAccount(page);
  await started;
  await name.fill('Edited during navigation');
  release();
  await expect(page).toHaveURL(/\/settings\/general$/);await page.getByRole('link',{name:'Skills',exact:true}).click();await expect(page).toHaveURL(/\/mana\/skills$/);
  await waitForAutosave(page);
  expect((await (await request.get('/api/config')).json()).config.agents[0].name).toBe('Edited during navigation');
});

test('starting a chat cancels a pending Settings navigation', async ({ page }) => {
  await page.goto('/agents?agent=refresh-agent');await editAgentProfile(page);
  await expect(page.getByRole('textbox', { name: '智能体 名称', exact: true })).toHaveValue('Writer');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'GET') { entered(); await gate; }
    await route.continue();
  });
  try {
    await openSettingsFromAccount(page);
    await started;
    await page.locator('aside.sidebar .new-chat').click();
    const destination = page.url();
    expect(destination).not.toContain('/agents');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'GET');
    release(); await (await refreshed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(destination);
  } finally { release(); }
});
