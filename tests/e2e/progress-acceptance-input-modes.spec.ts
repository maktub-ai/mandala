// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P18 blocking input needs attention while nonblocking input remains running and both can be answered',async({page,request})=>{

 await request.post('/__test__/progress-fixture');for(const blocking of [true,false]){
  const c=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:null}})).json();await request.post('/api/conversations/'+c.id+'/messages',{data:{text:blocking?'native-question':'native-question-nonblocking'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+c.id)).json()).approvals.length).toBe(1);
  await page.goto('/tasks');const card=page.getByRole('region',{name:blocking?'待处理':'进行中与最近',exact:true}).locator('[data-conversation-id="'+c.id+'"]');await expect(card).toContainText(blocking?'需要处理':'执行中');await card.locator('.progress-item-title').click();await expect(page.getByRole('group',{name:'Where should the content open?'})).toBeVisible();
  expect((await(await request.get('/api/conversations/'+c.id)).json()).approvals).toHaveLength(1);await page.getByRole('radio',{name:'In app Preview inside OpenMana',exact:true}).check();await page.getByRole('button',{name:'提交回答',exact:true}).click();await expect(page.getByText('Question answered: In app',{exact:true})).toBeVisible();await expect.poll(async()=>(await(await request.get('/api/conversations/'+c.id)).json()).conversation.status).toBe('idle');expect((await(await request.get('/api/conversations/'+c.id)).json()).approvals).toHaveLength(0);
 }

});});
