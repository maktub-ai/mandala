// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P21 PC02 completed-only uses the completion fact while approval and Reopen stay available',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await request.post('/api/conversations/'+d.long+'/messages',{data:{text:'approval'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+d.long)).json()).approvals.length).toBe(1);await request.post('/api/conversation-progress/'+d.long,{data:{action:'complete'}});
 await page.goto('/tasks?type=conversations');await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'可见范围','completed');const card=page.getByRole('region',{name:'待处理',exact:true}).locator('[data-conversation-id="'+d.long+'"]');await expect(card).toBeVisible();await card.locator('.progress-expand').click();await expect(card.getByRole('button',{name:'重新打开',exact:true})).toBeVisible();await expect(card.getByRole('button',{name:'标记完成',exact:true})).toHaveCount(0);
 const before=(await(await request.get('/api/conversation-progress')).json()).find((r:{id:string})=>r.id===d.long);expect(before.completedAt).toBeTruthy();expect(before.state).toBe('attention');await card.getByRole('link',{name:'打开对话',exact:true}).click();expect((await(await request.get('/api/conversations/'+d.long)).json()).approvals).toHaveLength(1);

});});
