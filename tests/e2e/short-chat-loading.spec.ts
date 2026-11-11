import {test,expect} from './helpers/execution-fixture';

for(const entry of ['cold','switch','mandala'])test(entry+' shows short history before starting auxiliary reads',async({page,request})=>{
 const conversation=entry==='mandala'?(await(await request.get('/api/mandala')).json()).conversation:
  await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}})).json();
 if(entry==='switch'){
  conversation.title='Short greeting';
  expect((await request.patch('/api/conversations/'+conversation.id,{data:{title:conversation.title}})).ok()).toBe(true);
  const initialModels=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/models');
  const initialStatus=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/cli/status');
  await page.goto('/mandala');
  await Promise.all([initialModels,initialStatus]);
  await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();
 }
 const ancillary:string[]=[];
 let releaseHistory!:()=>void,releaseAuxiliary!:()=>void;
 const history=new Promise<void>(resolve=>releaseHistory=resolve),auxiliary=new Promise<void>(resolve=>releaseAuxiliary=resolve);
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(['/api/models','/api/cli/status','/api/v2/tasks','/api/conversation-progress','/api/mandala/goals','/api/automations'].includes(path)||new RegExp('/'+conversation.id+'/(references|environment|reference-summary|results)$').test(path)){
   ancillary.push(path);await auxiliary;await route.continue();return;
  }
  await route.fallback();
 });
 await page.route('**/api/conversations/'+conversation.id+'/events?*',async route=>{
  await history;
  const events=[{id:1,conversationId:conversation.id,kind:'user',data:{text:'hi'},createdAt:'2026-11-11T00:00:00Z'},
   {id:2,conversationId:conversation.id,kind:'text',data:{text:'Hello from a short conversation'},createdAt:'2026-11-11T00:00:01Z'}];
  await route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'event: history-ready\ndata: {}\n\n'});
 });
 const detail=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/conversations/'+conversation.id);
 try{
  if(entry==='switch'){
   // Exercise the same sidebar navigation as reopening an existing short chat.
   await page.getByRole('button',{name:conversation.title,exact:true}).click();
  }else await page.goto((entry==='mandala'?'/mandala':'/')+'?conversation='+conversation.id);
  await detail;
  await expect(page.getByText('正在读取对话历史…',{exact:true})).toBeVisible();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(ancillary).toEqual([]);
  const start=Date.now();releaseHistory();
  await expect(page.locator('.messages').getByText('hi',{exact:true})).toBeVisible();
  await expect(page.locator('.messages').getByText('Hello from a short conversation',{exact:true})).toBeVisible();
  test.info().annotations.push({type:'history-release-to-content-ms',description:String(Date.now()-start)});
  await expect.poll(()=>ancillary.length).toBeGreaterThan(0);
 }finally{releaseHistory();releaseAuxiliary();}
});

test('manual CLI diagnostics remain available while history is waiting',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}})).json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let checks=0;
 await page.route('**/api/conversations/'+chat.id+'/events?*',async route=>{await held;await route.fulfill({contentType:'text/event-stream',body:'event: history-ready\ndata: {}\n\n'});});
 await page.route('**/api/cli/status?*',async route=>{checks++;await route.fulfill({json:{status:'ready',version:'synthetic'}});});
 try{
  await page.goto('/?conversation='+chat.id);
  await expect(page.getByText('正在读取对话历史…',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'执行端状态',exact:true}).click();
  await expect.poll(()=>checks).toBe(1);
  await expect(page.getByRole('dialog',{name:'执行端状态'}).getByText('已连接',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新检测',exact:true}).click();
  await expect.poll(()=>checks).toBe(2);
  await expect(page.getByText('正在读取对话历史…',{exact:true})).toBeVisible();
 }finally{release();}
});
