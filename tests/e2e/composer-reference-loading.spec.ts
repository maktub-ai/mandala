import { test, expect } from '@playwright/test';
import { storedUiState } from './helpers/preferences';
import { defaultPreferences } from '../../src/themes';

test.use({storageState:storedUiState('en')});
test.beforeEach(async({request})=>{
 const {revision,config}=await(await request.get('/api/config')).json();
 const response=await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents.filter((agent:{id:string})=>agent.id!=='reference-loading'),{id:'reference-loading',name:'Reference loading',instructions:'Synthetic input test',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}});
 expect(response.ok(),await response.text()).toBe(true);
});
test('opening slash references reuses the loaded catalog while the service is slow',async({page},testInfo)=>{
 let requests=0;
 await page.route('**/api/composer-references?*',async route=>{
  requests++;
  if(requests===1)await route.fulfill({json:{items:[{id:'command:'+'a'.repeat(64),kind:'command',name:'task',source:'/task',detail:'Create a task',status:'available'}]}});
  else await route.abort();
 });
 await page.goto('/?agent=reference-loading');
 await expect.poll(()=>requests).toBe(1);
 const input=page.getByRole('textbox',{name:'Message',exact:true});await expect(input).toBeEnabled();
 await input.fill('/');await input.click();
 await expect(page.getByRole('option',{name:/^Create task/})).toBeVisible();
 await expect(page.getByText('Loading references…',{exact:true})).toHaveCount(0);
 await input.fill('');await input.fill('/');
 await expect(page.getByRole('option',{name:/^Create task/})).toBeVisible();
 expect(requests).toBe(1);
 for(const [mode,width] of [['light',1280],['dark',1280],['dark',390]] as const){
  await page.evaluate(value=>{localStorage.setItem('mandala-appearance-v1',value);dispatchEvent(new StorageEvent('storage',{key:'mandala-appearance-v1',newValue:value}));},JSON.stringify({...defaultPreferences(),mode}));
  await page.setViewportSize({width,height:850});
  await expect(page.getByRole('option',{name:/^Create task/})).toBeInViewport();
  await page.screenshot({animations:'disabled',path:testInfo.outputPath(`slash-${mode}-${width}.png`)});
 }
});

test('a stalled initial reference load times out and can be retried',async({page})=>{
 await page.clock.install();
 let requests=0,release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/composer-references?*',async route=>{
  if(++requests===1){await stalled;await route.abort().catch(()=>{});}
  else await route.fulfill({json:{items:[{id:'command:'+'a'.repeat(64),kind:'command',name:'task',source:'/task',detail:'Create a task',status:'available'}]}});
 });
 try{
  await page.goto('/?agent=reference-loading');await expect.poll(()=>requests).toBe(1);
  const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('/');await input.click();
  await expect(page.getByRole('listbox',{name:'Context and references',exact:true})).toBeVisible();
  await page.clock.fastForward(11000);
  await input.click();
  await expect(page.getByText('Loading references…',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'Loading references timed out. Please retry.'})).toBeVisible();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByRole('option',{name:/^Create task/})).toBeVisible();
 }finally{release();}
});
