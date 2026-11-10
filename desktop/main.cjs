const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, nativeTheme, dialog, shell, session, ipcMain, screen } = require('electron');
const { join, isAbsolute } = require('node:path');
const { statSync, readFileSync, writeFileSync } = require('node:fs');
const { resolveDesktopHome, desktopEnvironment, loginShellPath, prepareDesktopHome, connectOrStartService, stopBackgroundService, readRuntimeBuild, RuntimeShutdownTimeout, allowedNavigation, readDesktopAppearance, writeDesktopAppearance, readDesktopPreferences, writeDesktopPreference, desktopCliStatus, installDesktopCli } = require('./runtime.cjs');
const { createUpdateController } = require('./updates.cjs');
let window, petWindow, petPosition, tray, service, confirming = false, stopping = false, finished = false, discardUnsaved = false;
let homeError;
const home = resolveDesktopHome();
// Chromium cookies/preferences are separate from platform data and survive installer replacement.
try { prepareDesktopHome(home); app.setPath('userData', join(home, 'desktop-browser')); } catch (error) { homeError = error; }
app.setName('Mandala');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => tray?.destroy());
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    if (confirming || stopping) return;
    setImmediate(quit);
  });
  app.whenReady().then(start).catch(async error => {
    if (finished) return;
    const report = !stopping; stopping = true;
    if (report) dialog.showErrorBox('Mandala could not start', error.message);
    finished = true; app.quit();
  });
}
function quit() {
  if (stopping) return;
  finished = true; app.quit();
}
async function stopRuntime() {
  if (confirming || stopping || !service) return;
  confirming = true;
  const answer = await dialog.showMessageBox({ type: 'question', title: 'Stop runtime and quit?', message: 'This stops local tasks, terminals and this computer’s connection. Quit Mandala normally to keep work running.', buttons: ['Keep running', 'Stop runtime and quit'], defaultId: 0, cancelId: 0 });
  confirming = false;
  if (answer.response !== 1 || finished) return;
  stopping = true;
  try { await stopBackgroundService(service); }
  catch (error) { stopping = false; dialog.showErrorBox('Runtime shutdown incomplete', error.message); return; }
  stopping = false; quit();
}

function upgradeCopy() {
  return app.getLocale?.().startsWith('zh') ? {
    pending: '后台升级待完成',
    unknown: '无法确认旧版后台是否空闲。切换会停止当前的本地任务和终端。',
    busy: '后台仍有任务、终端或其他工作。可以继续使用，等工作结束后重新打开 Mandala 完成升级。',
    timeout: '旧后台仍在退出。请稍候重试。',
    later: '稍后', switch: '切换到新版', keepWorking: '继续使用', retry: '重试', quit: '退出',
  } : {
    pending: 'Runtime upgrade pending',
    unknown: 'Mandala cannot confirm that the previous runtime is idle. Switching stops its local tasks and terminals.',
    busy: 'The previous runtime still has active work. Keep working and reopen Mandala after it finishes to complete the upgrade.',
    timeout: 'The previous runtime is still shutting down. Wait a moment, then try again.',
    later: 'Later', switch: 'Switch to New Version', keepWorking: 'Keep Working', retry: 'Try Again', quit: 'Quit',
  };
}

async function connectDesktopRuntime(options, copy) {
  let confirmedSecret;
  const confirmLegacy = async previous => {
    if (previous.record.secret === confirmedSecret) return true;
    const { response } = await dialog.showMessageBox({
      type: 'warning', message: copy.pending, detail: copy.unknown,
      buttons: [copy.later, copy.switch], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1 || finished) return false;
    confirmedSecret = previous.record.secret;
    return true;
  };
  while (!finished) {
    try {
      const connected = await connectOrStartService({ ...options, confirmLegacy });
      if (finished || connected.upgradePending !== 'busy') return connected;
      const { response } = await dialog.showMessageBox({
        type: 'info', message: copy.pending, detail: copy.busy,
        buttons: [copy.keepWorking, copy.retry], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) return connected;
    } catch (error) {
      if (!(error instanceof RuntimeShutdownTimeout) || finished) throw error;
      const { response } = await dialog.showMessageBox({
        type: 'warning', message: copy.pending, detail: copy.timeout,
        buttons: [copy.quit, copy.retry], defaultId: 1, cancelId: 0, noLink: true,
      });
      if (response !== 1) { quit(); return; }
    }
  }
}

async function start() {
  if (stopping || finished) return;
  if (homeError) throw homeError;
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(__dirname, '..', '.runtime');
  const env = desktopEnvironment({ home, runtime, loginPath: loginShellPath() });
  const gatewayHome=join(home,'account-gateway'); prepareDesktopHome(gatewayHome);
  const build = readRuntimeBuild(runtime);
  if (app.isPackaged && !build) throw Error('The installed Mandala build information is missing or invalid.');
  const upgrade = upgradeCopy();
  service = await connectDesktopRuntime({ home:gatewayHome, build, node: join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(runtime, 'server', 'account-desktop-main.mjs'), cwd: runtime, env }, upgrade);
  if (stopping || finished || !service) return;
  const bootstrapResponse=await fetch(service.origin+'/auth/desktop/bootstrap',{headers:{'X-Mandala-Launcher':service.setupToken}});
  if(!bootstrapResponse.ok)throw Error('Could not verify desktop account');
  const bootstrap=await bootstrapResponse.json(), profileHome=bootstrap.home;
  const partition='persist:mandala-account-'+bootstrap.partition, browserSession=session.fromPartition(partition);
  if(bootstrap.token)await browserSession.cookies.set({url:service.origin,name:'mandala_desktop',value:bootstrap.token,path:'/',httpOnly:true,sameSite:'strict'});
  if (service.setupToken) await browserSession.cookies.set({ url: service.origin, name: 'mandala_setup', value: service.setupToken, path: '/auth', httpOnly: true, sameSite: 'strict' });
  if (stopping || finished) return;
  const trustedMicrophoneFrame = (contents, details) => {
    if (!window || contents !== window.webContents || details?.isMainFrame !== true) return false;
    try { return new URL(details.requestingUrl).origin === service.origin && new URL(contents.mainFrame.url).origin === service.origin; } catch { return false; }
  };
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'media' && trustedMicrophoneFrame(contents, details) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));
  browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'media' && trustedMicrophoneFrame(contents, details) && details.mediaType === 'audio');
  // HTML readers have a server-enforced opaque sandbox. Keep app scripts local elsewhere.
  browserSession.webRequest.onHeadersReceived({ urls: [service.origin + '/*'] }, (details, callback) => {
    const preview = /^\/api\/conversations\/[a-zA-Z0-9_-]+\/(?:local-file|workspace-file)\/preview$/.test(new URL(details.url).pathname);
    const policy = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'content-security-policy')?.[1];
    if (preview && policy?.some(value => value.startsWith('sandbox allow-scripts;'))) return callback({ responseHeaders: details.responseHeaders });
    const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => key.toLowerCase() !== 'content-security-policy'));
    callback({ responseHeaders: { ...headers, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://lh1.googleusercontent.com https://lh2.googleusercontent.com https://lh3.googleusercontent.com https://lh4.googleusercontent.com https://lh5.googleusercontent.com https://lh6.googleusercontent.com https://avatars.githubusercontent.com; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'"] } });
  });
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 500, title: 'Mandala', show: false, ...(process.platform === 'darwin' ? {titleBarStyle:'hiddenInset',trafficLightPosition:{x:16,y:16}} : {}), webPreferences: { partition, additionalArguments:['--mandala-account-partition='+bootstrap.partition], preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  let iconMode;
  try { iconMode = JSON.parse(readDesktopAppearance(profileHome) ?? 'null')?.mode; } catch { /* Use the system until a valid appearance is saved. */ }
  const updateAppIcon = () => {
    const dark = iconMode === 'dark' || (iconMode !== 'light' && nativeTheme.shouldUseDarkColors);
    const icon = join(__dirname, dark ? 'icon-dark.png' : 'icon-light.png');
    if (process.platform === 'darwin') app.dock.setIcon(icon);
    else window.setIcon(icon);
  };
  updateAppIcon();
  nativeTheme.on('updated', updateAppIcon);
  app.on('will-quit', () => nativeTheme.removeListener('updated', updateAppIcon));
  window.on('close', event => { if (!finished) { event.preventDefault(); window.hide(); } });
  window.webContents.on('will-prevent-unload', event => {
    if (!finished) return;
    if (discardUnsaved) { event.preventDefault(); return; }
    finished = false; confirming = true;
    void dialog.showMessageBox(window, { type: 'question', title: 'Unsaved settings', message: 'Some settings have not been saved. Local work will keep running if you quit.', buttons: ['Keep editing', 'Quit without saving'], defaultId: 0, cancelId: 0 }).then(answer => {
      confirming = false;
      if (answer.response === 1) { discardUnsaved = true; quit(); }
      else { window.show(); window.focus(); }
    });
  });
  let recoveringRenderer = false;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (finished || stopping || recoveringRenderer) return;
    console.error('Mandala renderer exited', {reason:details.reason,exitCode:details.exitCode});
    recoveringRenderer = true;
    void dialog.showMessageBox(window, {type:'warning',title:'Mandala display stopped',message:'The display stopped. Local work continues in the background.',detail:'Reload to reconnect and check current tasks and run history. Reloading does not resend requests.',buttons:['Later','Reload display'],defaultId:1,cancelId:0}).then(answer => {
      if (answer.response === 1 && !finished && !window.isDestroyed()) window.webContents.reload();
    }).finally(() => { recoveringRenderer = false; });
  });
  window.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url, service.origin)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ipcMain.handle('mandala:account-restart', async event => {
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!allowedNavigation(event.senderFrame?.url??'',service.origin))throw Error('Untrusted account request');
    app.relaunch(); app.exit(0);
  });
  ipcMain.on('mandala:directory-path', (event, path) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame?.url ?? '', service.origin)) {
      event.returnValue = { ok: false, error: 'Untrusted file request' }; return;
    }
    try {
      if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Invalid selected file');
      event.returnValue = { ok: true, value: statSync(path).isDirectory() ? path : null };
    } catch { event.returnValue = { ok: false, error: 'Unable to read the selected file. Select it again.' }; }
  });
  ipcMain.on('mandala:appearance', (event, request) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame?.url ?? '', service.origin)) {
      event.returnValue = { ok: false, error: 'Untrusted appearance request' }; return;
    }
    try {
      if (request?.action === 'read') event.returnValue = { ok: true, value: readDesktopAppearance(profileHome) };
      else if (request?.action === 'write') { writeDesktopAppearance(profileHome, request.value); iconMode = JSON.parse(request.value).mode; updateAppIcon(); event.returnValue = { ok: true }; }
      else throw Error('Invalid appearance request');
    } catch { event.returnValue = { ok: false, error: 'Could not access desktop appearance storage' }; }
  });
  ipcMain.on('mandala:preferences', (event, request) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame?.url ?? '', service.origin)) {
      event.returnValue = { ok: false, error: 'Untrusted preferences request' }; return;
    }
    try {
      if (request?.action === 'read') event.returnValue = { ok: true, value: readDesktopPreferences(profileHome) };
      else if (request?.action === 'write') { writeDesktopPreference(profileHome, request.key, request.value); event.returnValue = { ok: true }; }
      else throw Error('Invalid preferences request');
    } catch { event.returnValue = { ok: false, error: 'Could not access desktop preferences' }; }
  });
  ipcMain.handle('mandala:cli', async (event, request) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame?.url ?? '', service.origin)) return { ok: false, error: 'Untrusted command registration request' };
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== 1 || !['status', 'install'].includes(request.action)) throw Error('Invalid command registration request');
      const options = { runtime, home:profileHome, path: loginShellPath() };
      return { ok: true, value: request.action === 'install' ? installDesktopCli(options) : desktopCliStatus(options) };
    } catch (error) { return { ok: false, error: error.message || 'Could not register the desktop command' }; }
  });
  // The pet's place survives restarts, as long as it is still on a connected screen.
  const petPositionFile = () => join(app.getPath('userData'), 'pet-position.json');
  const readPetPosition = (width, height) => {
    try {
      const value = JSON.parse(readFileSync(petPositionFile(), 'utf8'));
      if (!Number.isInteger(value?.x) || !Number.isInteger(value?.y)) return undefined;
      const visible = screen.getAllDisplays().some(({ workArea }) => value.x >= workArea.x - width / 2 && value.y >= workArea.y - height / 2 && value.x + width / 2 <= workArea.x + workArea.width && value.y + height / 2 <= workArea.y + workArea.height);
      return visible ? { x: value.x, y: value.y } : undefined;
    } catch { return undefined; }
  };
  const savePetPosition = value => { petPosition = value; try { writeFileSync(petPositionFile(), JSON.stringify(value), { mode: 0o600 }); } catch { /* The position is a convenience. */ } };
  // The pet window shows only the Mandala pet; it may open a path in the main window and close itself.
  const trustedFrom = (event, target) => !!target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame && allowedNavigation(event.senderFrame?.url ?? '', service.origin);
  const showPet = () => {
    if (petWindow && !petWindow.isDestroyed()) { petWindow.showInactive(); return; }
    const { workArea } = screen.getPrimaryDisplay(), width = 200, height = 190;
    petPosition ??= readPetPosition(width, height);
    const start = petPosition ?? { x: workArea.x + workArea.width - width - 24, y: workArea.y + workArea.height - height - 24 };
    petWindow = new BrowserWindow({ width, height, x: start.x, y: start.y, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'Mandala Pet',
      webPreferences: { partition, additionalArguments:['--mandala-account-partition='+bootstrap.partition], preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    petWindow.setAlwaysOnTop(true, 'floating');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Only the pet takes the mouse; the transparent rest of the window passes clicks to what is underneath.
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    petWindow.on('moved', () => { if (petWindow && !petWindow.isDestroyed()) { const [x, y] = petWindow.getPosition(); petPosition = { x, y }; } });
    petWindow.webContents.on('will-navigate', event => event.preventDefault());
    petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    petWindow.once('ready-to-show', () => petWindow?.showInactive());
    petWindow.on('closed', () => { petWindow = undefined; if (!finished && window && !window.isDestroyed()) window.webContents.send('mandala:pet-visibility', false); });
    void petWindow.loadURL(service.origin + '/pet');
  };
  ipcMain.on('mandala:pet-input', (event, request) => {
    if (!trustedFrom(event, petWindow) || !request || typeof request !== 'object') return;
    if (request.action === 'interactive' && typeof request.value === 'boolean') petWindow.setIgnoreMouseEvents(!request.value, { forward: true });
    else if (request.action === 'move' && Number.isInteger(request.x) && Number.isInteger(request.y) && Math.abs(request.x) < 100000 && Math.abs(request.y) < 100000) {
      petWindow.setPosition(request.x, request.y); petPosition = { x: request.x, y: request.y };
    } else if (request.action === 'settle') {
      // After a drag, a pet left close to a screen edge settles against it, and its place is kept for next time.
      const bounds = petWindow.getBounds(), { workArea } = screen.getDisplayMatching(bounds), snap = 18;
      let { x, y } = bounds;
      if (Math.abs(x - workArea.x) < snap) x = workArea.x;
      if (Math.abs(workArea.x + workArea.width - (x + bounds.width)) < snap) x = workArea.x + workArea.width - bounds.width;
      if (Math.abs(y - workArea.y) < snap) y = workArea.y;
      if (Math.abs(workArea.y + workArea.height - (y + bounds.height)) < snap) y = workArea.y + workArea.height - bounds.height;
      if (x !== bounds.x || y !== bounds.y) petWindow.setPosition(x, y);
      savePetPosition({ x, y });
    }
  });
  ipcMain.handle('mandala:pet', async (event, request) => {
    const fromMain = trustedFrom(event, window), fromPet = trustedFrom(event, petWindow);
    if (!fromMain && !fromPet) return { ok: false, error: 'Untrusted pet request' };
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('Invalid pet request');
      if (request.action === 'show' && fromMain) { showPet(); return { ok: true }; }
      if (request.action === 'hide') { if (petWindow && !petWindow.isDestroyed()) petWindow.close(); return { ok: true }; }
      const path = request.path;
      if (request.action === 'open' && typeof path === 'string' && path.length <= 500 && path.startsWith('/') && !path.startsWith('//') && !/[\\\0]/.test(path)) {
        window.show(); window.focus(); window.webContents.send('mandala:navigate', path); return { ok: true };
      }
      throw Error('Invalid pet request');
    } catch (error) { return { ok: false, error: error.message || 'Pet window unavailable' }; }
  });
  ipcMain.on('mandala:open-external', (event, value) => {
    if (event.sender !== window.webContents || !allowedNavigation(event.senderFrame?.url ?? '', service.origin) || typeof value !== 'string') return;
    try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) void shell.openExternal(url.href); } catch {}
  });
  // Update state is shared by the menu, the settings page and the background schedule.
  const updateStateFile = () => join(app.getPath('userData'), 'update-state.json');
  const showSettings = () => { window.show(); window.focus(); window.webContents.send('mandala:navigate', '/settings/general'); };
  const updates = createUpdateController({ version: app.getVersion(), platform: process.platform, arch: process.arch,
    store: { read: () => JSON.parse(readFileSync(updateStateFile(), 'utf8')), write: value => writeFileSync(updateStateFile(), JSON.stringify(value), { mode: 0o600 }) },
    isActive: () => !stopping && !finished, showMessage: options => dialog.showMessageBox(options), openExternal: url => shell.openExternal(url),
    onChange: value => { if (window && !window.isDestroyed()) window.webContents.send('mandala:update-state', value); },
    notify: update => { if (!Notification.isSupported()) return; const note = new Notification({ title: 'Mandala update available', body: `Mandala ${update.version} is ready to download. Open Settings to see what changed.` }); note.on('click', showSettings); note.show(); } });
  ipcMain.handle('mandala:updates', async (event, request) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame?.url ?? '', service.origin)) return { ok: false, error: 'Untrusted update request' };
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('Invalid update request');
      if (request.action === 'state') return { ok: true, value: updates.state() };
      if (request.action === 'check') return { ok: true, value: await updates.check('settings') };
      if (request.action === 'download') { await updates.download(); return { ok: true, value: updates.state() }; }
      if (request.action === 'auto' && typeof request.value === 'boolean') return { ok: true, value: updates.setAutoCheck(request.value) };
      throw Error('Invalid update request');
    } catch (error) { return { ok: false, error: error.message || 'Could not check for updates' }; }
  });
  const menu = [
    { label: 'Mandala', submenu: [
      { label: 'Show Mandala', click: () => { window.show(); window.focus(); } },
      { label: 'Open data directory', click: () => shell.openPath(profileHome) },
      { label: 'Check for updates…', click: () => { void updates.check('menu'); } },
      { label: 'About Mandala', click: () => dialog.showMessageBox({ title: 'Mandala', message: `Mandala ${app.getVersion()}`, detail: 'Local service and native CLI authentication stay on this computer. This preview uses manual installer upgrades.' }) },
      ...(service.upgradePending ? [{ label: upgrade.pending, click: () => dialog.showMessageBox(window, {
        type: 'info', message: upgrade.pending, detail: service.upgradePending === 'busy' ? upgrade.busy : upgrade.unknown,
      }) }] : []),
      { label: 'Stop runtime and quit…', click: stopRuntime },
      { type: 'separator' }, { label: 'Quit Mandala', accelerator: 'CmdOrCtrl+Q', click: quit }
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  // A tray makes the background app reachable on Windows and when its window is hidden.
  const icon = nativeImage.createFromPath(join(__dirname, process.platform === 'darwin' ? 'tray.png' : 'tray-color.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip(service.upgradePending ? `Mandala — ${upgrade.pending}` : 'Mandala — connected to background runtime');
  tray.setContextMenu(Menu.buildFromTemplate(menu[0].submenu)); tray.on('double-click', () => window.show());
  await window.loadURL(service.origin); if (!stopping && !finished) window.show();
  if (app.isPackaged && !stopping && !finished) {
    const stopUpdateChecks = updates.schedule({ setTimeout, setInterval, clearTimeout, clearInterval });
    app.once('will-quit', stopUpdateChecks);
  }
}
