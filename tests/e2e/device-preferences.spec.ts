import { test, expect } from '@playwright/test';
for (const saved of [null, 'en']) test(`opening the app does not overwrite memory language (saved UI: ${saved})`, async ({ page, request }) => {
 const before=await(await request.get('/api/config')).json();
 const savedConfig=await request.put('/api/config',{data:{revision:before.revision,config:{...before.config,system:{...before.config.system,cli:'codex',memory:{...before.config.system?.memory,language:'zh-CN'}}}}});expect(savedConfig.ok(),await savedConfig.text()).toBe(true);
 const baseline=await(await request.get('/api/config')).json();
 await page.addInitScript(value=>{if(value)localStorage.setItem('mana-language',value);else localStorage.removeItem('mana-language');},saved);
 let writes=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/config'&&req.method()==='PUT')writes++;});
 await page.goto('/');await expect(page.getByLabel('Message',{exact:true})).toBeVisible();
 const after=await(await request.get('/api/config')).json();
 expect(after.config.system.memory.language).toBe('zh-CN');expect(after.revision).toBe(baseline.revision);expect(writes).toBe(0);
 await page.goto('/settings/general');await page.getByRole('radio',{name:'简体中文',exact:true}).click();
 await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.system.memory.language).toBe('zh-CN');
 await page.getByRole('radio',{name:'English',exact:true}).click();
 await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.system.memory.language).toBe('en');
});


test('native preference failure keeps the app usable and offers a working retry',async({page})=>{
 const warnings:string[]=[];page.on('console',message=>{if(message.text().includes('Cannot update a component'))warnings.push(message.text());});
 await page.addInitScript(()=>{
  (window as any).__prefBroken=true;(window as any).__prefValues={};
  Object.defineProperty(window,'mandalaDesktop',{value:{platform:'darwin',preferences:{read:()=>{if((window as any).__prefBroken)throw Error('synthetic native read failure');return {...(window as any).__prefValues};},write:(key:string,value:string)=>{if((window as any).__prefBroken)throw Error('synthetic native write failure');(window as any).__prefValues[key]=value;}}}});
 });
 await page.goto('/');await expect(page.getByLabel('消息',{exact:true})).toBeVisible();
 await expect(page.getByRole('alert')).toContainText('界面偏好暂未保存');
 await page.getByLabel('消息',{exact:true}).fill('Draft remains usable');await expect(page.getByLabel('消息',{exact:true})).toHaveValue('Draft remains usable');
 const retry=page.getByRole('button',{name:'重试',exact:true});
 await retry.evaluate(button=>button.addEventListener('click',()=>{(window as any).__prefBroken=false;},{capture:true,once:true}));await retry.click();
 await expect(page.getByText('界面偏好暂未保存，当前选择仍保留。',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__prefValues['mana-language'])).toBe('zh-CN');expect(warnings).toEqual([]);
});
