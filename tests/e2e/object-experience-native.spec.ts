import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {waitForAutosave} from './helpers/settings';

test('Project and Agent interactions work in native Electron at 100% and 125%',async({request,baseURL},testInfo)=>{
 test.setTimeout(90000);test.skip(!process.env.MANDALA_ELECTRON_EXECUTABLE,'Requires an explicit isolated Electron executable.');
 const snapshot=await(await request.get('/api/config')).json();snapshot.config={version:2,projects:[{id:'native-project',name:'Native Project',background:'Desktop verification',cwd:'/tmp',resources:[],agentIds:['native-agent'],mcp:[],skills:[]}],agents:[{id:'native-agent',name:'Native Agent',instructions:'Desktop role',defaultCli:'codex',models:{},mcp:[],skills:[]}]};expect((await request.put('/api/config',{data:snapshot})).ok()).toBe(true);
 const root=await mkdtemp('/tmp/mandala-objects-native-');await mkdir(join(root,'home'));
 await writeFile(join(root,'preload.cjs'),`const{contextBridge,webFrame}=require('electron');contextBridge.exposeInMainWorld('nativeZoom',{set:value=>webFrame.setZoomFactor(value)});`);
 await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');const{join}=require('node:path');app.setPath('userData',join(__dirname,'browser'));app.whenReady().then(async()=>{const w=new BrowserWindow({width:1024,height:950,useContentSize:true,show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL(${JSON.stringify(baseURL+'/projects/native-project/overview')});});app.on('window-all-closed',()=>app.quit());`);
 const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),HOME:join(root,'home'),MANDALA_HOME:join(root,'data'),OPEN_MANA_HOME:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({executablePath:process.env.MANDALA_ELECTRON_EXECUTABLE,args:[join(root,'main.cjs')],env});
 try{
  const page=await app.firstWindow();await page.evaluate(()=>localStorage.setItem('mana-language','en'));
  for(const factor of [1,1.25]){
   await page.goto(baseURL+'/projects/native-project/overview');await page.evaluate(value=>(window as unknown as {nativeZoom:{set:(n:number)=>void}}).nativeZoom.set(value),factor);
   const switcher=page.getByRole('combobox',{name:'Switch project',exact:true});await switcher.click();await expect(page.getByRole('listbox')).toBeVisible();await page.keyboard.press('Escape');await expect(switcher).toBeFocused();
   const group=page.getByRole('region',{name:'Project background',exact:true});await group.getByRole('button',{name:'Edit',exact:true}).click();await group.getByRole('textbox').fill('Native saved background '+factor);await waitForAutosave(page);await group.getByRole('button',{name:'Done',exact:true}).click();
   await page.getByRole('button',{name:'Add associations',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Native Agent',exact:true})).toBeChecked();await page.keyboard.press('Escape');
   const capture=async(name:string)=>{const pixels=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(testInfo.outputPath(name+'.png'),Buffer.from(pixels,'base64'));};
   await capture('project-native-'+factor);await page.getByRole('link',{name:'Native Agent',exact:true}).click();await expect(page.getByRole('combobox',{name:'Chat project',exact:true})).toHaveAttribute('data-value','native-project');await expect(page.getByRole('tab',{name:'Overview',exact:true})).toBeVisible();await capture('agent-native-'+factor);
   await page.getByRole('button',{name:'Object actions'}).click();await page.getByRole('menuitem',{name:'Edit name and appearance'}).click();const name=page.getByRole('textbox',{name:'Name',exact:true});await name.fill('Native Agent');await expect(name).toBeFocused();await page.keyboard.press('Escape');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
