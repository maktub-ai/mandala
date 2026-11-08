// spec: audit/2026-10-26-task-closure/official-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Collaboration settling and reopening',()=>{test('MSG-02 nested inquiry waits for resolved B answer before resuming A once',async({page,request})=>{
 // Prepare A and a new dedicated B inquiry, controlling native turns instead of sleeping.
 await request.post('/__test__/progress-fixture');const before=await(await request.get('/api/v2/tasks')).json();
 const a=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:null}})).json();await request.post('/api/conversations/'+a.id+'/messages',{data:{text:'hold'}});
 const m=await(await request.post('/api/agent-messages',{data:{sourceConversationId:a.id,targetAgentId:'progress-reviewer',text:'message-hold: resolve release question',commandKey:crypto.randomUUID()}})).json();
 const readMessage=async(id:string)=>await(await request.get('/api/agent-messages/'+id)).json();const chat=async(id:string)=>(await(await request.get('/api/conversations/'+id)).json()).conversation;
 await expect.poll(async()=>(await readMessage(m.id)).state).toBe('running');
 // B asks C while B original request remains open; observe actual C execution.
 const c=await(await request.post('/api/agent-messages',{data:{sourceConversationId:m.targetConversationId,targetAgentId:'progress-engineer',text:'message-hold: confirm rollback detail',commandKey:crypto.randomUUID()}})).json();
 await expect.poll(async()=>(await readMessage(c.id)).state).toBe('running');await page.goto('/?conversation='+c.targetConversationId);await expect(page.locator('.agent-message summary')).toContainText('执行中');
 expect((await request.post('/__test__/progress-native',{data:{id:a.id,outcome:'completed',text:'Waiting for B'}})).ok()).toBe(true);
 expect((await request.post('/__test__/message-finish',{data:{messageId:m.id,text:'Waiting for C; do not finalize yet'}})).ok()).toBe(true);
 // The interim answer is not an upstream terminal reply and B remains visibly waiting.
 expect(await readMessage(m.id)).toMatchObject({state:'running',reply:null,replyState:'pending'});
 await page.getByRole('link',{name:'任务',exact:true}).click();await expect(page.locator('[data-conversation-id="'+m.targetConversationId+'"]')).toContainText('等待协作');
 const resumes=async()=>{const events=await(await request.get('/api/conversations/'+a.id+'/history')).json();return events.filter((event:{kind:string;data:{text?:string}})=>event.kind==='user'&&event.data.text?.startsWith('Continue the original request using this reply.'));};
 expect(await resumes()).toHaveLength(0);
 // C answer resumes B only; A still waits until B issues its resolved final answer.
 expect((await request.post('/__test__/message-finish',{data:{messageId:c.id,text:'Rollback detail confirmed'}})).ok()).toBe(true);
 await expect.poll(async()=>(await chat(m.targetConversationId)).status).toBe('running');await expect.poll(async()=>(await chat(m.targetConversationId)).turnId).toBeTruthy();
 expect(await readMessage(m.id)).toMatchObject({state:'running',reply:null,replyState:'pending'});expect(await resumes()).toHaveLength(0);
 await page.goto('/?conversation='+m.targetConversationId);await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeVisible();
 // The resolved B answer returns to A exactly once, and successful dedicated receivers settle.
 expect((await request.post('/__test__/progress-native',{data:{id:m.targetConversationId,outcome:'completed',text:'Release scope and rollback confirmed; no remaining questions'}})).ok()).toBe(true);
 await expect.poll(async()=>(await readMessage(m.id)).replyState).toBe('consumed');expect((await readMessage(m.id)).reply).toBe('Release scope and rollback confirmed; no remaining questions');expect(await resumes()).toHaveLength(1);
 const rows=await(await request.get('/api/conversation-progress')).json();for(const id of [m.targetConversationId,c.targetConversationId])expect(rows.find((row:{id:string})=>row.id===id).state).toBe('completed');
 expect(await(await request.get('/api/v2/tasks')).json()).toHaveLength(before.length);
});});
