import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import { createRequire } from 'node:module';
const {connectService,stopBackgroundService}=createRequire(import.meta.url)('../desktop/.app/runtime.cjs');

// A real installed-shell regression, using only synthetic preferences and an isolated HOME.
const appPath = resolve(process.argv[2]);
const executablePath = process.platform === 'win32' ? join(appPath, 'Mandala.exe') : join(appPath, 'Contents/MacOS/Mandala');
const home = join(await mkdtemp(join(tmpdir(), 'mandala-appearance-restart-')), 'data');
let application, blocker, currentPage, failed=false;
const origins = [];
let scheduleCheckpoint;
const artifactDirectory = process.env.MANDALA_SMOKE_OUTPUT ?? join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mandala-appearance-smoke-' + Date.now());
async function launch() {
  application = await electron.launch({ executablePath, env: { ...process.env, MANDALA_HOME: home, OPEN_MANA_HOME: home }, timeout: 30000 });
  const page = await application.firstWindow(); currentPage=page; await page.waitForLoadState('domcontentloaded');
  // Playwright defaults to emulated light; use the real OS preference for System mode.
  await page.emulateMedia({colorScheme:null});
  console.log(JSON.stringify({phase:'launched',origin:new URL(page.url()).origin}));
  page.on('dialog',dialog=>dialog.accept().catch(error=>console.error('Dialog already closed:',error.message)));
  await application.evaluate(({app,BrowserWindow,nativeImage})=>{
    const target=process.platform==='darwin'?app.dock:BrowserWindow.getAllWindows()[0],setIcon=target.setIcon.bind(target);
    globalThis.appThemeIcons=[];
    target.setIcon=path=>{setIcon(path);const bitmap=nativeImage.createFromPath(path);globalThis.appThemeIcons.push({path,background:[...bitmap.toBitmap().subarray((512*1024+128)*4,(512*1024+128)*4+4)]});};
  });
  origins.push(new URL(page.url()).origin);
  return page;
}
async function expectIcon(variant){
  await expect.poll(()=>application.evaluate(()=>globalThis.appThemeIcons.at(-1)),{timeout:5000}).toMatchObject({path:expect.stringMatching(new RegExp('icon-'+variant+'\\.png$')),background:variant==='light'?[255,255,255,255]:[28,25,25,255]});
}
// Electron page zoom changes Chromium's layout viewport. CSS `zoom` is a different, upstream-limited coordinate model.
async function verifyNativeZoom(page, origin) {
  const fixture = await page.evaluate(async home => {
    const post = async (path, body) => {
      const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      if (!response.ok) throw Error('Native zoom fixture: ' + path + ' ' + response.status);
      return response.json();
    };
    const {config,revision}=await(await fetch('/api/config')).json(),agentId='desktop-smoke-executor';
    const configured=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,config:{...config,agents:[...config.agents.filter(agent=>agent.id!==agentId),{id:agentId,name:'Desktop smoke executor',defaultCli:'codex',models:{},instructions:'Synthetic smoke',mcp:[],skills:[]}]}})});if(!configured.ok)throw Error('Cannot configure smoke Agent');
    const chats = [await post('conversations', { cwd: home, workspaceId: null,agentId }), await post('conversations', { cwd: home, workspaceId: null,agentId })];
    let task=await post('v2/tasks',{goal:'Verify native desktop zoom'});for(const chat of chats)task=await post('v2/tasks/'+task.id+'/executions',{conversationId:chat.id,expectedRevision:task.revision});
    return {chats,task};
  }, home);
  const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const records = [];
  const setZoom = async factor => {
    assert.equal(await application.evaluate(({ BrowserWindow }, factor) => { const contents = BrowserWindow.getAllWindows()[0].webContents; contents.setZoomFactor(factor); return contents.getZoomFactor(); }, factor), factor);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).zoom), '1');
  };
  const geometry = async locator => {
    const value = await locator.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    assert.ok(value.rect.left >= -1 && value.rect.top >= -1 && value.rect.right <= value.width + 1 && value.rect.bottom <= value.height + 1, 'Native zoom popup must remain inside the layout viewport');
    return value;
  };
  try {
    for (const width of [1024, 768]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 950), width);
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()[0])).toBe(width);
      for (const factor of [1, 1.25]) {
        await page.goto(origin + '/schedules'); await setZoom(factor);
        const trigger = page.getByRole('button', { name: /^(用户菜单|User menu)$/, exact: true });
        await trigger.click(); const menu = page.getByRole('menu'); await expect(menu).toBeVisible(); const menuGeometry = await geometry(menu);
        await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
        await trigger.click(); await page.getByRole('menuitem', { name: /^(设置|Settings)$/, exact: true }).click(); await expect(page).toHaveURL(/\/settings\/general$/);
        await page.goto(origin + '/tasks/' + fixture.task.id); await setZoom(factor);
        const select = page.getByRole('combobox', { name: /^(目标对话|Target Chat)$/, exact: true });
        await select.click(); const list = page.getByRole('listbox', { name: /^(目标对话|Target Chat)$/, exact: true }); await expect(list).toBeVisible(); const selectGeometry = await geometry(list);
        await list.evaluate(element => Promise.all(element.closest('[data-slot=popover-content]')?.getAnimations().map(animation => animation.finished.catch(() => {})) ?? []));
        const image = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        await mkdir(artifactDirectory, { recursive: true }); await writeFile(join(artifactDirectory, `native-zoom-${width}-${factor}.png`), Buffer.from(image, 'base64'));

        await page.keyboard.press('Escape'); await expect(list).toHaveCount(0); await expect(select).toBeFocused();
        await select.click(); await page.locator('[role=option][data-value="' + fixture.chats[1].id + '"]').click(); await expect(select).toHaveAttribute('data-value', fixture.chats[1].id);
        records.push({ width, factor, menuGeometry, selectGeometry });
      }
    }
    await writeFile(join(artifactDirectory, 'native-zoom.json'), JSON.stringify(records, null, 2));
    return records;
  } finally {
    await application.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setBounds(bounds); }, originalBounds);
    await page.goto(origin + '/settings/general');
  }
}
async function stop() {
  if (!application) return;
  console.log(JSON.stringify({phase:'stopping',ui:await currentPage.evaluate(()=>({path:location.pathname,language:document.documentElement.lang,saving:document.querySelector('.settings-autosave')?.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)}))}));
  const frontend = application.process();
  await application.evaluate(({ dialog, Menu }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Stop runtime and quit…').click();
  });
  await expect.poll(() => frontend.exitCode ?? frontend.signalCode, { timeout: 40000 }).not.toBeNull();
  application = undefined;
}
// A terminal synthetic receipt keeps this restart check entirely off real
// providers. The first intercepted UI request supplies its actual command key;
// only an exact replay is ever forwarded to the runtime after restart.
async function prepareUnknownSchedule(page, origin) {
  const rule=await page.evaluate(async()=>{
    const {config}=await(await fetch('/api/config')).json(),agent=config.agents.find(agent=>agent.id===config.mandala.agentId);
    const response=await fetch('/api/automations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic restart checkpoint',instructions:'Synthetic terminal receipt; never execute',projectId:'',agentId:agent.id,cli:agent.defaultCli,workspaceId:null,executionMode:'independent',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}})});
    if(!response.ok)throw Error('Unable to create isolated checkpoint rule: '+response.status);return response.json();
  });
  const receiptId='synthetic-restart-receipt';let commandKey;
  await page.route('**/api/automations/'+rule.id+'/run',async route=>{
    commandKey=route.request().headers()['idempotency-key'];assert.ok(commandKey);
    const database=new DatabaseSync(join(home,'state.sqlite'));
    try{const at=new Date().toISOString();database.prepare("INSERT INTO automation_occurrences(id,automation_id,scheduled_at,command_key,task_id,disposition,data) VALUES(?,?,NULL,?,NULL,'interrupted',?)").run(receiptId,rule.id,commandKey,JSON.stringify({id:receiptId,automationId:rule.id,name:rule.name,projectId:'',agentId:rule.agentId,cli:rule.cli,instructions:'Synthetic terminal receipt; never execute',createdAt:at,scheduledAt:at,status:'interrupted'}));}
    finally{database.close();}
    const response=await route.fetch();assert.equal((await response.json()).id,receiptId);await route.abort('failed');
  });
  await page.goto(origin+'/schedules?schedule='+rule.id);
  await page.getByRole('article',{name:rule.name,exact:true}).getByRole('button',{name:/^(Run once|运行一次)$/,exact:true}).click();
  await expect(page.getByRole('button',{name:/^(Check previous run|核对上次执行)$/,exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/Run was not confirmed|尚未确认执行结果/);
  return {ruleId:rule.id,receiptId,commandKey,terminalFixture:true};
}
async function verifyUnknownSchedule(page, origin) {
  const {ruleId,receiptId,commandKey}=scheduleCheckpoint;let checkedKey;
  await page.route('**/api/automations/'+ruleId+'/run',async route=>{
    checkedKey=route.request().headers()['idempotency-key'];
    if(checkedKey!==commandKey){await route.abort('failed');throw Error('Native checkpoint lost the original command key; refusing any new enqueue');}
    await route.continue();
  });
  await page.goto(origin+'/schedules?schedule='+ruleId);
  await page.getByRole('button',{name:/^(Check previous run|核对上次执行)$/,exact:true}).click();
  await expect.poll(()=>checkedKey).toBe(commandKey);
  await expect(page.getByRole('article',{name:'Synthetic restart checkpoint',exact:true}).getByRole('button',{name:/^(Run once|运行一次)$/,exact:true})).toBeEnabled();
  const runs=await page.evaluate(async id=>(await(await fetch('/api/automations')).json()).runs.filter(run=>run.automationId===id),ruleId);
  assert.equal(runs.length,1);assert.equal(runs[0].id,receiptId);
  const database=new DatabaseSync(join(home,'state.sqlite'),{readOnly:true});
  try{assert.equal(database.prepare('SELECT COUNT(*) n FROM automation_occurrences WHERE automation_id=?').get(ruleId).n,1);}finally{database.close();}
  scheduleCheckpoint={...scheduleCheckpoint,verifiedOrigin:origin,originalKeyReplayed:true,occurrenceCount:1};
}
try {
  let page = await launch();
  const token = await page.evaluate(() => fetch('/auth/session').then(r => r.json()).then(r => r.setup.token));
  const owner = await page.evaluate(token => fetch('/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token }, body: JSON.stringify({ username: 'appearance-test', password: 'synthetic-appearance-password' }) }).then(r => r.status), token);
  assert.equal(owner, 201);
  await page.evaluate(() => localStorage.setItem('mana-language', 'en'));
  await page.goto(origins[0] + '/settings/general');
  await page.getByRole('button', { name: 'Catppuccin Latte', exact: true }).click();
  await page.getByRole('button', { name: 'Dark palettes', exact: true }).click();
  await page.getByRole('button', { name: 'Nord Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'catppuccin-latte');
  await expectIcon('light');
  const systemVariant=await application.evaluate(({nativeTheme})=>nativeTheme.shouldUseDarkColors?'dark':'light');
  for(const [name,variant] of [['System',systemVariant],['Dark','dark'],['Light','light']]){
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',variant);await expectIcon(variant);
  }
  await page.getByRole('radio', { name: '简体中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect.poll(()=>page.evaluate(async()=>(await(await fetch('/api/config')).json()).config.system?.memory?.language)).toBe('zh-CN');
  await expect(page.locator('.settings-autosave')).toContainText(/所有修改已保存|All changes saved/);
  await page.evaluate(() => {
    const values = {'mana-sidebar-layout':JSON.stringify({collapsed:false,width:318}),'mana-progress-view':'list','mana-team-view-v2':'agents','mana-content-width':'518'};
    for(const [key,value] of Object.entries(values)) {
      const bridge=window.mandalaDesktop?.preferences;
      if(bridge)bridge.write(key,value);else localStorage.setItem(key,value);
    }
  });
  await page.reload();
  await expect(page.locator('.settings-autosave')).toContainText(/所有修改已保存|All changes saved/);
  scheduleCheckpoint=await prepareUnknownSchedule(page,origins[0]);
  await page.goto(origins[0]+'/');
  await stop();
  // Occupy the old port so the next cold start must use a different origin.
  blocker = createServer((_req, res) => res.end('Unrelated synthetic port owner'));
  blocker.listen(Number(new URL(origins[0]).port), '127.0.0.1'); await once(blocker, 'listening');
  page = await launch();
  assert.notEqual(origins[1], origins[0]);
  await verifyUnknownSchedule(page,origins[1]);
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'catppuccin-latte');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.sidebar')).toHaveCSS('width','318px');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#eff1f5');
  await page.goto(origins[1] + '/settings/general');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord-dark');
  await expectIcon('dark');
  await expect(page.locator('.settings-autosave')).toContainText(/所有修改已保存|All changes saved/);
  await page.goto(origins[1]+'/');
  await stop();
  page = await launch();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord-dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#2e3440');
  await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
  await expect(page.locator('.sidebar')).toHaveCSS('width','318px');
  const preferences=JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).values;
  assert.equal(preferences['mana-language'],'zh-CN');assert.equal(preferences['mana-progress-view'],'list');assert.equal(preferences['mana-team-view-v2'],'agents');assert.equal(preferences['mana-content-width'],'518');
  const persisted = JSON.parse(await readFile(join(home, 'desktop-appearance.json'), 'utf8'));
  assert.equal(persisted.light, 'catppuccin-latte'); assert.equal(persisted.dark, 'nord-dark'); assert.equal(persisted.mode, 'dark');
  const nativeZoom = await verifyNativeZoom(page, origins.at(-1));
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: join(artifactDirectory, 'desktop-appearance-restart.png') });
  const result = { appPath, home, artifactDirectory, origins, nativeZoom, lightPalette: persisted.light, darkPalette: persisted.dark, paletteAndColorsSurvivedColdStarts: true, uiSelectionUpdatesNativeIcon:true, independentOfRuntimePort: true, languageLayoutAndUnopenedViewPreferencesRetained: true, scheduleCheckpoint };
  await writeFile(join(artifactDirectory, 'desktop-appearance-restart.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch(error) {
  failed=true;console.error('Primary smoke failure:',error);throw error;
} finally {
  if(failed&&application){
    await application.evaluate(({app})=>app.exit(1)).catch(()=>{});application=undefined;
    try{const service=await connectService(home);if(service)await stopBackgroundService(service);}catch(cleanupError){console.error('Synthetic runtime cleanup failed:',cleanupError);}
  } else await stop();
  if (blocker) await new Promise(resolve => blocker.close(resolve));
}
