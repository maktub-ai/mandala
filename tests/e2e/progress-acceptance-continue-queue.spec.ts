// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P34 paused human queue offers explicit Continue and preserves a separate collaboration wait',async({page,request})=>{

 const {source,target,message}=await acceptanceMessagePair(request);await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'hold'}});const q=await(await request.post('/api/conversations/'+source.id+'/queue',{data:{text:'message-hold: explicitly continued human input',commandKey:crypto.randomUUID()}})).json();await request.post('/api/conversations/'+source.id+'/stop',{data:{continueQueued:false}});await page.goto('/?conversation='+source.id);await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'取消等待协作',exact:true})).toHaveCount(0);const row=page.locator('.queued-input').filter({hasText:'explicitly continued human input'});await row.getByRole('button',{name:'继续发送',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id+'/queue')).json()).find((i:{id:string})=>i.id===q.id).state).toBe('running');await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeVisible();expect((await(await request.get('/api/conversations/'+target.id)).json()).conversation.status).toBe('running');expect((await(await request.get('/api/agent-messages/'+message.id)).json()).replyState).toBe('parked');

});});
