import {expect,test} from '@playwright/test';

test('Tasks defaults to task-only discovery while independent chats remain reachable',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const independent=await(await request.post('/api/conversations',{data:{projectId:fixture.projectId,agentId:fixture.agentId,cli:'codex'}})).json();
 await page.goto('/tasks?scope=all&view=list');
 await expect(page.getByRole('searchbox',{name:'搜索任务',exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'显示类型',exact:true})).toHaveCount(0);
 await expect(page.locator('.progress-other-chats')).toHaveCount(0);
 await expect(page.locator('.task-work-card')).not.toHaveCount(0);
 await page.goto('/tasks?type=conversations&scope=all&view=list');
 await expect(page.locator('[data-conversation-id="'+independent.id+'"]')).toBeVisible();
 for(const type of ['type=conversations','tab=conversations']){
  await page.goto('/tasks?'+type+'&scope=all&q=no-match-'+crypto.randomUUID());
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await expect(page.locator('.conversation-progress').getByRole('searchbox',{name:'搜索对话',exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('type')).toBe('conversations');
 }
});

test('chat task scope follows explicit ownership and keeps reference and delivery links',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 await page.route('**/api/mandala/goals',async route=>{
  const response=await route.fetch(),goals=await response.json(),goal=goals.find((item:{taskId:string})=>item.taskId===fixture.goalId);
  await route.fulfill({json:[...goals,{...goal,taskId:'other-chat-task',conversationId:'other-chat',task:{...goal.task,id:'other-chat-task',goal:'另一段对话的任务'}}]});
 });
 await page.setViewportSize({width:1440,height:950});await page.goto('/mandala');
 const panel=page.locator('.mandala-panels');
 await expect(panel.getByRole('button',{name:'本对话 1',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.getByRole('button',{name:'全部任务 2',exact:true})).toBeVisible();
 await expect(panel.locator('.task-work-heading > a')).toHaveCount(1);
 await expect(panel.getByText('另一段对话的任务',{exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'全部任务 2',exact:true}).click();
 await expect(panel.getByRole('link',{name:'另一段对话的任务',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'本对话 1',exact:true}).click();
 await expect(panel.getByRole('button',{name:/^引用 接通跨项目/})).toBeEnabled();
 await expect(panel.getByRole('link',{name:'打开全部任务',exact:true})).toHaveAttribute('href','/tasks?scope=all');
 await expect(panel.locator('.task-progress-meter')).not.toBeVisible();
});

test('details lead with deliveries and criteria while review preserves execution chats',async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const before=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 if(before.task.state!=='review')await request.post('/api/v2/tasks/'+fixture.goalId+'/complete',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:before.task.revision}});
 await page.setViewportSize({width:1440,height:950});await page.goto('/tasks/'+fixture.goalId+'?scope=all&view=list');
 const detail=page.locator('.task-detail'),process=detail.locator('.task-execution-process');
 await expect(detail.getByRole('heading',{name:'交付结果',exact:true})).toBeVisible();
 await expect(detail.getByRole('heading',{name:'尚无正式交付',exact:true})).toBeVisible();
 await expect(detail.getByRole('heading',{name:'验收标准',exact:true})).toBeVisible();
 await expect(detail.getByRole('button',{name:'确认完成',exact:true})).toBeVisible();
 await expect(detail.getByRole('link',{name:'来源对话',exact:true})).toHaveAttribute('href','/?conversation='+fixture.mainId);
 // Execution chats are the task's primary structure: visible without expanding, ahead of criteria, and never a subtask list.
 await expect(process).not.toHaveAttribute('open');
 const executions=detail.getByRole('region',{name:'执行对话',exact:true});await expect(executions.locator('.execution-chats')).toContainText('登录接口实现');
 expect(await executions.evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('.task-criteria-section')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
 await expect(detail.locator('.task-children')).toHaveCount(0);
 await detail.getByRole('button',{name:'确认完成',exact:true}).click();
 await expect(detail.locator('.task-completion-evidence')).toContainText('用户已确认完成');
 await expect(detail.locator('.task-delivery-empty')).toHaveCount(0);
 await expect(detail).not.toContainText('交付返回后在这里核对');
 await expect(detail.locator('.task-criteria-section .task-criteria')).toBeVisible();
 await expect(detail.getByRole('heading',{name:'确认记录',exact:true})).toBeVisible();
 await expect(detail.locator('.task-breadcrumb').getByRole('link',{name:'来源对话',exact:true})).toBeVisible();
 await expect(detail.locator('.task-title').getByRole('button',{name:'更多任务操作',exact:true})).toBeVisible();
 const sections=await detail.locator('.task-core-section').evaluateAll(items=>items.map(item=>item.className));
 expect(sections).toEqual(['task-executions-section task-core-section','task-criteria-section task-core-section','task-result-section task-core-section','task-confirmation task-core-section','task-reply-section task-core-section']);
 const after=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 expect(after.task.state).toBe('completed');expect(after.executions).toEqual(before.executions);expect(after.executions).toHaveLength(1);
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath('task-result-first.png'),animations:'disabled'});
 await page.goto('/tasks?scope=all&view=list');
 const completed=page.getByRole('region',{name:'已完成',exact:true});
 await expect(completed.getByRole('button',{name:'展开已完成任务',exact:true})).toBeVisible();
 await expect(completed.locator('[data-task-id="'+fixture.goalId+'"]')).toBeHidden();
 await completed.getByRole('button',{name:'展开已完成任务',exact:true}).click();
 await expect(completed.locator('[data-task-id="'+fixture.goalId+'"]')).toBeVisible();
 await completed.locator('[data-task-id="'+fixture.goalId+'"] .task-work-heading > a').click();
 await detail.getByRole('button',{name:'重新打开',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+fixture.goalId)).json()).task.state).toBe('todo');
});

test('task rows expose navigation without expanding and reserve execution chats for details',async({page,request},info)=>{
 await page.setViewportSize({width:1440,height:950});await page.addInitScript(()=>localStorage.setItem('mana-theme','dark'));
 await request.post('/__test__/task-operation-cards');await page.goto('/mandala');
 const receipt=page.getByRole('link',{name:'任务：验证关联卡片',exact:true});
 await expect(receipt).toHaveCount(1);await expect(receipt).toBeVisible();
 await expect(receipt.locator('.task-progress-meter,.task-work-child')).toHaveCount(0);
 await page.locator('.conversation').evaluate(node=>{node.scrollTop=0;});
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath('chat-task-receipt.png'),animations:'disabled'});
});

test('execution approval stays visible on its single task in Tasks',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'approval',projectId:fixture.projectId,assigneeAgentId:fixture.agentId,originConversationId:fixture.mainId}})).json();
 expect((await request.post('/api/v2/tasks/'+task.id+'/start',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:task.revision}})).ok()).toBe(true);
 const detail=async()=>(await(await request.get('/api/v2/tasks/'+task.id)).json());
 await expect.poll(async()=>(await detail()).executions[0]?.latestRun?.state).toBe('approval');
 const execution=(await detail()).executions[0];
 try{
  await page.goto('/tasks?scope=all&view=list');
  const card=page.getByRole('region',{name:'需要你处理',exact:true}).locator('[data-task-id="'+task.id+'"]');
  await expect(card).toBeVisible();await expect(card).toContainText('等待审批');
  await card.locator('.task-work-heading > a').click();
  await expect(page.locator('.task-command-bar').getByRole('link',{name:'查看审批',exact:true})).toHaveAttribute('href','/?conversation='+execution.conversationId);
  await page.locator('.task-execution-process > summary').click();
  await expect(page.locator('.task-detail .execution-chats a')).toHaveCount(1);
  await expect(page.locator('.task-detail .execution-chats')).toContainText('等待审批');
  expect((await detail()).executions).toHaveLength(1);
 }finally{const current=(await detail()).task;await request.post('/api/v2/tasks/'+task.id+'/stop',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:current.revision}});}
});

test('the executor shortcut respects an open schedule editor',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'编辑互斥检查',projectId:fixture.projectId}})).json();
 await page.goto('/tasks/'+task.id+'?scope=all&view=list');
 await page.locator('.task-execution-process > summary').click();
 await page.locator('.task-detail summary').filter({hasText:/^执行规则$/}).click();
 await page.getByRole('button',{name:'添加执行规则',exact:true}).click();
 const executor=page.getByRole('button',{name:'选择执行智能体',exact:true});
 await expect(executor).toBeDisabled();
 await page.getByRole('form',{name:'新建执行规则',exact:true}).getByRole('button',{name:'取消',exact:true}).click();
 await expect(executor).toBeEnabled();await executor.click();
 await expect(page.getByRole('form',{name:'编辑任务',exact:true})).toBeVisible();
});
