import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Uses only the caller's isolated smoke HOME, against source or packaged runtimes.
export async function verifyDesktopProduct(page, origin, home, { artifactDirectory = process.env.MANDALA_SMOKE_OUTPUT ?? join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mandala-product-smoke-' + Date.now()) } = {}) {
  const cwd = join(home, 'product-proof');
  await mkdir(join(cwd, 'outputs', 'nested'), { recursive: true });
  execFileSync('git', ['init', cwd], { stdio: 'ignore' });
  await writeFile(join(cwd, '.gitignore'), 'outputs/\n');
  await writeFile(join(cwd, 'outputs', 'nested', 'report.md'), '# Packaged workspace proof');
  const fixture = await page.evaluate(async cwd => {
    const post = async (path, body) => {
      const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(path + ': ' + response.status);
      return response.json();
    };
    const {config,revision}=await(await fetch('/api/config')).json(),agentId='desktop-smoke-executor';
    const configured=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,config:{...config,agents:[...config.agents.filter(agent=>agent.id!==agentId),{id:agentId,name:'Desktop smoke executor',defaultCli:'codex',models:{},instructions:'Synthetic smoke',mcp:[],skills:[]}]}})});if(!configured.ok)throw Error('Cannot configure smoke Agent');
    const chat = await post('conversations', { cwd, workspaceId: null,agentId });
    const saved = await post('v2/tasks', { goal: 'Verify packaged task board\n\nKeep complete task details.' });
    const task=await post('v2/tasks/'+saved.id+'/executions',{conversationId:chat.id,expectedRevision:saved.revision});
    return { chat, task };
  }, cwd);
  await mkdir(artifactDirectory, { recursive: true });
  await page.goto(origin + '/settings/general');
  await page.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.settings-autosave')).toContainText('All changes saved');
  await page.goto(origin + '/tasks');
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const theme of ['light', 'dark']) {
    await page.goto(origin + '/settings/general');
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.goto(origin + '/tasks');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.sidebar a[href="/tasks"]')).toHaveText('Tasks');
    await expect(page.getByRole('button', { name: theme === 'light' ? 'List' : 'Board', exact: true })).toHaveAttribute('aria-pressed', 'true');
    assert.equal(await page.getByRole('combobox', { name: 'Show types', exact: true }).locator(':scope > span').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.goto(origin + '/tasks');
    await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.goto(origin + '/tasks?type=tasks&view=board');
    const board = page.getByRole('region', { name: 'Progress board' });
    await expect(board.locator(':scope > section')).toHaveCount(3);
    const positions = await board.locator(':scope > section').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(positions).size, 1);
    await expect(board.getByText('Verify packaged task board', { exact: true })).toBeVisible();
    let taskCard=board.locator('[data-task-id="'+fixture.task.id+'"]');
    await taskCard.locator('.progress-expand').click();
    await taskCard.getByRole('combobox').click();await page.getByRole('option',{name:'Completed',exact:true}).click();
    await expect(board.getByRole('region',{name:'Completed',exact:true}).locator('[data-task-id="'+fixture.task.id+'"]')).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
    await taskCard.locator('.progress-expand').click();await taskCard.getByRole('combobox').click();await page.getByRole('option',{name:'To do',exact:true}).click();
    await expect(board.getByRole('region',{name:'Needs attention',exact:true}).locator('[data-task-id="'+fixture.task.id+'"]')).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
    const selected = page.locator('.workspace-navigation .sidebar-destination[aria-current="page"]');
    await expect(selected).toHaveCSS('box-shadow', 'none');
    assert.notEqual(await selected.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: join(artifactDirectory, `product-board-${theme}.png`) });
  }
  await page.goto(origin + '/tasks?view=board');
  const progress = page.getByRole('region', { name: 'Progress board', exact: true });
  await expect(progress.locator(':scope > section')).toHaveCount(3);
  await expect(progress.locator('[data-task-id="' + fixture.task.id + '"]')).toBeVisible();
  const parent=progress.locator('[data-task-id="'+fixture.task.id+'"]');await parent.locator('.progress-expand').click();await expect(parent.locator('[data-linked-conversation-id="'+fixture.chat.id+'"]')).toBeVisible();
  await expect(progress.locator('[data-conversation-id]')).toHaveCount(0);
  await page.getByRole('combobox',{name:'Show types',exact:true}).click();await page.getByRole('option',{name:'Chats only',exact:true}).click();
  const conversation = progress.locator('[data-conversation-id="' + fixture.chat.id + '"]');
  await conversation.locator('.progress-expand').click();
  await conversation.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Completed', exact: true }).locator('[data-conversation-id="' + fixture.chat.id + '"]')).toBeVisible();
  assert.equal(await page.evaluate(async id => (await (await fetch('/api/v2/tasks/' + id)).json()).task.state, fixture.task.id), 'todo');
  for (const [name, tasks, chats] of [['Tasks only', 1, 0], ['Chats only', 0, 1], ['Tasks & Chats', 1, 0]]) {
    await page.getByRole('combobox', { name: 'Show types', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(progress.locator('[data-task-id]')).toHaveCount(tasks);
    await expect(progress.locator('[data-conversation-id]')).toHaveCount(chats);
  }
  await progress.locator('[data-task-id="'+fixture.task.id+'"] .progress-expand').click();
  await page.screenshot({ path: join(artifactDirectory, 'conversation-progress.png') });
  await page.goto(origin + '/?conversation=' + fixture.chat.id);
  const library=page.locator('.conversation-library');await expect(library.getByRole('combobox',{name:'Conversation source',exact:true})).toHaveCount(0);
  await expect(library.locator('button[aria-current="page"]')).toHaveAttribute('aria-describedby',new RegExp('library-context-'+fixture.chat.id));
  const grouping=await library.getByRole('combobox',{name:'Chat view',exact:true}).boundingBox(),sorting=await library.getByRole('combobox',{name:'Sort chats',exact:true}).boundingBox();assert.ok(Math.abs(grouping.y-sorting.y)<2);assert.ok(grouping.x<sorting.x);
  await page.reload();await expect(library.locator('button[aria-current="page"]')).toHaveAttribute('aria-describedby',new RegExp('library-context-'+fixture.chat.id));
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/');
  const menu = page.locator('.composer-reference-menu');
  await expect(menu.getByRole('option', { name: /Create task/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /Open terminal|All commands/ })).toHaveCount(0);
  await menu.getByRole('option', { name: /Create task/ }).click();
  await expect(page.locator('.composer-references')).toContainText('Create task');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'New task', exact: true })).toHaveCount(0);
  const tasks = await page.evaluate(async () => (await fetch('/api/v2/tasks')).json());
  assert.deepEqual(tasks.map(task => task.id), [fixture.task.id]);
  await page.getByRole('button', { name: 'Expand right sidebar', exact: true }).click();
  const panel = page.locator('#chat-environment-panel');
  await panel.getByRole('tab', { name: 'Workspace files', exact: true }).click();
  await panel.locator('summary[aria-label="outputs"]').click();
  await panel.locator('summary[aria-label="outputs/nested"]').click();
  await expect(panel.getByRole('button', { name: 'outputs/nested/report.md', exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifactDirectory, 'context-and-folders.png') });
  await panel.getByRole('button', { name: 'outputs/nested/report.md', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Packaged workspace proof', exact: true })).toBeVisible();
  await page.goto(origin + '/');
  return { artifactDirectory, taskFirstHierarchy:true, unifiedConversationSidebar:true, compactGroupSortRow:true, directTaskStateMoves: true, reopenWithoutReason: true, defaultList: true, rememberedView: true, matchingNavigationLabels: true, completeTypeLabel: true, taskBoardColumns: 3, unifiedBoardColumns: 3, independentConversationCompletion: true, typeFilters: true, noLeftAccent: true, slashContextOnly: true, ignoredSubfolderReadable: true, themes: ['light', 'dark'] };
}

export const runProductSmoke = verifyDesktopProduct;
