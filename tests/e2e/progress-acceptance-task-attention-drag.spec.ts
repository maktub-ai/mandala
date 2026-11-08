// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P14 PC03 Task with pending child approval rejects a misleading Active drop without changing lifecycle',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await request.post('/api/conversations/'+d.recent+'/messages',{data:{text:'approval'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+d.recent)).json()).approvals.length).toBe(1);await page.goto('/tasks?view=board');const card=page.getByRole('region',{name:'需要你处理',exact:true}).locator('[data-task-id="'+d.task+'"]');await expect(card).toBeVisible();let moves=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/'+d.task+'/move'))moves++;});
 await card.dragTo(page.getByRole('region',{name:'进行中',exact:true}),{sourcePosition:{x:6,y:6}});expect(moves).toBe(0);await expect(card).toBeVisible();const after=await(await request.get('/api/v2/tasks/'+d.task)).json();expect(after.task.state).toBe('todo');expect(after.runs).toHaveLength(0);expect((await(await request.get('/api/conversations/'+d.recent)).json()).approvals).toHaveLength(1);

});});
