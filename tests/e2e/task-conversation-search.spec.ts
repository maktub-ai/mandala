import {expect,test} from '@playwright/test';
test('linked conversation search matches content and cross-field keywords while retaining explicit selections',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 const agents=['finance-search','research-search'].map(id=>({id,name:id==='finance-search'?'Finance Agent':'Research Agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}));
 const directories:string[]=[];for(let index=0;index<2;index++)directories.push((await(await request.post('/__test__/execution-directory')).json()).directory);
 const projects=agents.map((agent,index)=>({id:'search-project-'+index,name:index===0?'Cloud Billing':'Product Research',cwd:directories[index],agentIds:[agent.id],resources:[],mcp:[],skills:[]}));
 expect((await request.put('/api/config',{data:{revision,config:{...config,runtimes:['codex'],agents:[...config.agents,...agents],projects:[...config.projects,...projects],system:{cli:'codex',automaticTitles:false,memory:{request:{generate:false,read:false},session:{generate:false,read:false}}}}}})).ok()).toBe(true);
 const chats=[];
 for(let index=0;index<2;index++){
  const chat=await(await request.post('/api/conversations',{data:{agentId:agents[index].id,projectId:projects[index].id,model:'model-fixture'}})).json();
  const text=index===0?'本轮核对账单明细':'本轮整理产品反馈';
  expect((await request.post(`/api/conversations/${chat.id}/messages`,{data:{text}})).ok()).toBe(true);
  await expect.poll(async()=>(await(await request.get(`/api/conversations/${chat.id}/history`)).json()).some((event:any)=>event.kind==='user'&&event.data.text===text)).toBe(true);
  await expect.poll(async()=>(await(await request.get('/api/conversations/'+chat.id)).json()).conversation.status).toBe('idle');
  expect((await request.patch('/api/conversations/'+chat.id,{data:{title:'Shared discussion'}})).ok()).toBe(true);chats.push(chat);
 }
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();
 const editor=page.getByRole('form',{name:'新建任务',exact:true});await editor.getByLabel('任务标题',{exact:true}).fill('Search execution objective');await expect(editor.getByRole('searchbox',{name:'搜索关联对话'})).toHaveCount(0);await editor.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Search execution objective',exact:true})).toBeVisible();const reply=page.locator('.task-reply');await reply.getByRole('button',{name:'设为执行对话 / 新开执行对话',exact:true}).click();const search=reply.getByRole('searchbox',{name:'搜索执行对话',exact:true});
 await search.fill('  ＦＩＮＡＮＣＥ　Billing 核对  ');await reply.getByRole('combobox',{name:'已有对话',exact:true}).click();await expect(page.getByRole('option',{name:'Shared discussion',exact:true})).toHaveCount(1);await expect(page.getByRole('listbox')).toContainText('Finance Agent');await page.locator('[role=option][data-value="'+chats[0].id+'"]').click();
 await search.fill('Research 产品');await reply.getByRole('combobox',{name:'已有对话',exact:true}).click();await expect(page.getByRole('option',{name:'Shared discussion',exact:true})).toHaveCount(1);await expect(page.getByRole('listbox')).toContainText('Research Agent');await page.keyboard.press('Escape');
 await search.fill('finance 核对');await reply.getByRole('combobox',{name:'已有对话',exact:true}).click();await expect(page.locator('[role=option][data-value="'+chats[0].id+'"]').first()).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');
 await search.fill('nothing-matches-the-conversations');await reply.getByRole('combobox',{name:'已有对话',exact:true}).click();await expect(page.getByRole('option',{name:'Shared discussion',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 await reply.getByRole('button',{name:'设为执行对话',exact:true}).click();const taskId=page.url().split('/tasks/')[1].split('?')[0];await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+taskId)).json()).task.conversationIds).toEqual([chats[0].id]);
});
