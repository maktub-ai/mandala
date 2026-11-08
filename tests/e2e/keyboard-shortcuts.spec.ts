import { expect, test } from '@playwright/test';

// These workflows start after an explicit CLI choice; first-use coverage keeps empty preferences.
test.beforeEach(async ({ page }) => {
 await page.addInitScript(() => localStorage.setItem('mana-chat-preferences', JSON.stringify({projectId:'',agentId:'',cli:'codex',model:'',effort:'',onboardingCompleted:true})));
});

for (const [platform, mod, label] of [['MacIntel', 'Meta', '⌘'], ['Win32', 'Control', 'Ctrl'], ['Linux x86_64', 'Control', 'Ctrl']]) {
 test(`${platform}: shortcuts are discoverable, preserve drafts and respect IME`, async ({ page, request }) => {
  await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { value }), platform);
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex' } })).json();
  const title = 'Keyboard ' + platform + ' ' + chat.id;
  await request.patch('/api/conversations/' + chat.id, { data: { title } });
  await page.goto('/?conversation=' + chat.id + '&project=&agent=');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('保留中文草稿');
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '命令面板', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button',{name:'打开命令面板',exact:true})).toContainText(label);
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '快捷键', exact: true });
  await expect(overview).toContainText(label);
  await expect(overview).toContainText('Shift');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:title,exact:true}).click();await expect(input).toBeEnabled();
  await page.keyboard.press(mod + '+Shift+L'); await expect(input).toBeFocused();
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
  await input.dispatchEvent('keydown', { key: 'n', code: 'KeyN', [mod === 'Meta' ? 'metaKey' : 'ctrlKey']: true });
  await expect(page).toHaveURL(new RegExp('conversation=' + chat.id));
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await expect(input).toHaveValue('保留中文草稿');
  await input.press('End');await input.press('Shift+Enter'); await expect(input).toHaveValue('保留中文草稿\n');
  await page.keyboard.press(mod + '+F'); await expect(page.getByRole('searchbox', { name: '对话内查找', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press(mod + '+N'); await expect(page).not.toHaveURL(new RegExp('conversation=' + chat.id));
  await page.getByRole('button', { name: title, exact: true }).click(); await expect(input).toHaveValue('保留中文草稿\n');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await input.press('Enter'); await expect(input).toHaveValue('');
  await expect(page.locator('.message.user')).toContainText('保留中文草稿');
 });
}

test('terminal keeps shell chords, application menus stay operable', async ({ page, request }) => {
 const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex' } })).json();
 await page.goto('/?conversation=' + chat.id + '&project=&agent=');
 await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
 await page.keyboard.press('Control+`');
 const terminal = page.locator('.xterm-helper-textarea'); await expect(terminal).toBeEnabled(); await terminal.focus();
 for (const chord of ['Control+n', 'Control+f', 'Control+Shift+p', 'Control+Shift+l']) await page.keyboard.press(chord);
 await expect(page).toHaveURL(new RegExp('conversation=' + chat.id));
 await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('searchbox', { name: '对话内查找', exact: true })).toHaveCount(0);
 await expect(terminal).toBeFocused();
 await page.keyboard.press('Control+`'); await expect(page.locator('#chat-environment-panel')).not.toBeVisible();
 await page.getByRole('button', { name: '用户菜单', exact: true }).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'打开命令面板',exact:true}).click();
 await expect(page.getByRole('dialog', { name: '命令面板', exact: true })).toBeVisible();
});

test('modal editing and IME cancellation do not invoke application shortcuts', async ({ page }) => {
 await page.goto('/?project=&agent=');
 await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
 const mod = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)) ? 'Meta' : 'Control';
 await page.keyboard.press(mod + '+Shift+P');
 const dialog = page.getByRole('dialog', { name: '命令面板', exact: true });
 await page.keyboard.press(mod + '+N'); await expect(dialog).toBeVisible();
 await page.keyboard.press('Escape');
 await page.getByRole('button', { name: '用户菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
 const overview = page.getByRole('dialog', { name: '快捷键', exact: true });
 await overview.dispatchEvent('compositionstart'); await overview.dispatchEvent('keydown', { key: 'Escape', code: 'Escape' });
 await expect(overview).toBeVisible(); await overview.dispatchEvent('compositionend');
 await overview.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229 }); await expect(overview).toBeVisible();
 await page.keyboard.press('Escape'); await expect(overview).toHaveCount(0);
});

test('narrow terminal can close with its shortcut and find keeps IME focus', async ({ page, request }) => {
 await page.setViewportSize({ width: 900, height: 850 });
 const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex' } })).json();
 await page.goto('/?conversation=' + chat.id + '&project=&agent=');
 const composer = page.getByRole('textbox', { name: '消息', exact: true }); await expect(composer).toBeVisible();
 await page.keyboard.press('Control+`');
 const terminal = page.locator('.xterm-helper-textarea'); await expect(terminal).toBeEnabled(); await terminal.focus(); await expect(terminal).toBeFocused();
 await page.keyboard.press('Control+`'); await expect(page.locator('#chat-environment-panel')).not.toBeVisible();
 const mod = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)) ? 'Meta' : 'Control';
 await composer.focus(); await page.keyboard.press(mod + '+F');
 const find = page.getByRole('searchbox', { name: '对话内查找', exact: true }); await expect(find).toBeFocused();
 await find.dispatchEvent('compositionstart'); await find.dispatchEvent('keydown', { key: 'Escape', code: 'Escape' }); await expect(find).toBeFocused();
 await find.dispatchEvent('compositionend'); await find.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229 }); await expect(find).toBeFocused();
 await find.press('Escape'); await expect(find).toHaveCount(0); await expect(composer).toBeFocused();
});
