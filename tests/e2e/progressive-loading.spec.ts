import { test, expect } from './helpers/execution-fixture';

for(const entry of ['mandala','chat','remembered'])test(entry+' opens before the sidebar activity lists finish',async({page,request})=>{
 const {config}=await(await request.get('/api/config')).json();
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}})).json();
 await page.route('**/api/mandala',route=>route.fulfill({json:{config,conversation:{...chat,purpose:'mandala-main'}}}));
 if(entry==='remembered')await page.addInitScript(id=>localStorage.setItem('mana-chat',id),chat.id);
 const event={id:1,conversationId:chat.id,kind:'user',data:{text:'Mandala opening request'},createdAt:'2026-10-01T00:00:00.000Z'};
 await page.route('**/api/conversations/'+chat.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(event)+'\n\nevent: history-ready\ndata: {}\n\n'}));
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/tasks?view=control',async route=>{await held;await route.fulfill({json:[]});});
 try{
  await page.goto(entry==='mandala'?'/mandala':entry==='remembered'?'/':'/?conversation='+chat.id);
  await expect(page.getByText('Mandala opening request',{exact:true})).toBeVisible({timeout:3000});
 }finally{release();}
});

test('task cards appear while conversation progress is still loading',async({page,request})=>{
 const created=await request.post('/api/v2/tasks',{data:{goal:'Task visible before progress',acceptance:'human'},headers:{'Idempotency-Key':'loading-task'}});
 expect(created.ok(),await created.text()).toBe(true);
 await page.addInitScript(()=>localStorage.setItem('mana-chat','remembered-chat'));
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/conversation-progress**',async route=>{await held;await route.fulfill({json:[]});});
 await page.route('**/api/tasks?view=control',async route=>{await held;await route.fulfill({json:[]});});
 try{
  await page.goto('/tasks?scope=all');
  await expect(page.getByText('Task visible before progress',{exact:true})).toBeVisible({timeout:3000});
  await page.screenshot({path:test.info().outputPath('tasks-light.png')});
  await page.emulateMedia({colorScheme:'dark'});
  await page.screenshot({path:test.info().outputPath('tasks-dark.png')});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('tasks-narrow.png')});
 }finally{release();}
});

test('an empty task response keeps a loading indicator until progress arrives',async({page})=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v2/tasks',route=>route.fulfill({json:[]}));
 await page.route('**/api/conversation-progress**',async route=>{await held;await route.fulfill({json:[]});});
 try{
  const tasksLoaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v2/tasks');
  await page.goto('/tasks');await tasksLoaded;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.getByText('正在读取进度',{exact:true})).toBeVisible();
  release();
  await expect(page.getByText('正在读取进度',{exact:true})).toHaveCount(0);
  await expect(page.locator('.progress-empty')).toBeVisible();
 }finally{release();}
});

