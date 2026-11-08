import {expect,test} from '@playwright/test';

test('list rows identify and select tasks without duplicate states or embedded operations',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const before=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 await page.goto('/tasks?scope=all&view=list');
 const row=page.locator('[data-task-id="'+fixture.goalId+'"] .task-work-card');
 await expect(row.locator('.task-work-related,.task-delivery-link,.workspace-status')).toHaveCount(0);
 await expect(row.getByRole('link',{name:before.task.goal,exact:true})).not.toHaveAttribute('aria-current','page');
 const config=await(await request.get('/api/config')).json(),agent=config.config.agents.find((agent:{id:string})=>agent.id===before.task.assigneeAgentId);
 if(agent)await expect(row.getByRole('link',{name:before.task.goal,exact:true})).toHaveAccessibleDescription(new RegExp(agent.name));
 await row.getByRole('link',{name:before.task.goal,exact:true}).click();
 await expect(page.locator('.task-detail .task-title')).toContainText(before.task.goal);
 await expect(row.locator('a[aria-current="page"]')).toHaveCount(1);
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'看板',exact:true}).click();
 await expect(row.locator('.task-work-related')).toHaveCount(1);
});

for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`completed review keeps criteria, completion, reply and reopen visible ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const before=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 if(before.task.state!=='completed')expect((await request.post('/api/v2/tasks/'+fixture.goalId+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:before.task.revision,state:'completed'}})).ok()).toBe(true);
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:1000});
 await page.goto('/tasks/'+fixture.goalId+'?scope=all&view=list');
 const detail=page.locator('.task-detail');
 await expect(detail.getByRole('heading',{name:'验收标准',exact:true})).toBeVisible();
 await expect(detail.locator('.task-criteria')).toContainText('检查登录');await expect(detail.locator('.task-criteria')).toBeVisible();
 await expect(detail.getByRole('heading',{name:'确认记录',exact:true})).toBeVisible();
 await expect(detail.getByRole('heading',{name:'补充说明',exact:true})).toBeVisible();
 await expect(detail.getByRole('button',{name:'设为执行对话',exact:true})).toBeVisible();
 expect(before.task.conversationIds).toContain(before.executions[0].conversationId);await expect(detail.locator('.task-reply').getByRole('combobox',{name:'目标对话',exact:true})).toHaveAttribute('data-value',before.executions[0].conversationId);
 await expect(detail.locator('.task-identity-bar').getByRole('button',{name:'重新打开',exact:true})).toBeVisible();
 await expect(detail.getByRole('link',{name:'来源对话',exact:true})).toHaveAttribute('href','/?conversation='+fixture.mainId);
 await expect(detail.locator('.task-source-chat .lucide-external-link')).toHaveCount(0);
 await expect(detail.getByRole('link',{name:'返回任务列表',exact:true})).toHaveCount(0);
 expect(await detail.evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(800);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`review-simple-${mode}-${width}.png`),animations:'disabled'});
 if(width===1440){await detail.getByRole('button',{name:'重新打开',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+fixture.goalId)).json()).task.state).toBe('todo');}
});

test('active filters name the current constraints and clear without hidden query state',async({page,request})=>{
 await request.post('/__test__/mandala-panels');await page.goto('/tasks?scope=completed&createdBy=user&window=60&q=no-matching-task&view=list');
 const filters=page.getByRole('region',{name:'当前筛选',exact:true});
 await expect(filters).toContainText('仅已完成');await expect(filters).toContainText('用户创建');await expect(filters).not.toContainText('最近 1 小时');
 await expect(filters.getByRole('button',{name:'清除筛选',exact:true})).toHaveCount(1);
 await filters.getByRole('button',{name:'清除筛选',exact:true}).click();
 await expect(filters).toHaveCount(0);
 await page.goto('/tasks?window=60&view=list');await expect(filters).toContainText('最近 1 小时');
 await filters.getByRole('button',{name:'清除筛选',exact:true}).click();
 const query=new URL(page.url()).searchParams;
 for(const key of ['scope','createdBy','window','q'])expect(query.has(key)).toBe(false);
});

test('completed operation receipts do not imply that deliverables exist',async({page,request})=>{
 const fixture=await(await request.post('/__test__/task-operation-cards')).json();
 const detail=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 await request.post('/api/v2/tasks/'+fixture.goalId+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:detail.task.revision,state:'completed'}});
 await page.goto('/mandala');const receipt=page.locator('.turn-change[data-task-id="'+fixture.goalId+'"]');
 await expect(receipt.getByRole('link',{name:'任务：验证关联卡片',exact:true})).toBeVisible();
 await expect(receipt.getByRole('link',{name:'查看交付',exact:true})).toHaveCount(0);
});
