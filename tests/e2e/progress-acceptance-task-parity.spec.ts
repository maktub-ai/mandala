// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {mkdirSync} from 'node:fs';
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P14 Task completion and reopening work directly in Board and List without starting a Run',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const initial=(await(await request.get('/api/conversation-progress')).json()).find((r:{id:string})=>r.id===d.recent);
 for(const view of ['board','list']){
  await page.goto('/tasks?type=tasks&view='+view);const card=page.locator('[data-task-id="'+d.task+'"]');await card.locator('.task-work-related > summary').click();
  // State movement is display/workflow management, never an execution command.
  if(view==='list'){mkdirSync('/tmp/mandala-task-compat/progress-acceptance',{recursive:true});await page.screenshot({path:'/tmp/mandala-task-compat/progress-acceptance/after-list-actions.png',fullPage:true});}
  const move=card.getByRole('combobox',{name:'移动任务：发布计划',exact:true});await expect(move).toBeVisible();await move.click();await page.locator('[role=option][data-value=completed]').click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+d.task)).json()).task.state).toBe('completed');await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-task-id="'+d.task+'"]')).toBeVisible();
  if(await card.locator('.task-work-related').getAttribute('open')===null)await card.locator('.task-work-related > summary').click();await move.click();await page.locator('[role=option][data-value=todo]').click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+d.task)).json()).task.state).toBe('todo');await expect(page.getByRole('region',{name:'待办',exact:true}).locator('[data-task-id="'+d.task+'"]')).toBeVisible();
  expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).runs).toHaveLength(0);
 }
 const final=(await(await request.get('/api/conversation-progress')).json()).find((r:{id:string})=>r.id===d.recent);expect(final.completedAt).toBe(initial.completedAt);

});});
