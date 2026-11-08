import {expect,test} from '@playwright/test';

// Actual publication through the existing isolated fake-runtime fixture, never production data.
for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`published delivery precedes execution and supports review ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const {directory}=await(await request.post('/__test__/execution-directory')).json();
 const {config,revision}=await(await request.get('/api/config')).json(),projectId='delivery-'+crypto.randomUUID(),agentId='delivery-agent-'+crypto.randomUUID();
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,{...config.agents.find((agent:{id:string})=>agent.id===fixture.agentId),id:agentId,name:'Billing Domain'}],projects:[...config.projects,{id:projectId,name:'账单与预算管理',cwd:directory,agentIds:[agentId],resources:[],mcp:[],skills:[]}]}}})).ok()).toBe(true);
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'hold',projectId,assigneeAgentId:agentId,acceptance:'human',criteria:[{id:'cause',text:'说明字段空值的来源',checkRef:null},{id:'scope',text:'核对影响范围',checkRef:null},{id:'advice',text:'给出处理建议',checkRef:null}]}})).json();
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:1000});
 await page.goto('/tasks/'+task.id+'?scope=all&view=list');await page.getByRole('button',{name:'开始任务',exact:true}).click();
 const read=async()=>await(await request.get('/api/v2/tasks/'+task.id)).json();
 await expect.poll(async()=>(await read()).runs.at(-1)?.state).toBe('running');
 expect((await request.post('/__test__/task-output',{data:{taskId:task.id}})).ok()).toBe(true);
 await expect.poll(async()=>(await read()).task.state).toBe('review');
 const current=(await read()).task;
 expect((await request.patch('/api/v2/tasks/'+task.id,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:current.revision,goal:'调查 GCP 日账单 project_id 为空\n核对来源、影响范围与处理建议。'}})).ok()).toBe(true);
 await page.reload();const detail=page.locator('.task-detail');
 await expect(detail.getByRole('link',{name:/^Task research report/})).toBeVisible();
 await expect(detail.locator('.task-delivery-empty')).toHaveCount(0);
 await expect(detail.locator('.task-execution-process')).not.toHaveAttribute('open');
 await expect(detail.getByRole('button',{name:'确认完成',exact:true})).toBeVisible();
 const positions=await detail.evaluate(el=>({delivery:el.querySelector('.task-result-section')!.getBoundingClientRect().top,criteria:el.querySelector('.task-criteria-section')!.getBoundingClientRect().top,actions:el.querySelector('.task-review-actions')!.getBoundingClientRect().top,process:el.querySelector('.task-execution-process')!.getBoundingClientRect().top}));
 expect(positions.actions).toBeLessThan(positions.criteria);expect(positions.criteria).toBeLessThan(positions.delivery);expect(positions.delivery).toBeLessThan(positions.process);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`delivery-${mode}-${width}.png`),animations:'disabled'});
 if(width===1440){
  await detail.getByRole('button',{name:'确认完成',exact:true}).click();
  await expect(detail.locator('.task-completion-evidence')).toContainText('用户已确认完成');
  expect((await read()).task.state).toBe('completed');
 }else{
  await detail.getByRole('button',{name:'要求修改',exact:true}).click();await detail.getByRole('textbox',{name:'原因',exact:true}).fill('补充证据来源');
  await detail.getByRole('button',{name:'保存并重新打开',exact:true}).click();
  await expect.poll(async()=>(await read()).task.state).toBe('todo');
 }
 expect((await read()).runs).toHaveLength(1);
});
