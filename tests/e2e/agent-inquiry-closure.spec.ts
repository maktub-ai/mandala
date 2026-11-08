// spec: audit/2026-10-26-task-closure/official-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Collaboration settling and reopening',()=>{test('MSG-03 MSG-06 dedicated inquiry settles once and explicit reopen permits human continuation',async({page,request})=>{
 // Prepare a regular source A, then create dedicated B through an actual Agent inquiry.
 await request.post('/__test__/progress-fixture');const before=await(await request.get('/api/v2/tasks')).json();
 const a=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:null}})).json();
 await request.post('/api/conversations/'+a.id+'/messages',{data:{text:'hold'}});
 const m=await(await request.post('/api/agent-messages',{data:{sourceConversationId:a.id,targetAgentId:'progress-reviewer',text:'message-hold: confirm release scope',commandKey:crypto.randomUUID()}})).json();
 const readMessage=async()=>await(await request.get('/api/agent-messages/'+m.id)).json();
 await expect.poll(async()=>(await readMessage()).state).toBe('running');
 // Observe B while still executing, including its source navigation.
 await page.goto('/?conversation='+m.targetConversationId);const inquiry=page.locator('.agent-message').filter({hasText:'接收的'});
 await expect(inquiry.locator('summary')).toContainText('执行中');await inquiry.locator('summary').click();await expect(inquiry.getByRole('link',{name:'查看来源对话',exact:true})).toHaveAttribute('href','/?conversation='+a.id);
 await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeVisible();
 // Let A yield and B successfully answer; neither action force-stops a running turn.
 expect((await request.post('/__test__/progress-native',{data:{id:a.id,outcome:'completed',text:'Waiting for confirmation'}})).ok()).toBe(true);
 expect((await request.post('/__test__/message-finish',{data:{messageId:m.id,text:'Scope confirmed, no remaining questions'}})).ok()).toBe(true);
 await expect.poll(async()=>(await readMessage()).replyState).toBe('consumed');
 const progress=async()=>await(await request.get('/api/conversation-progress')).json();
 await expect.poll(async()=>(await progress()).find((row:{id:string})=>row.id===m.targetConversationId).state).toBe('completed');
 expect((await progress()).find((row:{id:string})=>row.id===a.id).completedAt).toBeNull();
 expect(await(await request.get('/api/v2/tasks')).json()).toHaveLength(before.length);
 const history=await(await request.get('/api/conversations/'+a.id+'/history')).json();expect(history.filter((event:{kind:string;data:{text?:string}})=>event.kind==='user'&&event.data.text?.startsWith('Continue the original request using this reply.'))).toHaveLength(1);
 await page.reload();await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0);
 // Reopen through the Completed card, reload, and confirm no execution was started.
 await page.getByRole('link',{name:'任务',exact:true}).click();const card=page.locator('[data-conversation-id="'+m.targetConversationId+'"]');
 await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+m.targetConversationId+'"]')).toBeVisible();
 await card.locator('.progress-expand').click();await card.getByRole('button',{name:'重新打开',exact:true}).click();await page.reload();
 await expect(card).toContainText('最近使用');expect((await(await request.get('/api/conversations/'+m.targetConversationId)).json()).conversation.status).toBe('idle');
 // A new user follow-up is a deliberate continuation and preserves the inquiry record.
 await card.locator('.progress-item-title').click();await page.getByRole('textbox',{name:'消息',exact:true}).fill('Human continuation after reopening');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByText('Human continuation after reopening',{exact:true})).toBeVisible();await expect.poll(async()=>(await(await request.get('/api/conversations/'+m.targetConversationId)).json()).conversation.status).toBe('idle');
 expect((await progress()).find((row:{id:string})=>row.id===m.targetConversationId).completedAt).toBeNull();await expect(page.getByText('Scope confirmed, no remaining questions',{exact:true})).toBeVisible();
});});
