import {test,expect} from '@playwright/test';
test('a new conversation starts while another conversation with the same Agent and directory is running',async({page,request})=>{
 const {directory}=await (await request.post('/__test__/execution-directory')).json();
 const initial=await (await request.get('/api/config')).json();
 const saved=await request.put('/api/config',{data:{revision:initial.revision,config:{version:1,projects:[{id:'parallel',name:'Parallel fixture',cwd:directory}],agents:[{id:'worker',name:'Worker',instructions:'Synthetic fixture',defaultCli:'codex',models:{}}]}}});
 expect(saved.ok()).toBe(true);
 const first=await (await request.post('/api/conversations',{data:{projectId:'parallel',agentId:'worker'}})).json();
 expect((await request.post(`/api/conversations/${first.id}/messages`,{data:{text:'hold'}})).ok()).toBe(true);
 try{
  await page.goto('/?project=parallel&agent=worker');
  await page.getByLabel('消息',{exact:true}).fill('Independent new question');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByText('Fixture reply: Independent new question',{exact:true})).toBeVisible();
  await expect(page.getByText('已保存，等待执行',{exact:true})).toHaveCount(0);
  const secondId=new URL(page.url()).searchParams.get('conversation')!;
  const second=await (await request.get(`/api/conversations/${secondId}`)).json();
  const held=await (await request.get(`/api/conversations/${first.id}`)).json();
  expect(second.conversation.cwd).toBe(held.conversation.cwd);
  expect(second.conversation.nativeId).not.toBe(held.conversation.nativeId);
  expect(held.conversation.status).toBe('running');
  expect(await (await request.get(`/api/conversations/${secondId}/queue`)).json()).toMatchObject([{text:'Independent new question',state:'completed'}]);
 }finally{await request.post(`/api/conversations/${first.id}/stop`,{data:{}});}
});
test('busy chat acknowledges a persisted queued message and allows cancellation beside stop',async({page,request})=>{
 const initial=await (await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision:initial.revision,config:{version:1,projects:[{id:'queue',name:'Queue fixture',cwd:''}],agents:[{id:'worker',name:'Worker',instructions:'Synthetic fixture',defaultCli:'codex',models:{}}]}}});
 const {config}=await (await request.get('/api/config')).json();
 const chat=await (await request.post('/api/conversations',{data:{projectId:config.projects[0].id,agentId:config.agents[0].id}})).json();
 await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'hold'}});
 await page.goto(`/?project=${chat.projectId}&conversation=${chat.id}`);
 await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeEnabled();
 await page.getByLabel('消息',{exact:true}).fill('Next queued request');
 await page.getByRole('button',{name:'排队发送',exact:true}).click();
 await expect(page.getByText('当前回复结束后自动发送',{exact:true})).toBeVisible();
 await expect(page.getByLabel('消息',{exact:true})).toHaveValue('');
 await page.reload();await expect(page.getByText('Next queued request',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'取消排队',exact:true}).click();
 await expect(page.getByText('Next queued request',{exact:true})).toHaveCount(0);
 const inputs=await (await request.get(`/api/conversations/${chat.id}/queue`)).json();expect(inputs[0].state).toBe('cancelled');
 const status=await (await request.get(`/api/conversations/${chat.id}`)).json();expect(status.conversation.status).toBe('running');
 await request.post(`/api/conversations/${chat.id}/stop`,{data:{}});
});

test('queued message has its own interrupt and send action with an empty composer',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:''}})).json();await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'hold'}});
 const queued=await(await request.post(`/api/conversations/${chat.id}/queue`,{data:{text:'Queued priority question',commandKey:crypto.randomUUID()}})).json();
 await page.goto(`/?conversation=${chat.id}`);await expect(page.getByLabel('消息',{exact:true})).toHaveValue('');
 await page.getByRole('region',{name:'等待发送',exact:true}).getByRole('button',{name:'打断并发送',exact:true}).click();
 await expect(page.getByText('Fixture reply: Queued priority question',{exact:true})).toBeVisible();
 const inputs=await(await request.get(`/api/conversations/${chat.id}/queue`)).json();expect(inputs.filter((input:{id:string})=>input.id===queued.id)).toHaveLength(1);expect(inputs.find((input:{id:string})=>input.id===queued.id).state).toBe('completed');
});
test('stop current reply automatically starts the next queued user question once',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:''}})).json();await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'hold'}});
 const queued=await(await request.post(`/api/conversations/${chat.id}/queue`,{data:{text:'Next question after stop',commandKey:crypto.randomUUID()}})).json();await page.goto(`/?conversation=${chat.id}`);
 await page.getByRole('button',{name:'停止执行',exact:true}).click();await expect(page.getByText('Fixture reply: Next question after stop',{exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'等待发送',exact:true})).toHaveCount(0);const inputs=await(await request.get(`/api/conversations/${chat.id}/queue`)).json();expect(inputs.find((input:{id:string})=>input.id===queued.id).state).toBe('completed');
});
