import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';

test.beforeEach(async ({ page, request, executionDirectory }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  const { revision } = await (await request.get('/api/config')).json();
  const member = (id: string) => ({ id, name: id === 'writer' ? 'Writer' : 'Reviewer', instructions: 'Synthetic role. '.repeat(100), defaultCli: 'codex', models: {}, mcp: [], skills: [] });
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, runtimes: ['codex'],
    projects: [{ id: 'feedback', name: 'Feedback project', cwd: executionDirectory, agentIds: ['writer', 'reviewer'], resources: [], mcp: [], skills: [] },
      { id: 'other', name: 'Other project', cwd: executionDirectory, agentIds: ['reviewer'], resources: [], mcp: [], skills: [] }], agents: [member('writer'), member('reviewer')] } } })).ok()).toBe(true);
  // Agent IDs are reused by synthetic specs; each scenario starts without another scenario's remembered policy.
  for (const agentId of ['writer', 'reviewer']) expect((await request.patch('/api/chat-preferences/approval', { data: { agentId, cli: 'codex', approvalMode: null } })).ok()).toBe(true);
});

test('default composer is compact, grows to a limit and keeps running actions inline', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(input).toBeVisible();
  const initial = await page.locator('.composer').boundingBox();
  expect(initial!.height).toBeLessThan(150);
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await input.fill(Array.from({ length: 35 }, (_, n) => `Line ${n}`).join('\n'));
  const large = await input.boundingBox();
  expect(large!.height).toBeGreaterThan(50);
  expect(large!.height).toBeLessThanOrEqual(245);
  expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await input.fill('hold');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Running');
  await input.fill('queued followup');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const stop = page.getByRole('button', { name: 'Stop execution', exact: true });
    const send = page.getByRole('button', { name: 'Queue message', exact: true });
    await expect(stop).toBeVisible(); await expect(send).toBeVisible();
    const a = await stop.boundingBox(), b = await send.boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Send options', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Interrupt and send', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop execution', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Interrupted');
  await expect(input).toHaveValue('queued followup');
});

test('approval preference read failure blocks sending until the actual preference is loaded', async ({ page, request }) => {
  expect((await request.patch('/api/chat-preferences/approval', { data: { agentId: 'writer', cli: 'codex', approvalMode: 'auto' } })).ok()).toBe(true);
  let fail = true;
  await page.route('**/api/chat-preferences/approval?**', route => fail ? route.fulfill({ status: 503, json: { error: 'Preference temporarily unavailable' } }) : route.continue());
  await page.goto('/?project=feedback&agent=writer');
  await expect(page.getByRole('alert')).toContainText('Preference temporarily unavailable');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('must use visible policy');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: 'Retry approval preference', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', 'auto');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('returning from Agent preference reset refreshes the same prepared draft', async ({ page, request }) => {
  await page.goto('/?project=feedback&agent=writer');
  await chooseOption(page, 'Approval mode', 'auto');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('preserved preparation');
  await page.evaluate(() => { history.pushState(null, '', '/agents?agent=writer&tab=execution'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('combobox', { name: 'Default approval mode', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use Agent default', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/chat-preferences/approval?agentId=writer&cli=codex')).json()).approvalMode).toBeNull();
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', '');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('preserved preparation');
});

test('Project changes restore its last used Agent while preserving draft and compact descriptions', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('remember writer'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await input.fill('keep this draft');
  await chooseOption(page, 'Current project', 'other'); await chooseOption(page, 'Current agent', 'reviewer');
  await chooseOption(page, 'Current project', 'feedback');
  await expect(page.getByRole('combobox', { name: 'Current agent', exact: true })).toHaveAttribute('data-value', 'writer');
  await expect(input).toHaveValue('keep this draft');
  await page.getByRole('combobox', { name: 'Current agent', exact: true }).click();
  const description = page.getByRole('listbox').locator('[data-value="writer"] small');
  expect((await description.boundingBox())!.height).toBeLessThan(40);
  await page.screenshot({ path: 'audit/2026-10-20-rework/chat-agent-picker.png' });
});

test('selected AI text becomes a previewable attachment while retaining the draft', async ({ page, request }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('quoted sentence');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.agent-reply .markdown-text')).toContainText('Fixture reply: quoted sentence');
  await input.fill('existing draft');
  await page.locator('.agent-reply .markdown-text').evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf('quoted sentence');
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'quoted sentence'.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange')); break;
    }
  });
  await expect(page.getByRole('button', { name: 'Quote selection', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Quote selection', exact: true }).click();
  await expect(input).toHaveValue('existing draft');
  const preview = page.getByRole('button', { name: 'Preview text Quoted text.txt', exact: true });
  await expect(preview).toBeVisible();
  await preview.click();
  await expect(page.getByRole('dialog', { name: 'Text preview', exact: true }).locator('pre')).toHaveText('quoted sentence');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'audit/2026-10-22-chat-cards-board/quote-attachment.png' });
  const upload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/attachments?'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const uploaded = await (await upload).json();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  const attachment = page.locator('.message.user .message-attachments').last();
  await expect(attachment).toContainText('Quoted text.txt');
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  expect(await (await request.get(`/api/conversations/${conversationId}/attachments/${uploaded.id}?download=1`)).text()).toBe('quoted sentence');
});

test('find searches the current conversation, navigates matches and retains drafts', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('搜索 needle in conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.agent-reply .markdown-text')).toContainText('needle');
  await input.fill('draft survives find');
  const findShortcut=await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+f':'Control+f';
  await page.keyboard.press(findShortcut);
  const find = page.getByRole('searchbox', { name: 'Find in conversation', exact: true });
  await expect(find).toBeFocused(); await find.fill('needle');
  await expect(page.getByTestId('conversation-find-count')).toHaveText('1 / 2');
  await page.screenshot({ path: 'audit/2026-10-20-rework/chat-find.png' });
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(page.getByTestId('conversation-find-count')).toHaveText('2 / 2');
  await find.fill('does not exist');
  await expect(page.getByTestId('conversation-find-count')).toHaveText('0 / 0');
  await page.keyboard.press(findShortcut);
  await page.keyboard.press('Escape'); await expect(find).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('draft survives find');
});

test('approval selection survives new chats, reload and Agent changes', async ({ page, request }) => {
  await page.goto('/?project=feedback&agent=writer');
  await chooseOption(page, 'Approval mode', 'auto');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('remember approval');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  await page.goto('/?project=feedback&agent=writer');
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', 'auto');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', 'auto');
  await chooseOption(page, 'Current agent', 'reviewer');
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', '');
  await chooseOption(page, 'Current agent', 'writer');
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveAttribute('data-value', 'auto');
  await chooseOption(page, 'Approval mode', '');
  expect((await (await request.get('/api/chat-preferences/approval?agentId=writer&cli=codex')).json()).approvalMode).toBeNull();
});

test('approval retry remains available after changing Project with the same Agent', async ({ page }) => {
  let fail = true;
  await page.route('**/api/chat-preferences/approval?**', route => fail ? route.fulfill({ status: 503, json: { error: 'Preference temporarily unavailable' } }) : route.continue());
  await page.goto('/?project=feedback&agent=reviewer');
  await expect(page.getByRole('alert')).toContainText('Preference temporarily unavailable');
  await chooseOption(page, 'Current project', 'other');
  await expect(page.getByRole('alert')).toContainText('Preference temporarily unavailable');
  fail = false;
  await page.getByRole('button', { name: 'Retry approval preference', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('recovered draft');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('find preserves Unicode offsets and includes delivered file links', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('İ foo\n\nDelivered `outputs/searchable-report.md`');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('searchbox', { name: 'Find in conversation', exact: true });
  await find.fill('foo');
  await expect(page.getByTestId('conversation-find-count')).toHaveText('1 / 2');
  const highlighted = () => page.evaluate(() => [...(CSS as any).highlights.get('conversation-matches')].map((range: Range) => range.toString()));
  expect(await highlighted()).toEqual(['foo', 'foo']);
  await find.fill('searchable-report.md');
  await expect(page.getByTestId('conversation-find-count')).toHaveText('1 / 2');
  expect(await highlighted()).toEqual(['searchable-report.md', 'searchable-report.md']);
});

test('many attachments and references stay bounded with reachable controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/composer-references?**', route => route.fulfill({ json: { items: Array.from({ length: 8 }, (_, n) => ({ id: `skill:${n}`, kind: 'skill', name: `Synthetic long reference ${n}`, source: 'Project', detail: 'Synthetic', status: 'available' })) } }));
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  for (let n = 0; n < 8; n++) {
    await input.fill('/');
    await page.getByRole('option', { name: `Synthetic long reference ${n} · Skill · Available`, exact: true }).click();
  }
  const longName = 'synthetic-attachment-with-a-long-name-';
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 8 }, (_, n) => ({ name: `${longName}${n}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=', 'base64') })));
  for (const selector of ['.composer-attachments', '.composer-references']) {
    const region = page.locator(selector);
    expect((await region.boundingBox())!.height).toBeLessThanOrEqual(110);
    expect(await region.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  }
  await page.getByRole('button', { name: `Remove attachment ${longName}7.png`, exact: true }).click();
  await page.getByRole('button', { name: 'Remove reference Synthetic long reference 7', exact: true }).click();
  expect((await page.locator('.composer').boundingBox())!.height).toBeLessThan(330);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'audit/2026-10-20-rework/composer-bounded-context-390.png' });
});

test.describe('composer visual acceptance with touch targets', () => {
  test.use({ hasTouch: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) test(`${theme} at ${width}px`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('mana-theme', theme), theme);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/?project=feedback&agent=writer');
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(input).toBeVisible();
    await expect.poll(() => page.locator('.composer-toolbar').innerText()).toContain('Fixture');
    await page.screenshot({ path: `audit/2026-10-20-rework/new-chat-${theme}-${width}.png` });
    await input.fill('hold');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('chat-status')).toHaveText('Running');
    await input.fill('A follow-up can wait for this execution.');
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic content') });
    for (const name of ['Stop execution', 'Queue message', 'Send options']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const prefix = `audit/2026-10-20-rework/composer-${theme}-${width}`;
    await page.screenshot({ path: `${prefix}.png` });
    await page.getByRole('button', { name: 'Send options', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Interrupt and send', exact: true })).toBeInViewport();
    await page.screenshot({ path: `${prefix}-menu.png` });
    await page.keyboard.press('Escape');
    if (width === 390) {
      await page.getByRole('button', { name: 'Composer settings', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Composer settings', exact: true })).toBeInViewport();
      await page.screenshot({ path: `${prefix}-settings.png` });
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Stop execution', exact: true }).click();
    await expect(page.getByTestId('chat-status')).toHaveText('Interrupted');
  });
});

test('find stays at the page upper right above the conversation without moving messages', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill(Array.from({ length: 80 }, (_, i) => `Synthetic search row ${i}`).join('\n'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  const messageTop = await page.locator('.messages').evaluate(el => el.getBoundingClientRect().top);
  await page.keyboard.press('Meta+f');
  const bar = page.getByRole('search', { name: 'Find in conversation', exact: true });
  await expect(bar).toBeVisible();
  expect(await page.locator('.messages').evaluate(el => el.getBoundingClientRect().top)).toBe(messageTop);
  const viewport = page.locator('.conversation');
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await bar.getByRole('searchbox').fill('row');
    await viewport.evaluate(el => el.scrollTop = el.scrollHeight);
    const before = await bar.boundingBox(), container = await page.locator('main.workspace-main').boundingBox();
    expect(Math.abs(before!.y - container!.y - 12)).toBeLessThan(2);
    expect(Math.abs(before!.x + before!.width - container!.x - container!.width + 16)).toBeLessThan(2);
    await viewport.evaluate(el => el.scrollTop = 0);
    expect((await bar.boundingBox())!.y).toBe(before!.y);
    await page.getByRole('button', { name: 'Next match', exact: true }).click();
    expect((await bar.boundingBox())!.y).toBe(before!.y);
    expect(before!.y + before!.height).toBeLessThan((await page.locator('.chat-title-bar').boundingBox())!.y + 3);
    await page.screenshot({ path: `audit/2026-10-22-chat-cards-board/find-page-top-${width}.png` });
  }
});

test('large pasted text stays in an attachment and is sent intact after a lost receipt', async ({ page, request }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const pasted = Array.from({ length: 45 }, (_, n) => `  Synthetic pasted line ${n} \t 中文 <script>sample</script>`).join('\r\n') + '\n';
  await input.fill('Explain this text');
  await input.evaluate((el, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(input).toHaveValue('Explain this text');
  await page.getByRole('button', { name: 'Preview text Pasted text.txt', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Text preview', exact: true }).locator('pre')).toHaveText(pasted);
  await page.keyboard.press('Escape');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `audit/2026-10-22-chat-cards-board/pasted-${width}.png` });
  }
  let failed = false, readbacksAvailable = false, uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/attachments?')) uploads++; });
  await page.route('**/api/conversations/*/queue', async route => {
    if (route.request().method() === 'POST' && !failed) { await route.fetch(); failed = true; return route.fulfill({ status: 503, json: { error: 'Synthetic lost receipt' } }); }
    if (route.request().method() === 'GET' && failed && !readbacksAvailable) return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable readback' } });
    return route.continue();
  });
  const upload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/attachments?'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const uploaded = await (await upload).json();
  await expect(page.locator('.composer-recovery-notice')).toBeVisible();
  await expect(input).toHaveValue('Explain this text');
  await expect(page.locator('.composer-attachments')).toContainText('Pasted text.txt');
  readbacksAvailable = true;
  await page.getByRole('button', { name: 'Check previous send', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  const attachment = page.locator('.message.user .message-attachments').last();
  await expect(attachment).toContainText('Pasted text.txt');
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  expect(await (await request.get(`/api/conversations/${conversationId}/attachments/${uploaded.id}?download=1`)).body()).toEqual(Buffer.from(pasted));
  expect(uploads).toBe(1);
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
});

test('text attachments retain drafts across chats and can be removed without changing the question', async ({ page }) => {
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Create a chat for draft isolation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  await input.fill('Keep my question');
  await input.evaluate(el => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'Synthetic paste\n'.repeat(30));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
  await input.fill('Separate new chat draft');
  await page.goBack();
  await expect(input).toHaveValue('Keep my question');
  await expect(page.locator('.composer-attachments')).toContainText('Pasted text.txt');
  await page.getByRole('button', { name: 'Remove attachment Pasted text.txt', exact: true }).click();
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
  await expect(input).toHaveValue('Keep my question');
  await expect(input).toBeFocused();
});

for (const theme of ['light', 'dark']) for (const width of [1280, 390]) test(`text attachment cards ${theme} at ${width}px`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('mana-theme', theme), theme);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/?project=feedback&agent=writer');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Synthetic text for quoting. '.repeat(100));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('Ready');
  await page.locator('.agent-reply .markdown-text').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: 'Quote selection', exact: true }).click();
  await input.fill('Compare these excerpts');
  await input.evaluate(el => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'Synthetic pasted text 中文 <script>not executable</script>\n'.repeat(1500));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.composer-attachments .attachment-chip')).toHaveCount(2);
  expect((await page.locator('.composer').boundingBox())!.height).toBeLessThan(230);
  await page.screenshot({ path: `audit/2026-10-22-chat-cards-board/cards-${theme}-${width}.png` });
  await page.getByRole('button', { name: 'Preview text Pasted text.txt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Text preview', exact: true });
  await expect(dialog).toContainText('Preview shortened. The full text will be attached when you send.');
  await expect(dialog.locator('script')).toHaveCount(0);
  expect(await dialog.locator('pre').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: `audit/2026-10-22-chat-cards-board/text-preview-${theme}-${width}.png` });
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('Compare these excerpts');
});

test('opening a Project restores a valid remembered Agent without silently choosing its first member', async ({ page }) => {
  await page.goto('/?project=feedback');
  await expect(page.getByRole('combobox', { name: 'Current agent', exact: true })).toHaveAttribute('data-value', '');
  await page.evaluate(() => localStorage.setItem('mana-project-agents', JSON.stringify({ feedback: 'reviewer' })));
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Current agent', exact: true })).toHaveAttribute('data-value', 'reviewer');
  await page.goto('/?project=other&agent=writer');
  await expect(page.getByRole('combobox', { name: 'Current agent', exact: true })).toHaveAttribute('data-value', '');
});
