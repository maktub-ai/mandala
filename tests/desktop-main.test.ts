import { expect, test, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const source = readFileSync('desktop/main.cjs', 'utf8');
const tick = () => new Promise<void>(r => setImmediate(r));
async function fixture(pending = false, platform = 'darwin', dark = false, initialAppearance: string | null = null, packaged = false, localUpdate: unknown = null, startup: { background: boolean; paused: boolean; windowsRegistered?: boolean; publicUpdate?: any; idleStop?: string; dirty?: boolean; dirtyBeforeDrain?: boolean } = { background: false, paused: false }) {
  const app: any = new EventEmitter(), child: any = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 99999999;
  const events = { quit: 0, exit: 0, idleStop: 0, relaunch: 0, input: [] as boolean[], errors: [] as unknown[], stop: 0, shown: 0, icons: [] as string[], reloads: 0, prompts: [] as unknown[] };
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: dark });
  app.nativeTheme = nativeTheme;
  app.dock = { show() {}, hide() {}, setIcon: (icon: string) => events.icons.push(icon) };
  let unloadChecks=0;
  let browserWindow: any, appearance: string | null = initialAppearance;
  const preferences:Record<string,string>={};
  let menu: any, resolveConfirm!: (value: any) => void, resolveStart!: (value: any) => void;
  const timers: any[] = [];
  const loginRegistrations: unknown[] = [];
  let loginStartupPaused = startup.paused, runtimeStarts = 0;
  app.isPackaged = packaged;
  app.getLoginItemSettings = (options: {path:string}) => ({
    launchItems: startup.windowsRegistered !== false && options.path === '"C:\\Program Files\\Mandala\\Mandala.exe"' ? [{name:'Mandala',scope:'user',args:['--mandala-background'],enabled:false}] : [],
  });
  app.setLoginItemSettings = (options: unknown) => loginRegistrations.push(options);
  app.setPath = app.setName = () => {}; app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve(); app.getVersion = () => 'synthetic'; app.getPath = () => '/private/tmp/synthetic';
  app.quit = () => events.quit++; app.exit = () => events.exit++; app.relaunch = () => events.relaunch++;
  const dialog = { showErrorBox: (...a: unknown[]) => events.errors.push(a), showMessageBox: (...args: unknown[]) => { events.prompts.push(args); return new Promise(r => resolveConfirm = r); } };
  class BrowserWindow extends EventEmitter {
    webContents: any = new EventEmitter();
    constructor() { super(); browserWindow = this; this.webContents.mainFrame = { url: 'http://127.0.0.1:54321/' }; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; this.webContents.executeJavaScript = async () => !startup.dirty && (++unloadChecks===1 || !startup.dirtyBeforeDrain); this.webContents.reload = () => events.reloads++;  }
    loadURL() { return Promise.resolve(); } show() { events.shown++; } focus() {} hide() {}
    isDestroyed() { return false; }
    setEnabled(enabled:boolean) {events.input.push(enabled);}
    setIcon(icon: string) { events.icons.push(icon); }
  }
  class Tray { setToolTip() {} setContextMenu() {} on() {} destroy() {} }
  let headersHandler:Function,permissionRequest:Function,permissionCheck:Function;
  const headersFor=(url:string,headers:Record<string,string[]>)=>{let result:any;headersHandler({url,responseHeaders:headers},(value:any)=>{result=value.responseHeaders;});return result;};
  const handlers=new Map<string,Function>();
  const ipcMain=Object.assign(new EventEmitter(),{handle:(channel:string,handler:Function)=>handlers.set(channel,handler)});
  const browserLinks = { issuedUrl: '', requests: [] as {url: string; options: RequestInit}[], opened: [] as string[] };
  const gatewayFetch = async (url: string, options: RequestInit) => {
    if (url.endsWith('/auth/desktop/bootstrap')) return {ok:true, json:async()=>({partition:'test', home:'/private/tmp/synthetic', token:'synthetic-desktop'})};
    browserLinks.requests.push({url, options});
    return {ok:!!browserLinks.issuedUrl, json:async()=>({url:browserLinks.issuedUrl})};
  };
  const electron = { app, BrowserWindow, nativeTheme, Menu: { setApplicationMenu: (m: any) => menu = m, buildFromTemplate: (m: any) => m }, Tray, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) }, dialog, shell: {openExternal: (url: string) => browserLinks.opened.push(url)}, session: { defaultSession: { cookies: { set: () => Promise.resolve() }, setPermissionRequestHandler(handler:Function) {permissionRequest=handler;}, setPermissionCheckHandler(handler:Function) {permissionCheck=handler;}, webRequest: { onHeadersReceived(_filter:unknown,handler:Function) {headersHandler=handler;} } } }, ipcMain };
  (electron.session as any).fromPartition=()=>electron.session.defaultSession;
  const service = { home: '/private/tmp/synthetic-mandala-runtime', child, origin: 'http://127.0.0.1:54321' };
  const commandCalls:string[]=[];
  const runtime = { backgroundLaunchArgument: '--mandala-background', registerMacLoginStartup() {},
    loginStartupPaused: () => loginStartupPaused, setLoginStartupPaused: (_home: string, paused: boolean) => { loginStartupPaused = paused; },
    claimServiceHome: () => ({release(){}}), RuntimeShutdownTimeout: Error, readRuntimeBuild: () => packaged ? { version: '1.0.0', commit: 'a'.repeat(40) } : undefined, desktopCliStatus:()=>{commandCalls.push('status');return {installed:false};},installDesktopCli:()=>{commandCalls.push('install');return {installed:true};},resolveDesktopHome: () => '/private/tmp/synthetic', desktopEnvironment: () => ({}), loginShellPath: async () => '', assertHomeAvailable() {}, prepareDesktopHome() {}, connectOrStartService: (_options: any) => { runtimeStarts++; return pending ? new Promise(r => resolveStart = r) : Promise.resolve(service); }, stopBackgroundServiceIfIdle: async () => { events.idleStop++; return startup.idleStop ?? 'accepted'; }, stopBackgroundService: async () => { events.stop++; child.exitCode = 0; child.emit('exit', 0); }, forceStopService: async () => {}, allowedNavigation: (url: string, origin: string) => url.startsWith(origin + '/'), readDesktopPreferences:()=>({...preferences}),writeDesktopPreference:(_home:string,key:string,value:string)=>{if(key==='unknown')throw Error('Invalid key');preferences[key]=value;},readDesktopAppearance: () => appearance, writeDesktopAppearance: (_home: string, value: string) => { if (value === 'invalid') throw Error('Invalid appearance'); appearance = value; } };
  vm.runInNewContext(source, { require: (p: string) => p === 'electron' ? electron : p === './runtime.cjs' ? runtime : p === './updates.cjs' ? require('../desktop/updates.cjs') : p === './local-update.cjs' ? { createLocalUpdate: () => localUpdate } : p === './public-mac-update.cjs' ? { createPublicMacUpdate: () => startup.publicUpdate ?? null } :
    p === 'node:fs' && startup.publicUpdate ? {...require(p),readFileSync:(path:string,...args:any[])=>path.endsWith('/public-update.json')?'{}':require(p).readFileSync(path,...args)} : require(p), __dirname: '/private/tmp/synthetic', fetch:gatewayFetch, AbortSignal, process: { platform, env: {}, argv: startup.background ? ['--mandala-background'] : [], execPath: 'C:\\Program Files\\Mandala\\Mandala.exe', arch: 'arm64', resourcesPath: '/private/tmp/synthetic' }, console, setImmediate, URL, setTimeout: (_fn: Function, delay: number) => { const timer = { delay, unref() {}, cleared: false }; timers.push(timer); return timer; }, setInterval: (_fn: Function, delay: number) => { const timer = { delay, unref() {}, cleared: false }; timers.push(timer); return timer; }, clearTimeout: (timer: any) => { timer.cleared = true; }, clearInterval: (timer: any) => { timer.cleared = true; } });
  await tick(); await tick();
  const appearanceRequest = (request: unknown, override = {}) => { const event = { sender: browserWindow.webContents, senderFrame: browserWindow.webContents.mainFrame, returnValue: undefined, ...override }; electron.ipcMain.emit('mandala:appearance', event, request); return event.returnValue; };
  const preferenceRequest=(request:unknown,override={})=>{const event={sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,returnValue:undefined,...override};electron.ipcMain.emit('mandala:preferences',event,request);return event.returnValue;};
  const cliRequest=(request:unknown,override={})=>handlers.get('mandala:cli')!({sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,...override},request);
  const updateRequest=(request:unknown,override={})=>handlers.get('mandala:updates')!({sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,...override},request);
  const directoryRequest=(path:unknown,override={})=>{const event={sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,returnValue:undefined,...override};electron.ipcMain.emit('mandala:directory-path',event,path);return event.returnValue;};
  const externalLink = (value: string, override = {}) => ipcMain.emit('mandala:open-external', {sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,...override},value);
  return { browserLinks, externalLink, timers, loginRegistrations, runtimeStarts: () => runtimeStarts, startupPaused: () => loginStartupPaused, menu: () => menu, permission: (types:string[],main=true,url=browserWindow.webContents.mainFrame.url) => {let allowed=false;permissionRequest(browserWindow.webContents,'media',(value:boolean)=>allowed=value,{mediaTypes:types,isMainFrame:main,requestingUrl:url});return allowed;}, permissionCheck: (type:string,main=true,url=browserWindow.webContents.mainFrame.url) => permissionCheck(browserWindow.webContents,'media',url,{mediaType:type,isMainFrame:main,requestingUrl:url}), headersFor, crash: (reason='crashed',exitCode=139) => browserWindow.webContents.emit('render-process-gone', {}, {reason,exitCode}), directoryRequest, app, child, events, appearanceRequest, preferenceRequest, cliRequest, updateRequest, commandCalls, mainFrame: browserWindow?.webContents.mainFrame, unload: (preventDefault: () => void) => browserWindow.webContents.emit('will-prevent-unload', { preventDefault }), quit: () => menu[0].submenu.find((x: any) => x.label === 'Quit Mandala').click(), stop: () => menu[0].submenu.find((x: any) => x.label === 'Stop runtime and quit…').click(), confirm: (response: number) => resolveConfirm({ response }), ready: () => resolveStart(service) };
}
test.each([['darwin', false], ['darwin', true], ['win32', false], ['win32', true]])('app icon follows system appearance on %s (initial dark: %s)', async (platform, dark) => {
  const f = await fixture(false, platform as string, dark as boolean);
  const initial = dark ? 'dark' : 'light', next = dark ? 'light' : 'dark';
  expect(f.events.icons).toEqual([`/private/tmp/synthetic/icon-${initial}.png`]);
  f.app.nativeTheme.shouldUseDarkColors = !dark;
  f.app.nativeTheme.emit('updated');
  expect(f.events.icons).toEqual([`/private/tmp/synthetic/icon-${initial}.png`, `/private/tmp/synthetic/icon-${next}.png`]);
  expect(f.events.stop).toBe(0); expect(f.events.quit).toBe(0);
  f.app.emit('will-quit');
  expect(f.app.nativeTheme.listenerCount('updated')).toBe(0);
});

test('normal quit exits the frontend without a prompt or a runtime shutdown', async () => {
  const f = await fixture(); f.quit(); await tick();
  expect(f.events.quit).toBe(1); expect(f.events.stop).toBe(0); expect(f.events.errors).toHaveLength(0);
});
test('quit while startup is pending allows the runtime to finish without creating a window', async () => {
  const f = await fixture(true); f.app.emit('before-quit', { preventDefault() {} }); await tick();
  expect(f.events.stop).toBe(0); expect(f.events.quit).toBe(1);
  f.ready(); await tick(); await tick(); expect(f.events.shown).toBe(0);
});
test('only explicit confirmed runtime shutdown stops local work', async () => {
  const f = await fixture(); let stopping = f.stop(); await tick(); f.confirm(0); await stopping;
  expect(f.events.stop).toBe(0); expect(f.events.quit).toBe(0);
  stopping = f.stop(); await tick(); f.confirm(1); await stopping;
  expect(f.events.stop).toBe(1); expect(f.events.quit).toBe(1); expect(f.startupPaused()).toBe(true);
});

test('cancelled quit keeps unsaved settings and allows a later explicit discard', async () => {
  const f = await fixture(); let discarded = 0;
  f.quit(); f.unload(() => discarded++); await tick(); f.confirm(0); await tick();
  expect(discarded).toBe(0); expect(f.events.stop).toBe(0);
  f.quit(); f.unload(() => discarded++); await tick(); f.confirm(1); await tick();
  f.unload(() => discarded++);
  expect(discarded).toBe(1); expect(f.events.stop).toBe(0);
});

test('OS quit resumes after the cancelled before-quit event has returned', async () => {
  const f = await fixture();
  f.app.emit('before-quit', { preventDefault() {} });
  expect(f.events.quit).toBe(0);
  await tick(); expect(f.events.quit).toBe(1); expect(f.events.stop).toBe(0);
});


test('appearance IPC accepts only the current main frame and reports rejected writes', async () => {
 const f = await fixture();
 expect(f.appearanceRequest({action:'read'})).toEqual({ok:true,value:null});
 const saved=JSON.stringify({version:1,mode:'dark'});
 expect(f.appearanceRequest({action:'write',value:saved})).toEqual({ok:true});
 expect(f.appearanceRequest({action:'read'})).toEqual({ok:true,value:saved});
 for (const override of [{sender:{}},{senderFrame:{url:f.mainFrame.url}},{senderFrame:{url:'https://remote.example/'}}])
   expect(f.appearanceRequest({action:'write',value:'replacement'},override)).toMatchObject({ok:false});
 expect(f.appearanceRequest({action:'write',value:'invalid'})).toMatchObject({ok:false});
 expect(f.appearanceRequest({action:'delete'})).toMatchObject({ok:false});
 f.mainFrame.url='https://remote.example/';
 expect(f.appearanceRequest({action:'read'})).toMatchObject({ok:false});
 f.mainFrame.url='http://127.0.0.1:54321/';
 expect(f.appearanceRequest({action:'read'})).toEqual({ok:true,value:saved});
});


test('UI preference IPC restricts read and write to the trusted main frame',async()=>{
 const f=await fixture();expect(f.preferenceRequest({action:'write',key:'mana-language',value:'zh-CN'})).toEqual({ok:true});expect(f.preferenceRequest({action:'read'})).toEqual({ok:true,value:{'mana-language':'zh-CN'}});
 for(const override of [{sender:{}},{senderFrame:{url:f.mainFrame.url}},{senderFrame:{url:'https://remote.example/'}}])expect(f.preferenceRequest({action:'write',key:'mana-language',value:'en'},override)).toMatchObject({ok:false});
 expect(f.preferenceRequest({action:'write',key:'unknown',value:'x'})).toMatchObject({ok:false});expect(f.preferenceRequest({action:'read'})).toEqual({ok:true,value:{'mana-language':'zh-CN'}});
});


test.each(['darwin','win32'])('Dock/window icon follows saved App mode and live settings on %s',async platform=>{
 const f=await fixture(false,platform,true,JSON.stringify({version:1,mode:'light'}));
 expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-light.png');
 const save=(mode:string)=>f.appearanceRequest({action:'write',value:JSON.stringify({version:1,mode})});
 expect(save('dark')).toEqual({ok:true});expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
 expect(save('light')).toEqual({ok:true});expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-light.png');
 f.app.nativeTheme.emit('updated');expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-light.png');
 expect(f.app.nativeTheme.shouldUseDarkColors).toBe(true);
 expect(save('system')).toEqual({ok:true});expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
 f.app.nativeTheme.shouldUseDarkColors=false;f.app.nativeTheme.emit('updated');expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-light.png');
 expect(save('dark')).toEqual({ok:true});f.app.nativeTheme.emit('updated');expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
 expect(f.appearanceRequest({action:'write',value:'invalid'})).toMatchObject({ok:false});expect(f.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
 const before=f.events.icons.length;
 expect(f.appearanceRequest({action:'write',value:JSON.stringify({version:1,mode:'light'})},{sender:{}})).toMatchObject({ok:false});
 expect(f.events.icons.length).toBe(before);expect(f.events.stop).toBe(0);expect(f.events.quit).toBe(0);
});
test('saved dark App mode wins over a light OS on cold start; unreadable appearance falls back to OS',async()=>{
 const dark=await fixture(false,'darwin',false,JSON.stringify({version:1,mode:'dark'}));expect(dark.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
 const broken=await fixture(false,'darwin',true,'{broken');expect(broken.events.icons.at(-1)).toBe('/private/tmp/synthetic/icon-dark.png');
});

test('command registration IPC accepts only bounded actions from the trusted main frame',async()=>{
 const f=await fixture();expect(await f.cliRequest({action:'status'})).toEqual({ok:true,value:{installed:false}});expect(await f.cliRequest({action:'install'})).toEqual({ok:true,value:{installed:true}});
 for(const request of [{action:'write',path:'/usr/local/bin/mandala'},{action:'install',path:'/tmp/foreign'},null,[]])expect(await f.cliRequest(request)).toMatchObject({ok:false});
 for(const override of [{sender:{}},{senderFrame:{url:'http://127.0.0.1:54321/'}},{senderFrame:{url:'https://example.com/'}}])expect(await f.cliRequest({action:'install'},override)).toMatchObject({ok:false});
 expect(f.commandCalls).toEqual(['status','install']);
});


test('selected directory paths are returned only to the trusted local main frame', async () => {
 const f=await fixture();
 expect(f.directoryRequest(process.cwd())).toEqual({ok:true,value:process.cwd()});
 expect(f.directoryRequest(require.resolve('../package.json'))).toEqual({ok:true,value:null});
 for(const path of [null,{},'relative/path'])expect(f.directoryRequest(path)).toMatchObject({ok:false});
 for(const override of [{sender:{}},{senderFrame:{}},{senderFrame:{url:'https://foreign.example/'}}])expect(f.directoryRequest(process.cwd(),override)).toMatchObject({ok:false});
});

test('renderer termination offers explicit reload without resending work or stopping runtime',async()=>{
 const f=await fixture();f.crash();await tick();expect(f.events.prompts).toHaveLength(1);expect(f.events.reloads).toBe(0);expect(f.events.stop).toBe(0);f.confirm(0);await tick();expect(f.events.reloads).toBe(0);f.crash('oom',137);await tick();f.confirm(1);await tick();expect(f.events.reloads).toBe(1);expect(f.events.stop).toBe(0);expect(f.events.quit).toBe(0);
});


test('keeps the HTML sandbox response policy only for the explicit preview routes',async()=>{
 const f=await fixture(),sandbox="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'";
 for(const path of ['/api/conversations/chat/local-file/preview?href=report.html','/api/conversations/chat/workspace-file/preview?path=report.htm','/api/v2/library-sections/docs/files/todo-app/view.html?project=todo'])expect(f.headersFor('http://127.0.0.1:54321'+path,{'content-security-policy':[sandbox]})).toEqual({'content-security-policy':[sandbox]});
 for(const path of ['/','/api/conversations/chat/local-file','/api/conversations/chat/attachments/preview','/api/v2/library-sections/docs/files/todo-app/summary.json'])expect(f.headersFor('http://127.0.0.1:54321'+path,{'content-security-policy':[sandbox]})['Content-Security-Policy']).toEqual([expect.stringContaining("script-src 'self'")]);
 expect(f.headersFor('http://127.0.0.1:54321/api/conversations/chat/local-file/preview',{})['Content-Security-Policy']).toEqual([expect.stringContaining("script-src 'self'")]);
});

test('opens a library file with a scoped browser link from the signed-in gateway', async () => {
  const f = await fixture(), origin = 'http://127.0.0.1:54321', view = origin + '/api/v2/library-sections/docs/files/todo-app/view.html?project=todo';
  f.browserLinks.issuedUrl = view + '&grant=synthetic';
  f.externalLink(view); await tick();
  expect(f.browserLinks.requests).toEqual([{url:view, options:expect.objectContaining({
    method:'POST', redirect:'error', headers:{Origin:origin, Cookie:'mandala_desktop=synthetic-desktop', 'X-Mandala-File-Link':'1'},
  })}]);
  expect(f.browserLinks.opened).toEqual([f.browserLinks.issuedUrl]);
  f.externalLink(view, {senderFrame:{url:origin + '/'}}); f.externalLink(origin + '/library'); await tick();
  expect(f.browserLinks.requests).toHaveLength(1);
  for (const bad of ['', 'https://example.com/', origin + '/api/config']) {
    f.browserLinks.issuedUrl = bad; f.externalLink(view); await tick();
  }
  expect(f.browserLinks.opened).toEqual([view + '&grant=synthetic']);
});

test('only trusted same-origin library file links open in the system browser', () => {
  const origin = 'http://127.0.0.1:54321', opened: string[] = [];
  let click!: (event: unknown) => void;
  class Link {
    target = '_blank';
    constructor(readonly href: string) {}
    closest() { return this; }
  }
  vm.runInNewContext(readFileSync('desktop/preload.cjs', 'utf8'), {
    require: () => ({contextBridge: {exposeInMainWorld() {}}, ipcRenderer: {send: (_channel: string, url: string) => opened.push(url)}}),
    window: {location: {origin}, addEventListener: (_type: string, callback: typeof click) => { click = callback; }},
    process: {argv: []}, URL, Element: Link,
  });
  const open = (path: string, isTrusted = true) => click({target: new Link(origin + path), button: 0, isTrusted, preventDefault() {}, stopImmediatePropagation() {}});
  const view = '/api/v2/library-sections/docs/files/todo-app/view.html?project=todo';
  open(view); open(view, false); open('/library'); open('/api/v2/library-sections/docs/files/todo-app/summary.json');
  expect(opened).toEqual([origin + view]);
});

test('microphone permissions allow only audio in the trusted main frame',async()=>{
 const f=await fixture();
 expect(f.permission(['audio'])).toBe(true);
 expect(f.permissionCheck('audio')).toBe(true);
 for(const types of [[],['video'],['audio','video']])expect(f.permission(types)).toBe(false);
 expect(f.permission(['audio'],false)).toBe(false);
 expect(f.permission(['audio'],true,'https://example.com')).toBe(false);
 expect(f.permissionCheck('video')).toBe(false);
 expect(f.permissionCheck('audio',false)).toBe(false);
});

test('packaged App schedules update checks after startup and clears them on quit', async () => {
  const f = await fixture(false, 'darwin', false, null, true);
  expect(f.menu()[0].submenu.some((item: any) => item.label === 'Check for updates…')).toBe(true);
  expect(f.timers.map(t => t.delay)).toEqual([30000, 21600000]);
  f.app.emit('will-quit'); expect(f.timers.every(t => t.cleared)).toBe(true);
  expect((await fixture()).timers).toEqual([]);
});

test('a ready local update applies only after the app confirms quit', async () => {
  const install = vi.fn(async (stop: () => Promise<boolean>) => await stop() ? 'installed' : 'busy');
  const f = await fixture(false, 'darwin', false, null, true, { ready: () => ({ version: 'next' }), install });
  f.quit(); f.unload(() => {}); await tick(); f.confirm(0); await tick();
  expect(install).not.toHaveBeenCalled();
  expect(f.events.idleStop).toBe(0);
  f.quit();
  const preventDefault = vi.fn();
  f.app.emit('will-quit', { preventDefault });
  await tick();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
  expect(f.events.idleStop).toBe(1);
  expect(f.events.exit).toBe(1);
});


test('system login starts the runtime and exits before creating the interface', async () => {
  const f = await fixture(false, 'darwin', false, null, true, null, { background: true, paused: false });
  expect(f.runtimeStarts()).toBe(1);
  expect(f.events.quit).toBe(1);
  expect(f.mainFrame).toBeUndefined();
});

test('paused login skips runtime startup until a manual open', async () => {
  const paused = await fixture(false, 'darwin', false, null, true, null, { background: true, paused: true });
  expect(paused.runtimeStarts()).toBe(0);
  expect(paused.startupPaused()).toBe(true);
  const manual = await fixture(false, 'darwin', false, null, true, null, { background: false, paused: true });
  expect(manual.runtimeStarts()).toBe(1);
  expect(manual.startupPaused()).toBe(false);
});

test('keeps a Windows login item disabled by the OS when its installation path contains spaces', async () => {
  const f = await fixture(false, 'win32', false, null, true);
  expect(f.loginRegistrations).toEqual([]);
});


test('registers a missing Windows login item with the background launch argument', async () => {
  const f = await fixture(false, 'win32', false, null, true, null, { background: false, paused: false, windowsRegistered: false });
  expect(f.loginRegistrations).toEqual([{name:'Mandala',path:'"C:\\Program Files\\Mandala\\Mandala.exe"',args:['--mandala-background'],openAtLogin:true}]);
});

test('ordinary quit never installs a ready public Mac update, and an untrusted IPC cannot request it', async () => {
 const publicUpdate={ready:()=>({version:'1.0.1',publicMac:true}),install:vi.fn()};
 const f=await fixture(false,'darwin',false,null,true,null,{background:false,paused:false,publicUpdate});
 expect(await f.updateRequest({action:'state'})).toMatchObject({value:{status:'ready'}});
 expect(await f.updateRequest({action:'install'},{sender:{}})).toMatchObject({ok:false});
 f.quit();f.app.emit('will-quit',{preventDefault:vi.fn()});await tick();
 expect(publicUpdate.install).not.toHaveBeenCalled();expect(f.events.idleStop).toBe(0);
});
test.each(['busy','accepted'])('explicit signed update only relaunches after confirmed idle shutdown (%s)', async idleStop=>{
 const publicUpdate={ready:()=>({version:'1.0.1',publicMac:true}),install:vi.fn(async (drain:()=>Promise<boolean>,lease:()=>null|{release():void})=>{if(!await drain())return 'busy';const lock=lease();if(!lock)return 'busy';lock.release();return 'installed';})};
 const f=await fixture(false,'darwin',false,null,true,null,{background:false,paused:false,publicUpdate,idleStop});
 const install=f.updateRequest({action:'install'});await tick();
 expect(f.events.idleStop).toBe(0);
 f.confirm(1);await tick();await tick();
 if(idleStop==='busy')f.confirm(0);
 expect(await install).toMatchObject({ok:true});
 expect(f.events.idleStop).toBe(1);
 expect(f.events.relaunch).toBe(idleStop==='accepted'?1:0);
 expect(f.events.input).toEqual(idleStop==='accepted'?[false]:[false,true]);
 expect(f.events.stop).toBe(0);
});

test('an editor rejecting normal quit prevents installation before the runtime stops', async () => {
 const publicUpdate={ready:()=>({version:'1.0.1',publicMac:true}),install:vi.fn()};
 const f=await fixture(false,'darwin',false,null,true,null,{background:false,paused:false,publicUpdate,dirty:true});
 const install=f.updateRequest({action:'install'});await tick();f.confirm(1);await tick();await tick();f.confirm(0);
 expect(await install).toMatchObject({ok:true,value:{status:'ready'}});
 expect(publicUpdate.install).not.toHaveBeenCalled();expect(f.events.idleStop).toBe(0);expect(f.events.exit).toBe(0);
});

test('a new unsaved edit during archive preparation cancels the update before runtime drain',async()=>{
 const publicUpdate={ready:()=>({version:'1.0.1',publicMac:true}),install:vi.fn(async (drain:()=>Promise<boolean>)=>await drain()?'installed':'busy')};
 const f=await fixture(false,'darwin',false,null,true,null,{background:false,paused:false,publicUpdate,dirtyBeforeDrain:true});
 const install=f.updateRequest({action:'install'});await tick();f.confirm(1);await tick();await tick();f.confirm(0);
 expect(await install).toMatchObject({ok:true,value:{status:'ready'}});
 expect(publicUpdate.install).toHaveBeenCalledOnce();
 expect(f.events.input).toEqual([false,true]);expect(f.events.idleStop).toBe(0);
 expect(f.events.relaunch).toBe(0);expect(f.events.exit).toBe(0);
});
