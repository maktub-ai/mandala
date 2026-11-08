// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P21 completed Task and completed chat still expose a real pending approval without clearing completion',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const detail=await(await request.get('/api/v2/tasks/'+d.task)).json();await request.post('/api/v2/tasks/'+d.task+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:detail.task.revision,state:'completed'}});
 // A regular linked conversation may legitimately ask for approval after Task acceptance.
 await request.post('/api/conversations/'+d.recent+'/messages',{data:{text:'approval'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+d.recent)).json()).approvals.length).toBe(1);
 // Display completion is independent of an approval already pending.
 await request.post('/api/conversation-progress/'+d.recent,{data:{action:'complete'}});await request.post('/__test__/progress-age',{data:{id:d.recent,ageMinutes:2880}});
 await page.goto('/tasks');const parent=page.getByRole('region',{name:'待处理',exact:true}).locator('[data-task-id="'+d.task+'"]');await expect(parent).toContainText('已完成');await parent.locator('.progress-expand').click();await expect(parent.locator('[data-linked-conversation-id="'+d.recent+'"]')).toContainText('需要处理');await parent.locator('[data-linked-conversation-id="'+d.recent+'"]').click();
 await expect(page.getByRole('button',{name:'允许本次',exact:true})).toBeVisible();expect((await(await request.get('/api/conversations/'+d.recent)).json()).approvals).toHaveLength(1);
 await page.getByRole('button',{name:'拒绝',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/conversations/'+d.recent)).json()).approvals.length).toBe(0);
 const progress=(await(await request.get('/api/conversation-progress')).json()).find((r:{id:string})=>r.id===d.recent);expect(progress.completedAt).toBeTruthy();expect(progress.state).toBe('completed');expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).task.state).toBe('completed');

});});
