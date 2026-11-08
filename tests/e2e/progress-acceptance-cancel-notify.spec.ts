// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P30 cancelling queued inquiry broadcasts failure to both sides and notify never resumes A',async({page,request})=>{

 const {source,target,message}=await acceptanceMessagePair(request,{busyTarget:true});await page.goto('/?conversation='+target.id);await page.locator('.queued-input').filter({hasText:'controlled acceptance inquiry'}).getByRole('button',{name:'取消排队',exact:true}).click();await expect(page.locator('.agent-message summary')).toContainText('执行未完成');await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+message.id)).json()).state).toBe('failed');await page.goto('/?conversation='+source.id);await expect(page.locator('.agent-message').filter({hasText:'已发送'}).locator('summary')).toContainText('执行未完成');await request.post('/__test__/progress-native',{data:{id:target.id,outcome:'completed',text:'Old B request complete'}});const cancelled=await(await request.get('/api/conversations/'+target.id+'/queue')).json();expect(cancelled.find((q:{agentMessage?:{id:string;direction:string}})=>q.agentMessage?.id===message.id&&q.agentMessage?.direction==='request').state).toBe('cancelled');
 const notified=await acceptanceMessagePair(request,{policy:'notify'});await request.post('/__test__/message-finish',{data:{messageId:notified.message.id,text:'Notify only confirmation'}});await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+notified.message.id)).json()).replyState).toBe('parked');await page.goto('/?conversation='+notified.source.id);await expect(page.locator('.agent-message').filter({hasText:'智能体 回复'})).toContainText('已保存，未自动接续');expect((await(await request.get('/api/conversations/'+notified.source.id)).json()).conversation.status).toBe('idle');

});});
