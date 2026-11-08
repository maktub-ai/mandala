// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P23 A and B distinguish inquiry queued and running before completion without creating Tasks',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const a=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:null}})).json(),b=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-reviewer',workspaceId:null}})).json();
 await request.post('/api/conversations/'+a.id+'/messages',{data:{text:'Prepare question'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+a.id)).json()).conversation.status).toBe('idle');await request.post('/api/conversations/'+b.id+'/messages',{data:{text:'hold'}});
 const before=await(await request.get('/api/v2/tasks')).json();const m=await(await request.post('/api/agent-messages',{data:{sourceConversationId:a.id,targetAgentId:'progress-reviewer',targetConversationId:b.id,text:'message-hold: check release scope',commandKey:crypto.randomUUID()}})).json();expect(m.state).toBe('queued');
 // Observe B before ending its old turn; the new inquiry is actually queued.
 await page.goto('/?conversation='+b.id);await expect(page.locator('.queued-input')).toContainText(/智能体\s*询问，等待执行/);const inquiry=page.locator('.agent-message').filter({hasText:'接收的'});await expect(inquiry.locator('summary')).toContainText('排队');await inquiry.locator('summary').click();await expect(inquiry.getByRole('link',{name:'查看来源对话',exact:true})).toHaveAttribute('href','/?conversation='+a.id);
 await page.goto('/?conversation='+a.id);await expect(page.locator('.agent-message summary')).toContainText('排队');
 // Finish only the old B turn, then inspect the inquiry while it remains executing.
 expect((await request.post('/__test__/message-finish',{data:{messageId:m.id,text:'Old B work finished'}})).ok()).toBe(true);await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+m.id)).json()).state).toBe('running');await page.reload();await expect(page.locator('.agent-message summary')).toContainText('执行');await page.goto('/?conversation='+b.id);await expect(page.locator('.agent-message summary')).toContainText('执行');await expect(page.locator('.queued-input')).toHaveCount(0);
 expect((await request.post('/__test__/message-finish',{data:{messageId:m.id,text:'Scope confirmed'}})).ok()).toBe(true);await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+m.id)).json()).replyState).toBe('consumed');expect(await(await request.get('/api/v2/tasks')).json()).toHaveLength(before.length);

});});
