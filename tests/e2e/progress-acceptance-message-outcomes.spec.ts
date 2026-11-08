// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P28 failed and unknown B outcomes remain inspectable on both sides without automatic retries',async({page,request})=>{

 for(const outcome of ['failed','unknown']){
  const {source,target,message}=await acceptanceMessagePair(request);expect((await request.post('/__test__/progress-native',{data:{id:target.id,outcome}})).ok()).toBe(true);await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+message.id)).json()).state).toBe(outcome);await page.goto('/?conversation='+target.id);const incoming=page.locator('.agent-message');await expect(incoming).toContainText(outcome==='unknown'?'执行状态未知':'执行未完成');await incoming.locator('summary').click();await expect(incoming).toContainText('controlled acceptance inquiry');await incoming.getByRole('link',{name:'查看来源对话',exact:true}).click();await expect(page.locator('.agent-message').filter({hasText:'已发送'}).locator('summary')).toContainText(outcome==='unknown'?'执行状态未知':'执行未完成');await page.reload();const state=await(await request.get('/api/agent-messages/'+message.id)).json();expect(state.state).toBe(outcome);const q=await(await request.get('/api/conversations/'+target.id+'/queue')).json();expect(q.filter((i:{agentMessage?:{id:string;direction:string}})=>i.agentMessage?.id===message.id&&i.agentMessage?.direction==='request')).toHaveLength(1);expect(q.find((i:{agentMessage?:{id:string;direction:string}})=>i.agentMessage?.id===message.id&&i.agentMessage?.direction==='request').state).toBe(outcome==='unknown'?'unknown':'completed');
 }

});});
