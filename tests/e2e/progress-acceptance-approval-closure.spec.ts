import {createTaskWithExecutionChats} from './helpers/task-executions';
// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P20 Progress to real execution approval resolves both allow and reject without accepting the Task',async({page,request})=>{

 await request.post('/__test__/progress-fixture');for(const decision of ['允许本次','拒绝']){
  const {directory}=await(await request.post('/__test__/execution-directory')).json();const initial=await(await request.get('/api/config')).json();const projectId='approval-'+crypto.randomUUID();await request.put('/api/config',{data:{revision:initial.revision,config:{...initial.config,projects:[...initial.config.projects,{id:projectId,name:'Approval closure',cwd:directory,agentIds:['progress-reviewer'],resources:[],mcp:[],skills:[]}]}}});
  const source=await(await request.post('/api/conversations',{data:{projectId,agentId:'progress-reviewer',workspaceId:null}})).json();const task=await(await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'approval',assigneeAgentId:'progress-reviewer',projectId}},[source.id])).json();
  await page.goto('/tasks');await page.locator('[data-task-id="'+task.id+'"] .progress-item-title').click();await page.getByRole('button',{name:'开始任务',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs.at(-1)?.state).toBe('approval');
  await page.locator('.task-breadcrumb a').click();const card=page.getByRole('region',{name:'需要你处理',exact:true}).locator('[data-task-id="'+task.id+'"]');await expect(card).toBeVisible();await card.locator('.progress-item-title').click();const run=(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs.at(-1);await page.locator('.task-command-bar').getByRole('link',{name:'查看审批',exact:true}).click();await expect(page).toHaveURL(new RegExp('conversation='+run.routing.executionConversationId));expect(run.routing.executionConversationId).not.toBe(source.id);
  await page.getByRole('button',{name:decision,exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/conversations/'+run.routing.executionConversationId)).json()).approvals.length).toBe(0);await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs.at(-1).state).not.toBe('approval');
  const done=await(await request.get('/api/v2/tasks/'+task.id)).json();expect(done.runs).toHaveLength(1);expect(done.task.state).not.toBe('completed');await page.reload();await expect(page.getByRole('button',{name:decision,exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0);
 }

});});
