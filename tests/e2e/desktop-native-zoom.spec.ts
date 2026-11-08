import {createTaskWithExecutionChats,executionAgent} from './helpers/task-executions';
import {test,expect,_electron as electron,type Page,type Locator} from '@playwright/test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';

type ZoomWindow=Window&{zoomHarness:{setFactor:(factor:number)=>void;factor:()=>number}};
async function zoom(page:Page,factor:number){await page.evaluate(factor=>(window as unknown as ZoomWindow).zoomHarness.setFactor(factor),factor);await expect.poll(()=>page.evaluate(()=>(window as unknown as ZoomWindow).zoomHarness.factor())).toBe(factor);expect(await page.evaluate(()=>getComputedStyle(document.documentElement).zoom)).toBe('1');}
async function inViewport(locator:Locator){const geometry=await locator.evaluate(element=>({rect:element.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));expect(geometry.rect.left).toBeGreaterThanOrEqual(-1);expect(geometry.rect.top).toBeGreaterThanOrEqual(-1);expect(geometry.rect.right).toBeLessThanOrEqual(geometry.width+1);expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.height+1);return geometry;}
for(const width of [1024,768])test(`native desktop page zoom keeps Menu, Select and nested focus usable at ${width}px`,async({request,baseURL},testInfo)=>{
 test.setTimeout(90000);
 test.skip(!process.env.MANDALA_ELECTRON_EXECUTABLE,'Requires an explicit Electron test executable; CSS zoom is not a substitute for this desktop gate.');
 const root=await mkdtemp('/tmp/mandala-native-zoom-');await mkdir(join(root,'home'));
 await writeFile(join(root,'preload.cjs'),`const{contextBridge,webFrame}=require('electron');contextBridge.exposeInMainWorld('zoomHarness',{setFactor:value=>webFrame.setZoomFactor(value),factor:()=>webFrame.getZoomFactor()});`);
 await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');const{join}=require('node:path');app.setPath('userData',join(__dirname,'browser'));app.whenReady().then(async()=>{const w=new BrowserWindow({width:${width},height:950,useContentSize:true,show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL(${JSON.stringify(baseURL+'/schedules')});});app.on('window-all-closed',()=>app.quit());`);
 const agentId=await executionAgent(request);const chats=[];for(let index=0;index<2;index++){const response=await request.post('/api/conversations',{data:{cwd:root,workspaceId:null,agentId}});expect(response.ok()).toBe(true);chats.push(await response.json());}
 const created=await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Native zoom selection '+width}},chats.map(chat=>chat.id));expect(created.ok()).toBe(true);const task=await created.json();
 const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),HOME:join(root,'home'),MANDALA_HOME:join(root,'data'),OPEN_MANA_HOME:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
 const application=await electron.launch({executablePath:process.env.MANDALA_ELECTRON_EXECUTABLE,args:[join(root,'main.cjs')],env,timeout:30000});
 try{
  const page=await application.firstWindow();await page.evaluate(()=>localStorage.setItem('mana-language','en'));const evidence=[];
  for(const factor of [1,1.25]){
   await page.goto(baseURL+'/schedules');await zoom(page,factor);
   const userMenu=page.getByRole('button',{name:'User menu',exact:true});await userMenu.click();const menu=page.getByRole('menu');await expect(menu).toBeVisible();const menuGeometry=await inViewport(menu);
   await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(userMenu).toBeFocused();await userMenu.click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();await expect(page).toHaveURL(/\/settings\/general$/);
   await page.goto(baseURL+'/tasks/'+task.id);await zoom(page,factor);const target=page.getByRole('combobox',{name:'Target Chat',exact:true});await target.click();const list=page.getByRole('listbox',{name:'Target Chat',exact:true});await expect(list).toBeVisible();const selectGeometry=await inViewport(list);await list.evaluate(element=>Promise.all(element.closest('[data-slot=popover-content]')?.getAnimations().map(animation=>animation.finished.catch(()=>{}))??[]));const pixels=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(testInfo.outputPath(`native-${width}-${factor}-select.png`),Buffer.from(pixels,'base64'));
   await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await expect(target).toBeFocused();await target.click();await page.locator('[role=option][data-value="'+chats[1].id+'"]').click();await expect(target).toHaveAttribute('data-value',chats[1].id);
   await page.goto(process.env.MANDALA_NATIVE_UI_CATALOG_URL??baseURL+'/ui.html');await zoom(page,factor);await page.getByRole('button',{name:'打开对话框',exact:true}).click();const outer=page.getByRole('dialog',{name:'外层示例'});
   const nestedSelect=outer.getByRole('combobox',{name:'弹窗选项'}),nestedMenu=outer.getByRole('button',{name:'弹窗菜单'});
   for(let attempt=0;attempt<3;attempt++){
    await nestedSelect.click();await inViewport(page.getByRole('listbox',{name:'弹窗选项'}));await page.keyboard.press('Escape');await expect(outer).toBeVisible();await expect(nestedSelect).toBeFocused();
    await nestedMenu.click();await inViewport(page.getByRole('menu'));await page.keyboard.press('Escape');await expect(outer).toBeVisible();await expect(nestedMenu).toBeFocused();
   }
   await page.keyboard.press('Escape');await expect(outer).toHaveCount(0);await expect(page.getByRole('button',{name:'打开对话框',exact:true})).toBeFocused();evidence.push({factor,menuGeometry,selectGeometry});
  }
  await testInfo.attach('native-zoom-geometry',{body:Buffer.from(JSON.stringify(evidence,null,2)),contentType:'application/json'});
 }finally{await application.close();await rm(root,{recursive:true,force:true});}
});
