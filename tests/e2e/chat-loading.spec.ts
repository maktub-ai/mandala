import { test, expect } from './helpers/execution-fixture';

test('history replay keeps conversation refresh requests bounded',async({page,request,executionDirectory})=>{
 const {revision}=await(await request.get('/api/config')).json();
 const saved=await request.put('/api/config',{data:{revision,config:{version:2,projects:[{id:'performance',name:'Performance',cwd:executionDirectory,resources:[],agentIds:['performance-agent'],mcp:[],skills:[]}],agents:[{id:'performance-agent',name:'Performance',instructions:'Synthetic performance fixture.',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
 const created=await request.post('/api/conversations',{data:{projectId:'performance',agentId:'performance-agent',cli:'codex'}});
 expect(created.ok(),await created.text()).toBe(true);const chat=await created.json();
 let refreshes=0;
 await page.route('**/api/conversations/'+chat.id,async route=>{
  refreshes++;await new Promise(resolve=>setTimeout(resolve,100));await route.fulfill({json:{conversation:chat,approvals:[]}});
 });
 await page.route('**/api/conversations/'+chat.id+'/queue',route=>route.fulfill({json:[]}));
 const events=[{kind:'user',data:{text:'Synthetic history'}},{kind:'text',data:{text:'Synthetic history answer'}},...Array.from({length:250},()=>({kind:'metadata',data:{synthetic:true}})),{kind:'status',data:{status:'idle'}}].map((event,index)=>({...event,id:index+1,conversationId:chat.id,createdAt:'2026-10-01T00:00:00.000Z'}));
 await page.route('**/api/conversations/'+chat.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:events.map(event=>'id: '+event.id+'\ndata: '+JSON.stringify(event)+'\n\n').join('')+'event: history-ready\ndata: {}\n\n'}));
 await page.goto('/?project=performance&conversation='+chat.id);
 await expect(page.getByText('Synthetic history answer',{exact:true})).toBeVisible();
 await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await page.waitForTimeout(300);
 expect(refreshes).toBeLessThanOrEqual(4);
 await page.getByLabel('消息',{exact:true}).fill('Typing still works after replay');
 await expect(page.getByLabel('消息',{exact:true})).toHaveValue('Typing still works after replay');
});

test('keeps native reasoning unmounted until its disclosure opens',async({page,request,executionDirectory})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 const projectId='deferred-reasoning',agentId='deferred-reasoning-agent';
 expect((await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:projectId,name:'Deferred reasoning',cwd:executionDirectory,agentIds:[agentId],resources:[],mcp:[],skills:[]}],agents:[...config.agents,{id:agentId,name:'Deferred reasoning',instructions:'Synthetic fixture',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}})).ok()).toBe(true);
 const chat=await(await request.post('/api/conversations',{data:{projectId,agentId,cli:'codex'}})).json();
 const events=[{kind:'user',data:{text:'Inspect the result'}},{kind:'tool',data:{method:'item/completed',params:{item:{id:'reasoning',type:'reasoning',summary:['Deferred reasoning body']}}}},{kind:'text',data:{text:'Final result'}},{kind:'status',data:{status:'idle'}}].map((event,index)=>({...event,id:index+1,conversationId:chat.id,createdAt:'2026-10-01T00:00:00.000Z'}));
 await page.route('**/api/conversations/'+chat.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(events[0])+'\n\nevent: history-ready\ndata: {}\n\n'}));
 await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);(window as any).__historyStream=this;}};});
 await page.goto('/?conversation='+chat.id);
 await expect(page.getByText('Inspect the result',{exact:true})).toBeVisible();
 await page.evaluate(events=>{for(const event of events)(window as any).__historyStream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)}));},events.slice(1));
 await expect(page.getByText('Final result',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await expect(page.getByText('Deferred reasoning body',{exact:true})).toHaveCount(0);
 await page.locator('.run-reasoning > summary').click();
 await expect(page.getByText('Deferred reasoning body',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'收起本轮过程',exact:true}).click();
 await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await expect(page.getByText('Deferred reasoning body',{exact:true})).toHaveCount(0);
});

test('keeps an unsaved message edit when returning from another page',async({page,request})=>{
 const response=await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}});expect(response.ok()).toBe(true);const chat=await response.json();
 const events=[{kind:'user',data:{text:'Original editable request'}},{kind:'text',data:{text:'Saved answer'}},{kind:'status',data:{status:'idle'}}].map((event,index)=>({...event,id:index+1,conversationId:chat.id,createdAt:'2026-10-01T00:00:00.000Z'}));
 await page.route('**/api/conversations/'+chat.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'event: history-ready\ndata: {}\n\n'}));
 await page.goto('/?conversation='+chat.id);await expect(page.getByText('Saved answer',{exact:true})).toBeVisible();
 await page.locator('.message.user').hover();await page.getByRole('button',{name:'编辑消息',exact:true}).click();
 await page.getByRole('textbox',{name:'修改消息内容',exact:true}).fill('Keep this unsaved edit');
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await expect(page.locator('.task-workspace')).toBeVisible();
 await page.goBack();await expect(page.getByRole('textbox',{name:'修改消息内容',exact:true})).toHaveValue('Keep this unsaved edit');
});

test('keeps a pending approval disabled after visiting another page',async({page,request})=>{
 const response=await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}});expect(response.ok()).toBe(true);const chat=await response.json();
 const approval={id:'pending-approval',method:'item/commandExecution/requestApproval',params:{command:'pwd'}};
 await page.route('**/api/conversations/'+chat.id,route=>route.fulfill({json:{conversation:{...chat,status:'approval'},approvals:[approval]}}));
 const event={id:1,conversationId:chat.id,kind:'user',data:{text:'Pending approval fixture'},createdAt:'2026-10-01T00:00:00.000Z'};
 await page.route('**/api/conversations/'+chat.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(event)+'\n\nevent: history-ready\ndata: {}\n\n'}));
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/conversations/'+chat.id+'/approvals/'+approval.id,async route=>{await held;await route.fulfill({json:{}});});
 try{
  await page.goto('/?conversation='+chat.id);const allow=page.getByRole('button',{name:'允许本次',exact:true});await allow.click();await expect(allow).toBeDisabled();
  await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await expect(page.locator('.task-workspace')).toBeVisible();await page.goBack();
  await expect(page.getByText('Pending approval fixture',{exact:true})).toBeVisible();await expect(allow).toBeDisabled();
 }finally{release();}
});


test('user-only history has no orphan Agent avatars and keeps later execution visible', async ({ page, request }) => {
 const fixture=await(await request.post('/__test__/progress-fixture')).json();
 await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);(window as any).__avatarStream=this;}};});
 await page.goto('/?conversation='+fixture.recent);
 await expect(page.locator('.message.user')).toHaveCount(2);
 await expect(page.locator('.agent-reply')).toHaveCount(0);
 const emit=async(kind:string,data:unknown,id:number)=>page.evaluate(event=>(window as any).__avatarStream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)})),{id,conversationId:fixture.recent,kind,data,createdAt:new Date().toISOString()});
 await emit('status',{status:'running'},1000001);
 await expect(page.locator('.agent-reply')).toHaveCount(1);
 await expect(page.getByText('正在启动执行端',{exact:true})).toBeVisible();
 await emit('status',{status:'approval'},1000002);
 await expect(page.locator('.turn-process-status')).toHaveText('等待审批');
 await emit('error',{message:'Synthetic startup failure'},1000003);
 await emit('status',{status:'error'},1000004);
 await expect(page.locator('.message.error')).toContainText('Synthetic startup failure');
 await expect(page.getByText('本轮未完成',{exact:true})).toBeVisible();
 await emit('user',{text:'Retry after startup failure'},1000005);
 await emit('text',{text:'Synthetic completed answer'},1000006);
 await emit('status',{status:'idle'},1000007);
 await expect(page.locator('.agent-reply')).toHaveCount(2);
 await expect(page.locator('.agent-reply > .message.text')).toContainText('Synthetic completed answer');
});

test('opens ordinary and Mandala chats at the latest page and anchors earlier history on scroll', async ({ page, request }) => {
 const { ordinary, mandala } = await (await request.post('/__test__/chat-history')).json();
 for (const [path, id] of [['/', ordinary], ['/mandala', mandala]]) {
  await page.goto(path + '?conversation=' + id);
  const messages = page.locator('.messages');
  const latest = messages.getByText('History answer 25', { exact: true });
  const first = messages.getByText('History request 21', { exact: true });
  await expect(latest).toBeVisible();
  await expect(messages.getByText('History request 20', { exact: true })).toHaveCount(0);
  const scroller = page.locator('.conversation');
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const historyUrl = (url: URL) => url.pathname === '/api/conversations/' + id + '/history';
  await page.route(historyUrl, async route => { await held; await route.continue(); });
  try {
   await scroller.hover();
   await page.mouse.wheel(0,-5000);
   await expect(page.getByRole('button', { name: '正在加载更早的记录…' })).toBeDisabled();
   const before = (await first.boundingBox())!.y;
   release();
   await expect(messages.getByText('History request 16', { exact: true })).toBeAttached();
   await expect(messages.getByText('History request 15', { exact: true })).toHaveCount(0);
   await expect.poll(async () => Math.abs((await first.boundingBox())!.y - before)).toBeLessThan(3);
   await expect(latest).toHaveCount(1);
  } finally {
   release();
   await page.unroute(historyUrl);
  }
  if (id === ordinary) {
   await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '任务', exact: true }).click();
   await expect(page.locator('.task-workspace')).toBeVisible();
   await page.goBack();
   await expect(latest).toBeVisible();
   await expect(messages.getByText('History request 20', { exact: true })).toHaveCount(0);
   await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);
  }
 }
});


test('find loads earlier history only after it is opened in ordinary and Mandala chats', async ({ page, request }) => {
 const {ordinary,mandala}=await(await request.post('/__test__/chat-history-search')).json();
 for(const [path,id] of [['/',ordinary],['/mandala',mandala]]){
  const reads:string[]=[];
  const record=(req:import('@playwright/test').Request)=>{if(req.url().includes('/'+id+'/history?'))reads.push(req.url());};
  page.on('request',record);
  await page.goto(path+'?conversation='+id);
  await expect(page.getByText('History answer 125',{exact:true})).toBeVisible();
  expect(reads).toHaveLength(0);
  await expect(page.locator('.messages').getByText('History request 1',{exact:true})).toHaveCount(0);
  await page.keyboard.press(await page.evaluate(()=>/Mac/.test(navigator.platform))?'Meta+f':'Control+f');
  await page.getByRole('searchbox',{name:'对话内查找'}).fill('History request 1');
  await expect.poll(async()=>Number((await page.getByTestId('conversation-find-count').innerText()).split('/')[1])).toBeGreaterThanOrEqual(37);
  await expect(page.locator('.messages').getByText('History answer 1',{exact:true})).toBeAttached();
  expect(reads.length).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox',{name:'对话内查找'})).toHaveCount(0);
  page.off('request',record);
 }
});


test('find retries an earlier-history failure and does not carry loading into another chat',async({page,request})=>{
 const {ordinary,mandala}=await(await request.post('/__test__/chat-history')).json();
 let reads=0;
 await page.route('**/api/conversations/'+ordinary+'/history?*',route=>{reads++;return reads===1?route.fulfill({status:503,json:{error:'Temporary history failure'}}):route.continue();});
 await page.goto('/?conversation='+ordinary);
 await expect(page.getByText('History answer 25',{exact:true})).toBeVisible();
 await page.keyboard.press(await page.evaluate(()=>/Mac/.test(navigator.platform))?'Meta+f':'Control+f');
 await page.getByRole('searchbox',{name:'对话内查找'}).fill('History answer 1');
 await page.getByRole('button',{name:'重试读取历史',exact:true}).click();
 await expect(page.getByTestId('conversation-find-count')).toHaveText('1 / 11');
 let otherReads=0;page.on('request',req=>{if(req.url().includes('/'+mandala+'/history?'))otherReads++;});
 await page.getByRole('link',{name:'Mandala',exact:true}).click();
 await expect(page).toHaveURL(/\/mandala/);
 await expect(page.getByRole('searchbox',{name:'对话内查找'})).toHaveCount(0);
 await expect(page.getByText('History answer 25',{exact:true})).toBeVisible();
 expect(otherReads).toBe(0);
});
