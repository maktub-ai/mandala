import { expect, test } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const source = readFileSync('desktop/main.cjs', 'utf8');
const tick = () => new Promise<void>(r => setImmediate(r));
async function fixture(pending = false, platform = 'darwin', dark = false, initialAppearance: string | null = null, packaged = false) {
  const app: any = new EventEmitter(), child: any = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 99999999;
  const events = { quit: 0, errors: [] as unknown[], stop: 0, shown: 0, icons: [] as string[], reloads: 0, prompts: [] as unknown[] };
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: dark });
  app.nativeTheme = nativeTheme;
  app.dock = { setIcon: (icon: string) => events.icons.push(icon) };
  let browserWindow: any, appearance: string | null = initialAppearance;
  const preferences:Record<string,string>={};
  let menu: any, resolveConfirm!: (value: any) => void, resolveStart!: (value: any) => void;
  const timers: any[] = [];
  app.isPackaged = packaged;
  app.setPath = app.setName = () => {}; app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve(); app.getVersion = () => 'synthetic'; app.quit = () => events.quit++;
  const dialog = { showErrorBox: (...a: unknown[]) => events.errors.push(a), showMessageBox: (...args: unknown[]) => { events.prompts.push(args); return new Promise(r => resolveConfirm = r); } };
  class BrowserWindow extends EventEmitter {
    webContents: any = new EventEmitter();
    constructor() { super(); browserWindow = this; this.webContents.mainFrame = { url: 'http://127.0.0.1:54321/' }; this.webContents.setWindowOpenHandler = () => {}; this.webContents.reload = () => events.reloads++;  }
    loadURL() { return Promise.resolve(); } show() { events.shown++; } focus() {} hide() {}
    isDestroyed() { return false; }
    setIcon(icon: string) { events.icons.push(icon); }
  }
  class Tray { setToolTip() {} setContextMenu() {} on() {} destroy() {} }
  let headersHandler:Function,permissionRequest:Function,permissionCheck:Function;
  const headersFor=(url:string,headers:Record<string,string[]>)=>{let result:any;headersHandler({url,responseHeaders:headers},(value:any)=>{result=value.responseHeaders;});return result;};
  const handlers=new Map<string,Function>();
  const ipcMain=Object.assign(new EventEmitter(),{handle:(channel:string,handler:Function)=>handlers.set(channel,handler)});
  const electron = { app, BrowserWindow, nativeTheme, Menu: { setApplicationMenu: (m: any) => menu = m, buildFromTemplate: (m: any) => m }, Tray, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) }, dialog, shell: {}, session: { defaultSession: { cookies: { set: () => Promise.resolve() }, setPermissionRequestHandler(handler:Function) {permissionRequest=handler;}, setPermissionCheckHandler(handler:Function) {permissionCheck=handler;}, webRequest: { onHeadersReceived(_filter:unknown,handler:Function) {headersHandler=handler;} } } }, ipcMain };
  (electron.session as any).fromPartition=()=>electron.session.defaultSession;
  const service = { child, origin: 'http://127.0.0.1:54321' };
  const commandCalls:string[]=[];
  const runtime = { RuntimeShutdownTimeout: Error, readRuntimeBuild: () => packaged ? { version: '1.0.0', commit: 'a'.repeat(40) } : undefined, desktopCliStatus:()=>{commandCalls.push('status');return {installed:false};},installDesktopCli:()=>{commandCalls.push('install');return {installed:true};},resolveDesktopHome: () => '/private/tmp/synthetic', desktopEnvironment: () => ({}), loginShellPath: () => '', assertHomeAvailable() {}, prepareDesktopHome() {}, connectOrStartService: (_options: any) => { return pending ? new Promise(r => resolveStart = r) : Promise.resolve(service); }, stopBackgroundService: async () => { events.stop++; child.exitCode = 0; child.emit('exit', 0); }, forceStopService: async () => {}, allowedNavigation: (url: string, origin: string) => url.startsWith(origin + '/'), readDesktopPreferences:()=>({...preferences}),writeDesktopPreference:(_home:string,key:string,value:string)=>{if(key==='unknown')throw Error('Invalid key');preferences[key]=value;},readDesktopAppearance: () => appearance, writeDesktopAppearance: (_home: string, value: string) => { if (value === 'invalid') throw Error('Invalid appearance'); appearance = value; } };
  vm.runInNewContext(source, { require: (p: string) => p === 'electron' ? electron : p === './runtime.cjs' ? runtime : p === './updates.cjs' ? require('../desktop/updates.cjs') : require(p), __dirname: '/private/tmp/synthetic', fetch:async()=>({ok:true,json:async()=>({partition:'signin',home:'/private/tmp/synthetic'})}), process: { platform, arch: 'arm64', resourcesPath: '/private/tmp/synthetic' }, console, setImmediate, URL, setTimeout: (_fn: Function, delay: number) => { const timer = { delay, unref() {}, cleared: false }; timers.push(timer); return timer; }, setInterval: (_fn: Function, delay: number) => { const timer = { delay, unref() {}, cleared: false }; timers.push(timer); return timer; }, clearTimeout: (timer: any) => { timer.cleared = true; }, clearInterval: (timer: any) => { timer.cleared = true; } });
  await tick(); await tick();
  const appearanceRequest = (request: unknown, override = {}) => { const event = { sender: browserWindow.webContents, senderFrame: browserWindow.webContents.mainFrame, returnValue: undefined, ...override }; electron.ipcMain.emit('mandala:appearance', event, request); return event.returnValue; };
  const preferenceRequest=(request:unknown,override={})=>{const event={sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,returnValue:undefined,...override};electron.ipcMain.emit('mandala:preferences',event,request);return event.returnValue;};
  const cliRequest=(request:unknown,override={})=>handlers.get('mandala:cli')!({sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,...override},request);
  const directoryRequest=(path:unknown,override={})=>{const event={sender:browserWindow.webContents,senderFrame:browserWindow.webContents.mainFrame,returnValue:undefined,...override};electron.ipcMain.emit('mandala:directory-path',event,path);return event.returnValue;};
  return { timers, menu: () => menu, permission: (types:string[],main=true,url=browserWindow.webContents.mainFrame.url) => {let allowed=false;permissionRequest(browserWindow.webContents,'media',(value:boolean)=>allowed=value,{mediaTypes:types,isMainFrame:main,requestingUrl:url});return allowed;}, permissionCheck: (type:string,main=true,url=browserWindow.webContents.mainFrame.url) => permissionCheck(browserWindow.webContents,'media',url,{mediaType:type,isMainFrame:main,requestingUrl:url}), headersFor, crash: (reason='crashed',exitCode=139) => browserWindow.webContents.emit('render-process-gone', {}, {reason,exitCode}), directoryRequest, app, child, events, appearanceRequest, preferenceRequest, cliRequest, commandCalls, mainFrame: browserWindow?.webContents.mainFrame, unload: (preventDefault: () => void) => browserWindow.webContents.emit('will-prevent-unload', { preventDefault }), quit: () => menu[0].submenu.find((x: any) => x.label === 'Quit Mandala').click(), stop: () => menu[0].submenu.find((x: any) => x.label === 'Stop runtime and quit…').click(), confirm: (response: number) => resolveConfirm({ response }), ready: () => resolveStart(service) };
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
  expect(f.events.stop).toBe(1); expect(f.events.quit).toBe(1);
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
 for(const path of ['/api/conversations/chat/local-file/preview?href=report.html','/api/conversations/chat/workspace-file/preview?path=report.htm'])expect(f.headersFor('http://127.0.0.1:54321'+path,{'content-security-policy':[sandbox]})).toEqual({'content-security-policy':[sandbox]});
 for(const path of ['/','/api/conversations/chat/local-file','/api/conversations/chat/attachments/preview'])expect(f.headersFor('http://127.0.0.1:54321'+path,{'content-security-policy':[sandbox]})['Content-Security-Policy']).toEqual([expect.stringContaining("script-src 'self'")]);
 expect(f.headersFor('http://127.0.0.1:54321/api/conversations/chat/local-file/preview',{})['Content-Security-Policy']).toEqual([expect.stringContaining("script-src 'self'")]);
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
