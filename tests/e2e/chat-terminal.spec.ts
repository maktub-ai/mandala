import { expect, test, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedUiState } from './helpers/preferences';
import { defaultPreferences } from '../../src/themes';

async function fixture(request: APIRequestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mana-terminal-ui-')));
  writeFileSync(join(cwd, 'demo.ts'), 'const first = 1;\nconst second = 2;\nconsole.log(first + second);\n');
  const conversation = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', workspaceId: null, cwd, cli: 'codex' } })).json();
  return { cwd, conversation, url: '/?conversation=' + conversation.id, endpoint: '/api/conversations/' + conversation.id + '/terminal' };
}

async function openTerminal(page: import('@playwright/test').Page) {
  const panel = page.locator('#chat-environment-panel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  await panel.getByRole('tab', { name: '终端', exact: true }).click();
}

test('real terminal survives collapse, conversation switch and reload; selected output joins an existing draft', async ({ page, request }) => {
  const f = await fixture(request), other = await fixture(request);
  try {
    await page.goto(f.url);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Please investigate');
    await expect(page.locator('.composer-toolbar').getByRole('button', { name: '终端', exact: true })).toHaveCount(0);
    await openTerminal(page);
    const panel = page.locator('#chat-environment-panel');
    const pane = panel.getByRole('region', { name: '交互终端', exact: true });
    const input = pane.getByRole('textbox', { name: '终端输入', exact: true });
    await expect(input).toBeEnabled(); await expect(input).toBeFocused();
    await expect(pane.getByRole('alert')).not.toBeVisible();
    await input.pressSequentially("printf 'MANA_UI_%s\\n' 42"); await page.keyboard.press('Enter');
    await expect.poll(async () => (await (await request.get(f.endpoint)).json()).session.output).toContain('MANA_UI_42');
    const session = (await (await request.get(f.endpoint)).json()).session;
    await panel.getByRole('tab', { name: '文件', exact: true }).click();
    await panel.getByRole('button', { name: 'demo.ts', exact: true }).click();
    await expect(pane).not.toBeVisible();
    await panel.getByRole('tab', { name: '终端', exact: true }).click();
    await expect(pane).toContainText('MANA_UI_42');
    expect((await (await request.get(f.endpoint)).json()).session.id).toBe(session.id);
    await input.focus(); await page.keyboard.press('Control+Shift+A');
    await pane.getByRole('button', { name: '加入对话', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(/Please investigate[\s\S]*终端输出[\s\S]*MANA_UI_42/);
    expect((await (await request.get('/api/conversations/' + f.conversation.id)).json()).conversation.status).toBe('idle');
    await page.getByRole('button', { name: '收起终端', exact: true }).click();
    await expect(pane).not.toBeVisible();
    expect((await (await request.get(f.endpoint)).json()).session.id).toBe(session.id);
    await page.goto(other.url); await openTerminal(page);
    await expect(pane.getByRole('textbox', { name: '终端输入', exact: true })).toBeEnabled();
    expect((await (await request.get(other.endpoint)).json()).session.id).not.toBe(session.id);
    await page.goto(f.url); await openTerminal(page);
    await expect(pane).toContainText('MANA_UI_42');
    expect((await (await request.get(f.endpoint)).json()).session.id).toBe(session.id);
    await page.reload(); await openTerminal(page);
    await expect(pane).toContainText('MANA_UI_42');
    await pane.getByRole('button', { name: '结束终端', exact: true }).click();
    await expect(pane).toContainText('已结束');
    await pane.getByRole('button', { name: '重新启动', exact: true }).click();
    await expect(input).toBeEnabled();
    expect((await (await request.get(f.endpoint)).json()).session.id).not.toBe(session.id);
  } finally { for (const sample of [f, other]) { const state = (await (await request.get(sample.endpoint)).json()).session; if (state) await request.delete(sample.endpoint, { data: { sessionId: state.id } }); rmSync(sample.cwd, { recursive: true, force: true }); } }
});

test('file and exact code selection enter the draft without sending or losing existing text', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.goto(f.url); const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('Review this');
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const panel = page.locator('#chat-environment-panel');
    await panel.getByRole('tab', { name: '文件', exact: true }).click();
    await panel.getByRole('button', { name: 'demo.ts', exact: true }).click();
    await panel.getByRole('button', { name: '引用文件', exact: true }).click();
    await expect(composer).toHaveValue('Review this\n\n引用文件：demo.ts');
    await expect(composer).toBeFocused();
    const code = panel.locator('.workspace-code-preview code');
    await code.evaluate(el => { const nodes: Text[] = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (walker.nextNode()) nodes.push(walker.currentNode as Text); const range = document.createRange(); let start = 17, end = 34; for (const node of nodes) { if (start >= 0 && start <= node.length) { range.setStart(node, start); start = -1; } else if (start >= 0) start -= node.length; if (end <= node.length) { range.setEnd(node, end); break; } end -= node.length; } const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await panel.getByRole('button', { name: '引用选区', exact: true }).click();
    await expect(composer).toHaveValue(/Review this[\s\S]*demo.ts:2-2[\s\S]*const second = 2;/);
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

test('adding terminal output on mobile returns to the preserved chat draft', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(f.url);
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('Keep discussing this');
    await openTerminal(page);
    const pane = page.locator('#chat-environment-panel').getByRole('region', { name: '交互终端', exact: true });
    const input = pane.getByRole('textbox', { name: '终端输入', exact: true });
    await expect(input).toBeEnabled();
    await input.focus(); await page.keyboard.press('Control+Shift+A');
    await pane.getByRole('button', { name: '加入对话', exact: true }).click();
    await expect(pane).not.toBeVisible();
    await expect(composer).toHaveValue(/Keep discussing this[\s\S]*终端输出/);
    await expect(composer).toBeFocused();
    expect((await (await request.get(f.endpoint)).json()).session.state).toBe('running');
  } finally { const state = (await (await request.get(f.endpoint)).json()).session; if (state) await request.delete(f.endpoint, { data: { sessionId: state.id } }); rmSync(f.cwd, { recursive: true, force: true }); }
});

for (const theme of ['light', 'dark']) for (const language of ['zh', 'en']) test('terminal fits a narrow viewport and exposes keyboard controls in ' + theme + '/' + language, async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.addInitScript(value => localStorage.setItem('mandala-appearance-v1', JSON.stringify(value)), defaultPreferences(theme));
    await page.addInitScript(state => { for (const item of state.origins[0].localStorage) localStorage.setItem(item.name, item.value); }, storedUiState(language === 'en' ? 'en' : 'zh-CN'));
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(f.url);
    const trigger = page.getByRole('button', { name: language === 'en' ? 'Expand right sidebar' : '展开右侧栏', exact: true });
    await expect(trigger).toBeVisible();
    await page.keyboard.press('Control+Backquote');
    const pane = page.locator('#chat-environment-panel').getByRole('region', { name: language === 'en' ? 'Interactive terminal' : '交互终端', exact: true });
    await expect(pane.getByRole('textbox', { name: language === 'en' ? 'Terminal input' : '终端输入', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await pane.boundingBox(); expect(box!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Control+Backquote'); await expect(pane).not.toBeVisible();
    await expect(trigger).toBeFocused();
  } finally { const state = (await (await request.get(f.endpoint)).json()).session; if (state) await request.delete(f.endpoint, { data: { sessionId: state.id } }); rmSync(f.cwd, { recursive: true, force: true }); }
});

test('terminal shortcut works when the selected chat control first becomes visible', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const trigger = document.querySelector('button.content-panel-trigger:not([hidden])');
        if (!trigger?.getClientRects().length) return;
        observer.disconnect();
        dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      observer.observe(document, { childList: true, attributes: true, subtree: true });
    });
    await page.goto(f.url);
    const pane = page.locator('#chat-environment-panel').getByRole('region', { name: '交互终端', exact: true });
    await expect(pane.getByRole('textbox', { name: '终端输入', exact: true })).toBeEnabled();
    await page.keyboard.press('Control+Backquote');
    await expect(pane).not.toBeVisible();
    await expect(page.getByRole('button', { name: '展开右侧栏', exact: true })).toBeFocused();
  } finally { const state = (await (await request.get(f.endpoint)).json()).session; if (state) await request.delete(f.endpoint, { data: { sessionId: state.id } }); rmSync(f.cwd, { recursive: true, force: true }); }
});

test('a missing directory shows an actionable error and explicit retry starts after recovery', async ({ page, request }) => {
  const f = await fixture(request);
  rmSync(f.cwd, { recursive: true, force: true });
  try {
    await page.goto(f.url); await openTerminal(page);
    const pane = page.getByRole('region', { name: '交互终端', exact: true });
    await expect(pane.getByRole('alert')).toContainText('工作目录不存在或无法访问');
    await expect(pane.getByRole('textbox', { name: '终端输入', exact: true })).toBeDisabled();
    mkdirSync(f.cwd);
    await pane.getByRole('button', { name: '重试', exact: true }).click();
    await expect(pane.getByRole('textbox', { name: '终端输入', exact: true })).toBeEnabled();
    await expect(pane.getByRole('alert')).not.toBeVisible();
  } finally { const state = (await (await request.get(f.endpoint)).json()).session; if (state) await request.delete(f.endpoint, { data: { sessionId: state.id } }); rmSync(f.cwd, { recursive: true, force: true }); }
});

test('an oversized code reference preserves the draft and explains how to recover', async ({ page, request }) => {
  const f = await fixture(request);
  writeFileSync(join(f.cwd, 'large.ts'), '// ' + '界'.repeat(90_000));
  try {
    await page.goto(f.url);
    const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('Keep my draft');
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const panel = page.locator('#chat-environment-panel');
    await panel.getByRole('tab', { name: '文件', exact: true }).click();
    await panel.getByRole('button', { name: 'large.ts', exact: true }).click();
    await panel.locator('.workspace-code-preview code').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await panel.getByRole('button', { name: '引用选区', exact: true }).click();
    await expect(page.locator('.error-banner')).toContainText('引用内容太长，请缩小选区后再加入对话。');
    await expect(composer).toHaveValue('Keep my draft');
    expect((await (await request.get('/api/conversations/' + f.conversation.id)).json()).conversation.status).toBe('idle');
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

test('terminal readiness does not steal focus after the user resumes typing a draft', async ({ page, request }) => {
  const f = await fixture(request);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**' + f.endpoint, async route => { if (route.request().method() === 'GET') await held; await route.continue(); });
  try {
    await page.goto(f.url); await openTerminal(page);
    const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill('Typing while the shell connects');
    release();
    await expect(page.getByRole('textbox', { name: '终端输入', exact: true })).toBeEnabled();
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue('Typing while the shell connects');
  } finally { release(); const state = (await (await request.get(f.endpoint)).json()).session; if (state) await request.delete(f.endpoint, { data: { sessionId: state.id } }); rmSync(f.cwd, { recursive: true, force: true }); }
});

test('a second terminal runs beside the first and closing it ends only that shell', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.goto(f.url); await openTerminal(page);
    const panel = page.locator('#chat-environment-panel'), tabs = panel.getByRole('group', { name: '终端', exact: true });
    const input = panel.getByRole('textbox', { name: '终端输入', exact: true });
    await expect(input).toBeEnabled();
    await input.pressSequentially("printf 'FIRST_%s\\n' 1"); await page.keyboard.press('Enter');
    await expect.poll(async () => (await (await request.get(f.endpoint)).json()).session.output).toContain('FIRST_1');
    await tabs.getByRole('button', { name: '新建终端', exact: true }).click();
    await page.getByRole('menuitem', { name: '对话目录', exact: true }).click();
    const folder = f.cwd.split('/').pop()!;
    await expect(tabs.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toBeEnabled();
    await input.pressSequentially("printf 'SECOND_%s\\n' 2"); await page.keyboard.press('Enter');
    await expect.poll(async () => (await (await request.get(f.endpoint + '?slot=1')).json()).session?.output ?? '').toContain('SECOND_2');
    expect((await (await request.get(f.endpoint)).json()).session.output).not.toContain('SECOND_2');
    await page.reload(); await openTerminal(page);
    await expect(tabs.locator('button[aria-pressed]')).toHaveText(['对话目录', folder]);
    await tabs.getByRole('button', { name: '对话目录', exact: true }).click();
    await expect(panel.getByRole('region', { name: '交互终端', exact: true })).toContainText('FIRST_1');
    await tabs.getByRole('button', { name: /^关闭终端 / }).click();
    await expect(tabs.getByRole('button', { name: /^关闭终端 / })).toHaveCount(0);
    await expect.poll(async () => (await (await request.get(f.endpoint + '?slot=1')).json()).session?.state).toBe('exited');
    expect((await (await request.get(f.endpoint)).json()).session.state).toBe('running');
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});
