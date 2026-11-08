// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P25 PC06 cancelling A continuation preserves B running and the recipient execution label',async({page,request})=>{

 const {source,target,message}=await acceptanceMessagePair(request);await page.goto('/?conversation='+source.id);await page.getByRole('button',{name:'取消等待协作',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+message.id)).json()).replyState).toBe('parked');await page.goto('/?conversation='+target.id);
 await expect(page.locator('.agent-message summary')).toContainText('执行中');await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeVisible();expect((await(await request.get('/api/conversations/'+target.id)).json()).conversation.status).toBe('running');
 await request.post('/__test__/message-finish',{data:{messageId:message.id,text:'Preserved parked result'}});await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+message.id)).json()).state).toBe('succeeded');await page.reload();await expect(page.locator('.agent-message summary')).toContainText('已回复');await page.goto('/?conversation='+source.id);await expect(page.locator('.agent-message').filter({hasText:'智能体 回复'})).toContainText('已保存，未自动接续');

});});
