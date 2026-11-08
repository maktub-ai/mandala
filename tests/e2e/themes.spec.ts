import { test, expect } from '@playwright/test';
import {chooseOption} from './helpers/select';
import { defaultPreferences, exportThemePackage } from '../../src/themes';
const key='mandala-appearance-v1';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwmHAGAAKAAY2obIySAAAAAElFTkSuQmCC';
test('palette clicks save immediately and system mode follows OS without a save action',async({page})=>{
 await page.goto('/settings/general');
 await page.getByRole('button',{name:'GitHub Light',exact:true}).click();
 expect(JSON.parse((await page.evaluate(key=>localStorage.getItem(key),key))!).light).toBe('github-light');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-palette','github-light');
 await page.getByRole('button',{name:'深色配色',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.getByRole('button',{name:'Nord Dark',exact:true}).click();
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-palette','nord-dark');
 await page.getByRole('button',{name:'跟随系统',exact:true}).click();
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-palette','nord-dark');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-palette','github-light');
 await page.getByRole('button',{name:'Catppuccin Latte',exact:true}).click();
 await page.goto('/tasks');await expect(page.locator('html')).toHaveAttribute('data-palette','catppuccin-latte');
});
test('customization persists independently and invalid import leaves it intact',async({page})=>{
 await page.goto('/settings/general');
 await page.getByRole('button',{name:'自定义外观',exact:true}).click();
 await page.getByLabel('强调色',{exact:true}).fill('#0055aa');
 await page.getByLabel('主题名称',{exact:true}).fill('我的主题');
 await page.getByLabel('界面字号',{exact:true}).fill('16');
 await page.reload(); await expect(page.getByRole('button',{name:'我的主题',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#0055aa');
 const saved=await page.evaluate(key=>localStorage.getItem(key),key);
 await page.getByLabel('导入主题文件').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"format":"mandala-theme","css":"body{display:none}"}')});
 await expect(page.getByRole('alert')).toContainText('无法导入');
 expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(saved);
 await page.getByRole('button',{name:'Mandala Light',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#4f5ae6');
});
test('background import/export saves pixels immediately and removal persists',async({page})=>{
 await page.goto('/settings/general');
 const p=defaultPreferences();p.background={...p.background,image,scope:'app',overlay:45,blur:3};
 await page.getByLabel('导入主题文件').setInputFiles({name:'sample.json',mimeType:'application/json',buffer:Buffer.from(exportThemePackage(p,'light'))});
 await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null')?.background.image,key)).toBe(image);
 await expect(page.locator('html')).toHaveAttribute('data-theme-background','app');
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出',exact:true}).click();const download=await downloadPromise;
 const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream!)chunks.push(chunk);
 expect(JSON.parse(Buffer.concat(chunks).toString()).background).toEqual(p.background);
 await page.getByRole('button',{name:'移除背景',exact:true}).click();
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme-background','none');
 await page.getByLabel('上传背景图片').setInputFiles({name:'bg.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
 await expect(page.getByRole('img',{name:'背景预览'})).toBeVisible();
 await chooseOption(page,'显示区域','chat');
 await page.goto('/'); await expect(page.locator('html')).toHaveAttribute('data-theme-background','chat');
 expect(await page.locator('.theme-chat-surface').evaluate(el=>getComputedStyle(el,'::before').backgroundImage)).toContain('data:image/png');
});
for(const language of ['zh-CN','en'])test('all palettes and expanded settings fit '+language,async({page})=>{
 await page.addInitScript(l=>localStorage.setItem('mana-language',l),language);
 await page.goto('/settings/general');
 for(const width of [1440,390,320]) {
  await page.setViewportSize({width,height:900});
  for(const variant of ['light','dark']) {
   await page.getByRole('button',{name:variant==='light'?(language==='en'?'Light palettes':'浅色配色'):(language==='en'?'Dark palettes':'深色配色'),exact:true}).click();
   const cards=page.locator('.theme-palette');
   for(let i=0;i<await cards.count();i++) {
    await cards.nth(i).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && document.querySelector("main")!.scrollWidth<=document.querySelector("main")!.clientWidth+1)).toBe(true);
   }
  }
 }
 await page.getByRole('button',{name:language==='en'?'Customize appearance':'自定义外观',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && document.querySelector("main")!.scrollWidth<=document.querySelector("main")!.clientWidth+1)).toBe(true);
});
test('browsing the other palette does not change mode; choosing it persists the new mode',async({page})=>{
 await page.emulateMedia({colorScheme:'light'});await page.goto('/settings/general');
 await page.getByRole('button',{name:'深色配色',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.getByRole('button',{name:'Mandala Dark',exact:true}).click();
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.getByRole('button',{name:'跟随系统',exact:true}).click();
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});
test('image decode freezes editing and completion persists the image',async({page})=>{
 await page.addInitScript(()=>{const original=window.createImageBitmap;window.createImageBitmap=((...args:Parameters<typeof createImageBitmap>)=>new Promise(resolve=>setTimeout(()=>resolve((original as Function)(...args)),400)) as ReturnType<typeof createImageBitmap>) as typeof createImageBitmap;});
 await page.goto('/settings/general');
 await page.getByLabel('上传背景图片').setInputFiles({name:'bg.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
 await expect(page.getByRole('button',{name:'GitHub Light',exact:true})).toBeDisabled();
 await expect(page.getByRole('img',{name:'背景预览'})).toBeVisible();
 await page.reload();await expect(page.getByRole('img',{name:'背景预览'})).toBeVisible();
});
test('changing code size in another tab refits the live terminal',async({page,context,request})=>{
 const current=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,runtimes:[...new Set([...(current.config.runtimes??['codex','omp']),'codex'])]}}})).ok()).toBe(true);
 const {directory}=await(await request.post('/__test__/execution-directory')).json();
 const created=await request.post('/api/conversations',{data:{projectId:'',agentId:'',workspaceId:null,cwd:directory,cli:'codex'}});expect(created.ok()).toBe(true);const chat=await created.json();
 const endpoint='/api/conversations/'+chat.id+'/terminal';
 try {
  await page.goto('/?conversation='+chat.id);
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
  await page.locator('#chat-environment-panel').getByRole('tab',{name:'终端',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'终端输入',exact:true})).toBeEnabled();
  const before=(await(await request.get(endpoint)).json()).session;
  const settings=await context.newPage();await settings.goto('/settings/general');
  await settings.getByRole('button',{name:'自定义外观',exact:true}).click();
  await settings.getByRole('slider',{name:'代码字号',exact:true}).press('End');

  await expect.poll(async()=> (await(await request.get(endpoint)).json()).session.cols).toBeLessThan(before.cols);
  await expect.poll(async()=> (await(await request.get(endpoint)).json()).session.rows).toBeLessThan(before.rows);
  await settings.close();
 } finally {const state=(await(await request.get(endpoint)).json()).session;if(state)await request.delete(endpoint,{data:{sessionId:state.id}});}
});

test('saving in another tab invalidates a pending import',async({page,context})=>{
 await page.addInitScript(()=>{const original=window.createImageBitmap;window.createImageBitmap=((...args:Parameters<typeof createImageBitmap>)=>new Promise(resolve=>{(window as any).finishThemeDecode=()=>resolve((original as Function)(...args));}) as ReturnType<typeof createImageBitmap>) as typeof createImageBitmap;});
 await page.goto('/settings/general');
 const other=await context.newPage();await other.goto('/settings/general');
 const p=defaultPreferences();p.background.image=image;
 await page.getByLabel('导入主题文件').setInputFiles({name:'sample.json',mimeType:'application/json',buffer:Buffer.from(exportThemePackage(p,'light'))});
 await expect(page.getByRole('button',{name:'GitHub Light',exact:true})).toBeDisabled();
 await other.getByRole('button',{name:'自定义外观',exact:true}).click();
 await other.getByLabel('强调色',{exact:true}).fill('#0055aa');
 await other.getByLabel('主题名称',{exact:true}).fill('另一窗口的主题');

 await expect(page.getByRole('button',{name:'另一窗口的主题',exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).finishThemeDecode());
 await expect(page.getByRole('button',{name:'GitHub Light',exact:true})).toBeEnabled();
 await page.waitForTimeout(150);
 await expect(page.getByRole('img',{name:'背景预览'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'另一窗口的主题',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('button',{name:'保存外观',exact:true})).toHaveCount(0);
 await other.close();
});

test('automatic theme storage failure retains prior saved appearance and retry persists input',async({page})=>{
 await page.goto('/settings/general');
 await page.getByRole('button',{name:'GitHub Light',exact:true}).click();
 const before=await page.evaluate(key=>localStorage.getItem(key),key);
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='mandala-appearance-v1')throw new DOMException('full','QuotaExceededError');return original.call(this,key,value);};(window as any).restoreStorage=()=>{Storage.prototype.setItem=original;};});
 await page.getByRole('button',{name:'Catppuccin Latte',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('自动保存失败');
 expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(before);
 await expect(page.locator('html')).toHaveAttribute('data-palette','github-light');
 await page.evaluate(()=>(window as any).restoreStorage());await page.getByRole('button',{name:'重试自动保存',exact:true}).click();
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-palette','catppuccin-latte');
});
