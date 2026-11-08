import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const folders = await readdir('release/desktop');
const folder = process.platform === 'win32' ? 'win-unpacked' : folders.find(name => /^mac(?:-|$)/.test(name));
const appPath = resolve(process.argv[2] ?? (process.platform === 'win32' ? join('release/desktop', folder) : join('release/desktop', folder, 'Mandala.app')));
const executablePath = process.platform === 'win32' ? join(appPath, 'Mandala.exe') : join(appPath, 'Contents/MacOS/Mandala');
const home = join(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mandala-window-smoke-')), 'data');
const artifactDirectory = process.env.MANDALA_SMOKE_OUTPUT ?? join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mandala-window-smoke-' + Date.now());
let application = await electron.launch({ executablePath, env: { ...process.env, MANDALA_HOME: home, OPEN_MANA_HOME: home }, timeout: 30000 });
let frontendProcess = application.process();
try {
  const page = await application.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const origin = new URL(page.url()).origin;
  const auth = await page.evaluate(() => fetch('/auth/session').then(r => r.json()));
  assert.equal(auth.setup.available, true);
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getLastWebPreferences()));
  assert.equal(windows[0].sandbox, true); assert.equal(windows[0].contextIsolation, true); assert.equal(windows[0].nodeIntegration, false);
  const created = await page.evaluate(token => fetch('/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token }, body: JSON.stringify({ username: 'windowtest', password: 'synthetic-window-password' }) }).then(async r => ({ status: r.status, data: await r.json() })), auth.setup.token);
  assert.equal(created.status, 201);
  await page.reload(); await page.waitForLoadState('domcontentloaded');
  // Native directories remain folder cards; only their path information is sent.
  const selectedDirectory = join(home, 'selected workspace'); await mkdir(selectedDirectory);
  await page.goto(origin + '/mandala');
  const composer = page.getByRole('textbox', { name: /^(Message|消息)$/ }); await expect(composer).toBeEnabled();
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [selectedDirectory] });
  const folder = page.locator('.composer-attachments [data-source=directory]');
  await expect(composer).toHaveValue(''); await expect(folder).toHaveAttribute('title', selectedDirectory);
  await folder.locator('.attachment-remove').click(); await expect(folder).toHaveCount(0); await cdp.detach();
  const product = process.env.MANDALA_DESKTOP_PRODUCT_CHECK === '1' ? await (await import('./desktop-product-smoke.mjs')).verifyDesktopProduct(page, origin, home, { artifactDirectory }) : null;
  // Observe the validated native request without opening a remote page or browser.
  await application.evaluate(({ shell }) => { globalThis.externalUrls = []; shell.openExternal = async url => { globalThis.externalUrls.push(url); }; });
  await page.evaluate(() => { const link = document.createElement('a'); link.href = 'https://connect.example.com/'; link.target = '_blank'; link.textContent = 'Synthetic phone connection'; link.id = 'desktop-external-test'; document.body.append(link); });
  await page.locator('#desktop-external-test').click();
  await expect.poll(() => application.evaluate(() => globalThis.externalUrls)).toEqual(['https://connect.example.com/']);
  await page.evaluate(() => { document.querySelector('#desktop-external-test').click(); window.open('https://unrequested.example/'); });
  assert.equal((await application.evaluate(() => globalThis.externalUrls)).length, 1);
  assert.equal(application.windows().length, 1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await fetch(origin + '/auth/session')).status, 200);
  const second = spawn(executablePath, [], { env: { ...process.env, MANDALA_HOME: home, OPEN_MANA_HOME: home }, stdio: 'ignore' });
  const [secondExit] = await once(second, 'exit'); assert.equal(secondExit, 0);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  assert.equal((await (await import('node:fs/promises')).readdir(join(home, '.store-leases'))).length, 1);

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await mkdir(artifactDirectory, { recursive: true });
  const previousAppearance=await page.evaluate(()=>window.mandalaDesktop.appearance.read());
  await page.evaluate(value=>window.mandalaDesktop.appearance.write(JSON.stringify({...JSON.parse(value),mode:'system'})),previousAppearance);
  await application.evaluate(({ app, BrowserWindow, nativeImage, nativeTheme }) => {
    const target = process.platform === 'darwin' ? app.dock : BrowserWindow.getAllWindows()[0];
    const setIcon = target.setIcon.bind(target);
    globalThis.iconChanges = [];
    globalThis.restoreIconTest = () => { target.setIcon = setIcon; nativeTheme.themeSource = 'system'; };
    target.setIcon = icon => {
      setIcon(icon);
      const image = nativeImage.createFromPath(icon), bitmap=image.toBitmap(), size=image.getSize(), offset = (512 * 1024 + 128) * 4;
      let left=size.width,top=size.height,right=-1,bottom=-1;
      for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(bitmap[(y*size.width+x)*4+3]>240){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      globalThis.iconChanges.push({ path: icon, size, bounds:{left,top,right,bottom,width:right-left+1,height:bottom-top+1}, background: [...bitmap.subarray(offset, offset + 4)] });
    };
    nativeTheme.themeSource = 'dark';
  });
  for (const theme of ['light', 'dark']) {
    await application.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await expect.poll(() => application.evaluate(() => globalThis.iconChanges.at(-1)?.path)).toMatch(new RegExp(`icon-${theme}\\.png$`));
    const icon = await application.evaluate(() => globalThis.iconChanges.at(-1));
    assert.deepEqual(icon.size, { width: 1024, height: 1024 });
    assert.ok(icon.bounds.width>=808&&icon.bounds.width<=840,'Icon tile must occupy about 80% of its canvas, not 92%');
    assert.ok(icon.bounds.height>=808&&icon.bounds.height<=840);
    assert.ok(Math.abs(icon.bounds.left-(1023-icon.bounds.right))<=1&&Math.abs(icon.bounds.top-(1023-icon.bounds.bottom))<=1,'Icon tile must be centered');
    assert.deepEqual(icon.background, theme === 'light' ? [255, 255, 255, 255] : [28, 25, 25, 255]);
  }
  await writeFile(join(artifactDirectory, 'desktop-icon.json'), JSON.stringify(await application.evaluate(() => globalThis.iconChanges), null, 2));
  await application.evaluate(() => globalThis.restoreIconTest());
  await page.evaluate(value=>window.mandalaDesktop.appearance.write(value),previousAppearance);
  await page.screenshot({ path: join(artifactDirectory, 'desktop-window.png') });
  // A real runtime-owned job must still be working when the frontend exits.
  const proofDirectory = join(home, 'background-proof'); await mkdir(proofDirectory);
  const liveCli = process.env.MANDALA_DESKTOP_LIVE_CLI;
  assert.ok(!liveCli || ['claude', 'gemini', 'opencode'].includes(liveCli));
  const chat = await page.evaluate(async ({ cwd, cli }) => {
    if (cli) {
      const current = await (await fetch('/api/config')).json();
      current.config.runtimes = [...new Set([...(current.config.runtimes ?? ['codex','omp']), cli])];
      const saved = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: current.config, revision: current.revision }) });
      if (!saved.ok) throw new Error('Unable to enable smoke CLI');
    }
    const response = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: '', agentId: '', cwd, workspaceId: null, cli: cli ?? 'codex', approvalMode: 'auto' }) });
    if (!response.ok) throw new Error('Unable to create background test chat');
    return response.json();
  }, { cwd: proofDirectory, cli: liveCli });
  await page.reload(); await page.waitForLoadState('domcontentloaded');
  const command = process.platform === 'win32'
    ? 'echo started> started.txt & ping -n 21 127.0.0.1 >nul & echo MANDALA_AFTER_QUIT> completed.txt'
    : "printf started > started.txt; sleep 20; printf MANDALA_AFTER_QUIT > completed.txt";
  await page.evaluate(async ({ id, command, liveCli }) => {
    const base = '/api/conversations/' + id;
    if (liveCli) {
      const response = await fetch(base + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'This is an authorized temporary runtime lifecycle check. Execute exactly this harmless shell command in the current working directory: ' + command + '. Then reply MANDALA_AFTER_QUIT. Do not read other files or delegate.' }) });
      if (!response.ok) throw new Error('Unable to submit real background CLI task: ' + response.status);
    } else {
      const terminal = await (await fetch(base + '/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }) })).json();
      const response = await fetch(base + '/terminal/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: terminal.session.id, data: command + '\r' }) });
      if (!response.ok) throw new Error('Unable to submit background terminal job');
    }
  }, { id: chat.id, command, liveCli });
  await expect.poll(() => readFile(join(proofDirectory, 'started.txt'), 'utf8').catch(() => ''), { timeout: 90000 }).toContain('started');
  assert.equal(await readFile(join(proofDirectory, 'completed.txt'), 'utf8').catch(() => ''), '');
  await expect(page.locator('.composer')).toBeVisible();
  const rendererUrlBeforeCrash = page.url();
  const submittedBeforeCrash = await page.evaluate(async id => (await (await fetch('/api/conversations/' + id + '/history')).json()).filter(event => event.kind === 'user').length, chat.id);
  // Exercise an actual renderer exit in this isolated HOME; select the explicit
  // recovery action without stopping the runtime or submitting another message.
  await application.evaluate(({ dialog, BrowserWindow }) => {
    const original = dialog.showMessageBox;
    globalThis.rendererRecoveryPrompts = [];
    globalThis.restoreRendererRecoveryDialog = () => { dialog.showMessageBox = original; };
    dialog.showMessageBox = async (_window, options) => { globalThis.rendererRecoveryPrompts.push(options.title); return { response: 1 }; };
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
  });
  await expect.poll(() => application.evaluate(() => globalThis.rendererRecoveryPrompts), { timeout: 10000 }).toEqual(['Mandala display stopped']);
  // Playwright permanently marks this Page as crashed even after Electron reloads
  // its webContents. Verify the recovered renderer through Electron until reopen
  // supplies a fresh Playwright Page; do not navigate or resend to repair the test.
  await expect.poll(() => application.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (contents.isCrashed() || contents.isLoading()) return false;
    return contents.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('.composer')").catch(() => false);
  }), { timeout: 15000 }).toBe(true);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()), rendererUrlBeforeCrash);
  assert.equal((await fetch(origin + '/auth/session')).status, 200);
  assert.equal(await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    `fetch('/api/conversations/' + ${JSON.stringify(id)} + '/history').then(r => r.json()).then(events => events.filter(event => event.kind === 'user').length)`
  ), chat.id), submittedBeforeCrash);
  assert.equal(await readFile(join(proofDirectory, 'completed.txt'), 'utf8').catch(() => ''), '');
  await application.evaluate(() => globalThis.restoreRendererRecoveryDialog());
  const recoveredImage = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(artifactDirectory, 'renderer-recovered.png'), Buffer.from(recoveredImage, 'base64'));
  // Normal quit must leave the runtime alive, and reopening must reuse its origin.
  const frontend = frontendProcess;
  console.log(JSON.stringify({ phase: 'normal quit', frontendPid: frontend.pid, home }));
  await application.evaluate(({ dialog, app }) => { dialog.showMessageBox = async () => ({ response: 1 }); setTimeout(() => app.quit(), 100); });
  await expect.poll(() => frontend.exitCode ?? frontend.signalCode, { timeout: 15000 }).not.toBeNull();
  console.log(JSON.stringify({ phase: 'frontend exited', home }));
  assert.equal((await fetch(origin + '/auth/session')).status, 200);
  await expect.poll(() => readFile(join(proofDirectory, 'completed.txt'), 'utf8').catch(() => ''), { timeout: 60000 }).toContain('MANDALA_AFTER_QUIT');
  console.log(JSON.stringify({ phase: 'background job completed', home }));
  application = await electron.launch({ executablePath, env: { ...process.env, MANDALA_HOME: home, OPEN_MANA_HOME: home }, timeout: 30000 });
  frontendProcess = application.process();
  frontendProcess.stderr?.on('data', data => process.stderr.write(data));
  const reopened = await application.firstWindow(); await reopened.waitForLoadState('domcontentloaded');
  assert.equal(new URL(reopened.url()).origin, origin);
  if (liveCli) {
    await expect.poll(() => reopened.evaluate(async id => (await (await fetch('/api/conversations/' + id)).json()).conversation.status, chat.id), { timeout: 60000 }).toBe('idle');
    const saved = await reopened.evaluate(async id => (await (await fetch('/api/conversations/' + id + '/history')).json()), chat.id);
    assert.ok(saved.filter(event => event.kind === 'text').map(event => event.data.text).join('').includes('MANDALA_AFTER_QUIT'));
  }
  assert.equal((await readdir(join(home, '.store-leases'))).length, 1);
  const reopenedFrontend = frontendProcess;
  await application.evaluate(({ dialog, Menu }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    dialog.showErrorBox = (title, message) => console.error(title + ': ' + message);
    Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Stop runtime and quit…').click();
  });
  await expect.poll(() => reopenedFrontend.exitCode ?? reopenedFrontend.signalCode, { timeout: 40000 }).not.toBeNull();
  assert.equal(await fetch(origin + '/auth/session').catch(() => null), null);
  const evidence = { appPath, home, artifactDirectory, product, directorySelectionRetainedCard: true, firstOwnerCreated: true, sandbox: true, requireUnavailable: true, trustedClickExternalOpen: true, programmaticPopupsBlocked: true, windowCloseKeptService: true, secondLaunchReopenedSameWindow: true, rendererCrashRecoveredWithoutResend: true, rendererCrashKeptRuntime: true, normalQuitKeptRuntime: true, reopenReusedRuntime: true, explicitStopStoppedRuntime: true, remoteBrowserOpened: false, modelInvoked: Boolean(liveCli), liveCli: liveCli ?? null, backgroundTaskCompletedAfterQuit: true };
  await writeFile(join(artifactDirectory, 'desktop-window.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(error);
  const record = await readFile(join(home, '.desktop-runtime.json'), 'utf8').then(JSON.parse).catch(() => null);
  console.error(JSON.stringify({ phase: 'failure state', runtimeRecordExists: Boolean(record), runtimeHttpStatus: record ? await fetch(record.origin + '/auth/session', { signal: AbortSignal.timeout(2000) }).then(response => response.status).catch(() => null) : null }));
  throw error;
} finally {
  if (frontendProcess.exitCode === null && frontendProcess.signalCode === null) {
    await application.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      Menu.getApplicationMenu()?.items[0].submenu.items.find(item => item.label === 'Stop runtime and quit…')?.click();
    }).catch(() => {});
    await application.close().catch(() => {});
  }
}
