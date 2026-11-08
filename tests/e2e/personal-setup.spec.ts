import { openAccountConnection } from './helpers/navigation';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccountStore } from '../../server/account-store';
import { openStore } from '../../server/store';
import { readConfig } from '../../server/config';
import { createSessionManager } from '../../server/sessions';
import { createHttpServer } from '../../server/http';

const password = 'synthetic-personal-password';

async function localWorkspace(browser: Browser, run: (page: Page, origin: string) => Promise<void>, theme = 'light', width = 1280, provisioned = true, setup = false) {
  const home = mkdtempSync(join(tmpdir(), 'mandala-first-use-'));
  const accounts = openAccountStore(home);
  if (provisioned) await accounts.createUser('personal', password);
  accounts.close();
  const store = openStore(home);
  const manager = createSessionManager(store, async () => (await readConfig(home)).config);
  const server = createHttpServer({ home, store, manager, requireIdentity: true, ...(setup ? { setupToken: 'synthetic-setup-token' } : {}) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN' });
  await context.addInitScript(value => { localStorage.setItem('mana-theme', value); localStorage.setItem('mana-language', 'zh-CN'); }, theme);
  if (setup) await context.addCookies([{ name: 'mandala_setup', value: 'synthetic-setup-token', domain: '127.0.0.1', path: '/auth', httpOnly: true, sameSite: 'Strict' }]);
  try { await run(await context.newPage(), origin); }
  finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await manager.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

for (const theme of ['light', 'dark']) test(`launcher-authorized first use creates a real local identity and retains it after sign-out in ${theme}`, async ({ browser }) => {
  await localWorkspace(browser, async (page, origin) => {
    await page.goto(origin);
    const create = page.getByRole('button', { name: '创建本地身份', exact: true });
    await expect(create).toBeVisible();
    const username = page.getByLabel('账号', { exact: true });
    const secret = page.getByLabel('密码', { exact: true });
    await expect(secret).toHaveAttribute('autocomplete', 'new-password');
    await username.fill('invalid account');
    await secret.fill(password);
    let requests = 0;
    page.on('request', request => { if (request.url().endsWith('/auth/setup')) requests++; });
    await create.click();
    expect(await username.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    expect(requests).toBe(0);
    await username.fill('personal');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`mandala-setup-${theme}.png`) });
    const created = page.waitForResponse(response => response.url().endsWith('/auth/setup') && response.request().method() === 'POST');
    await create.click();
    expect((await created).status()).toBe(201);
    const trigger = page.getByRole('button', { name: '用户菜单', exact: true });
    if (theme === 'dark') await page.getByRole('button', { name: /^(打开侧栏|会话列表)$/, exact: true }).click();
    await expect(trigger).toBeVisible();
    expect(await page.request.get(origin + '/auth/session').then(response => response.json())).toMatchObject({ user: { username: 'personal' }, setup: { available: false } });
    await page.reload();
    if (theme === 'dark') await page.getByRole('button', { name: /^(打开侧栏|会话列表)$/, exact: true }).click();
    await openAccountConnection(page);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建本地身份', exact: true })).toHaveCount(0);
    await username.fill('personal');
    await secret.fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    if (theme === 'dark') await page.getByRole('button', { name: /^(打开侧栏|会话列表)$/, exact: true }).click();
    await expect(trigger).toBeVisible();
  }, theme, theme === 'dark' ? 390 : 1280, false, true);
});

test('unprovisioned browser without a launcher capability can refresh but cannot submit setup', async ({ browser }) => {
  await localWorkspace(browser, async (page, origin) => {
    let submitted = false;
    page.on('request', request => { if (request.url().endsWith('/auth/setup')) submitted = true; });
    await page.goto(origin);
    await expect(page.getByRole('button', { name: '创建本地身份', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '账号', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '已创建，刷新', exact: true }).click();
    await expect(page.getByRole('heading', { name: '开始使用 Mandala', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '已创建，刷新', exact: true })).toBeEnabled();
    expect(submitted).toBe(false);
    await page.screenshot({ path: test.info().outputPath('mandala-setup-unavailable-dark.png') });
  }, 'dark', 390, false);
});

test('expired launcher authorization focuses an actionable error and refresh returns to the safe fallback', async ({ browser }) => {
  await localWorkspace(browser, async (page, origin) => {
    await page.goto(origin);
    await page.getByLabel('账号', { exact: true }).fill('personal');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.context().clearCookies();
    const rejected = page.waitForResponse(response => response.url().endsWith('/auth/setup'));
    await page.getByRole('button', { name: '创建本地身份', exact: true }).click();
    expect((await rejected).status()).toBe(403);
    await expect(page.getByRole('alert')).toContainText('退出并重新启动');
    await expect(page.getByRole('alert')).toBeFocused();
    await expect(page.getByLabel('账号', { exact: true })).toHaveValue('personal');
    await page.getByRole('button', { name: '刷新账号状态', exact: true }).click();
    await expect(page.getByRole('button', { name: '已创建，刷新', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建本地身份', exact: true })).toHaveCount(0);
  }, 'light', 1280, false, true);
});

test('real local sign-in recovers from a wrong password and account dialog restores keyboard focus', async ({ browser }) => {
  await localWorkspace(browser, async (page, origin) => {
    await page.goto(origin);
    await page.getByLabel('账号', { exact: true }).fill('personal');
    await page.getByLabel('密码', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('登录失败');
    await expect(page.getByRole('alert')).toBeFocused();
    await expect(page.getByLabel('账号', { exact: true })).toHaveValue('personal');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const trigger = page.getByRole('button', { name: '用户菜单', exact: true });
    await openAccountConnection(page);
    const dialog = page.getByRole('dialog', { name: '账号与连接', exact: true });
    await expect(dialog.getByRole('combobox', { name: '连接方式', exact: true })).toHaveText('官方连接服务（尚未开放）');
    await expect(dialog.getByRole('textbox', { name: '账号服务地址', exact: true })).toBeHidden();
    await expect(dialog.getByText('官方连接服务尚未开放。',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'官方连接服务尚未开放',exact:true})).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('mandala-account-local-light.png') });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '退出登录', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openAccountConnection(page);
    await dialog.locator('summary').filter({ hasText: '高级：自部署连接服务' }).click();
    await expect(dialog.getByLabel('账号服务地址', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('服务账号', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('服务密码', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
    await expect(dialog.getByRole('link', { name: /官方/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('mandala-account-self-hosted-light.png') });
  });
});

test('self-hosted connection fields remain reachable in the dark narrow account dialog', async ({ browser }) => {
  await localWorkspace(browser, async (page, origin) => {
    await page.goto(origin);
    await page.getByLabel('账号', { exact: true }).fill('personal');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: /^(打开侧栏|会话列表)$/, exact: true }).click();
    await openAccountConnection(page);
    const dialog = page.getByRole('dialog', { name: '账号与连接', exact: true });
    await dialog.locator('summary').filter({ hasText: '高级：自部署连接服务' }).click();
    await dialog.getByLabel('账号服务地址', { exact: true }).fill('https://connect.example.test');
    await dialog.getByLabel('电脑名称', { exact: true }).fill('Personal computer');
    await dialog.getByLabel('服务账号', { exact: true }).fill('personal');
    await dialog.getByLabel('服务密码', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '连接账号服务', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '连接账号服务', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('mandala-account-self-hosted-dark-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('main .mobile-menu')).toBeVisible();
    await expect(page.locator('main .mobile-menu')).toBeFocused();
  }, 'dark', 390);
});

for (const theme of ['light', 'dark']) {
  test(`real login preserves saved ${theme} theme before App mounts on a narrow screen`, async ({ browser }) => {
    await localWorkspace(browser, async (page, origin) => {
      await page.goto(origin);
      await expect(page.getByRole('heading', { name: '登录 Mandala', exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`mandala-login-${theme}.png`) });
    }, theme, 390);
  });
}

for(const theme of ['light','dark'])test('compact identity setup, sign-in and account panel retain saved '+theme+' at every width',async({browser})=>{
 await localWorkspace(browser,async(page,origin)=>{for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:950});await page.goto(origin);await expect(page.getByRole('button',{name:'创建本地身份',exact:true})).toBeVisible();await page.screenshot({path:`/tmp/own-identity-setup-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}},theme,1440,false,true);
 await localWorkspace(browser,async(page,origin)=>{
  for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:950});await page.goto(origin);await expect(page.getByRole('heading',{name:'登录 Mandala',exact:true})).toBeVisible();await page.screenshot({path:`/tmp/own-sign-in-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.getByLabel('账号',{exact:true}).fill('personal');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await openAccountConnection(page);await expect(page.locator('[data-slot=dialog-content]')).toHaveCSS('opacity','1');await expect(page.locator('[data-slot=dialog-overlay]')).toHaveCSS('opacity','1');
  for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:950});await expect(page.getByRole('dialog',{name:'账号与连接',exact:true})).toBeVisible();await page.screenshot({path:`/tmp/own-account-panel-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 },theme,1440,true,false);
});
