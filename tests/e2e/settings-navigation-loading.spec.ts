import {test,expect} from '@playwright/test';
import {openUserMenu,openArea} from './helpers/navigation';
import {chooseOption} from './helpers/select';

for(const origin of ['/','/mandala'])test('opening Settings renders before a slow configuration refresh finishes from '+origin,async({page})=>{
 await page.goto(origin);
 const menu=await openUserMenu(page);
 let release!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve);
 let started=false;
 await page.route('**/api/config',async route=>{
  if(route.request().method()!=='GET'){await route.continue();return;}
  started=true;await held;await route.continue();
 });
 try{
  await menu.locator('[data-area="settings"]').click();
  await expect.poll(()=>started).toBe(true);
  await expect(page.locator('.settings-page')).toBeVisible({timeout:1000});
  await expect(page.getByRole('combobox',{name:'默认回答风格',exact:true})).toBeEnabled();
  await expect(page).toHaveURL(/\/settings\/general$/);
 }finally{release();}
});

for(const edit of [false,true])test('a late configuration refresh '+(edit?'preserves a newer edit':'updates the cached settings'),async({page,request})=>{
 await page.goto('/');
 const menu=await openUserMenu(page);
 const saved=await(await request.get('/api/config')).json();
 let release!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/config',async route=>{
  if(route.request().method()!=='GET'){await route.continue();return;}
  await held;await route.fulfill({json:{...saved,config:{...saved.config,responseStyle:'explanatory'}}});
 });
 try{
  await menu.locator('[data-area="settings"]').click();
  const control=page.getByRole('combobox',{name:'默认回答风格',exact:true});
  await expect(control).toBeVisible();
  if(edit)await chooseOption(page,control,'concise');
  const response=page.waitForResponse(res=>res.url().endsWith('/api/config')&&res.request().method()==='GET');
  release();await response;
  // Let the refresh handler and autosave both settle before checking the edit.
  if(edit)await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.responseStyle).toBe('concise');
  await expect(control).toHaveAttribute('data-value',edit?'concise':'explanatory');
 }finally{release();}
});

for(const fails of [false,true])test('leaving Settings ignores a late refresh '+(fails?'failure':'success'),async({page,request})=>{
 await page.goto('/');
 const menu=await openUserMenu(page);
 const saved=await(await request.get('/api/config')).json();
 let release!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/config',async route=>{
  if(route.request().method()!=='GET'){await route.continue();return;}
  await held;await route.fulfill(fails?{status:503,json:{error:'Late configuration failure'}}:{json:saved});
 });
 try{
  await menu.locator('[data-area="settings"]').click();
  await expect(page.locator('.settings-page')).toBeVisible();
  await openArea(page,'任务');
  const response=page.waitForResponse(res=>res.url().endsWith('/api/config')&&res.request().method()==='GET');
  release();await response;
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.locator('.settings-page')).toHaveCount(0);
  await expect(page.getByText('Late configuration failure',{exact:true})).toHaveCount(0);
 }finally{release();}
});
