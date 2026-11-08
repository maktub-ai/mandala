import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
test('Settings and Market retain navigation and focus in native Electron at 100% and 125%',async({request,baseURL},info)=>{
 test.setTimeout(90000);test.skip(!process.env.MANDALA_ELECTRON_EXECUTABLE,'Requires an isolated Electron executable.');
 const root=await mkdtemp('/tmp/mandala-settings-market-');await mkdir(join(root,'home'));
 const snapshot=await(await request.get('/api/config')).json();snapshot.config.agents=[{id:'native-settings',name:'Native settings',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]}];await request.put('/api/config',{data:snapshot});
 await writeFile(join(root,'preload.cjs'),`const{contextBridge,webFrame}=require('electron');contextBridge.exposeInMainWorld('mandalaDesktop',{platform:'darwin'});contextBridge.exposeInMainWorld('nativeZoom',{set:n=>webFrame.setZoomFactor(n)});`);
 await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');const{join}=require('node:path');app.setPath('userData',join(__dirname,'browser'));app.whenReady().then(async()=>{const w=new BrowserWindow({width:1024,height:950,useContentSize:true,show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL(${JSON.stringify(baseURL+'/settings/general?agent=native-settings')});});app.on('window-all-closed',()=>app.quit());`);
 const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),HOME:join(root,'home'),MANDALA_HOME:join(root,'data'),OPEN_MANA_HOME:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
 const application=await electron.launch({executablePath:process.env.MANDALA_ELECTRON_EXECUTABLE,args:[join(root,'main.cjs')],env});
 try{const page=await application.firstWindow();await page.evaluate(()=>localStorage.setItem('mana-language','en'));await page.route('**/auth/session',route=>route.fulfill({json:{mode:'local',user:{id:'native-account',username:'root'},connection:null}}));const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const factor of [1,1.25]){for(const path of ['/settings/general?agent=native-settings','/market']){
  await page.goto(baseURL+path);await page.evaluate(n=>(window as unknown as {nativeZoom:{set:(n:number)=>void}}).nativeZoom.set(n),factor);
  if(path.startsWith('/settings')){await expect(page.getByRole('navigation',{name:'Settings and connections'})).toBeVisible();await expect(page.locator('.theme-settings')).toBeVisible();
   const account=page.getByRole('button',{name:'User menu',exact:true});
   const bounds=await account.evaluate(node=>{const box=node.getBoundingClientRect();return {top:box.top,bottom:box.bottom,children:[...node.querySelectorAll('.sidebar-account-avatar,strong,small')].map(child=>child.getBoundingClientRect().toJSON())};});
   for(const child of bounds.children){expect(child.top).toBeGreaterThanOrEqual(bounds.top);expect(child.bottom).toBeLessThanOrEqual(bounds.bottom);}
   await account.click();await expect(page.getByRole('menuitem',{name:'Account',exact:true})).toBeVisible();await expect(page.getByRole('menuitem',{name:'Command palette',exact:true})).toHaveCount(0);
   await expect(page.getByRole('menu',{name:'User menu',exact:true})).toHaveCSS('opacity','1');
   const menuPixels=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(info.outputPath('account-menu-'+factor+'.png'),Buffer.from(menuPixels,'base64'));
   await page.keyboard.press('Escape');await expect(account).toBeFocused();
   await expect(page.getByRole('button',{name:'Expand sidebar',exact:true})).toHaveCount(0);
   await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
   await expect(page.locator('aside.sidebar')).not.toBeVisible();expect((await page.locator('main').boundingBox())!.x).toBe(0);
   await expect(page.getByRole('button',{name:'Expand sidebar',exact:true})).toHaveCount(1);
   await expect(page.locator('#desktop-titlebar-left').getByRole('button',{name:'Expand sidebar',exact:true})).toBeFocused();
   const collapsedPixels=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(info.outputPath('sidebar-hidden-'+factor+'.png'),Buffer.from(collapsedPixels,'base64'));
   await page.reload();await expect(page.locator('aside.sidebar')).not.toBeVisible();
   await page.locator('#desktop-titlebar-left').getByRole('button',{name:'Expand sidebar',exact:true}).click();await expect(page.locator('aside.sidebar')).toBeVisible();
  }
  else{const card=page.locator('.market-card').first();await expect(card).toBeVisible();await card.click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(card).toBeFocused();await page.getByRole('button',{name:'Manage sources',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');}
  const pixels=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(info.outputPath((path.startsWith('/settings')?'settings':'market')+'-'+factor+'.png'),Buffer.from(pixels,'base64'));
  expect(await page.locator('main').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 }}expect(errors).toEqual([]);
 }finally{await application.close();await rm(root,{recursive:true,force:true});}
});
