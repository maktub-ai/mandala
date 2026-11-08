// spec: audit/2026-10-26-task-closure/official-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Collaboration settling and reopening',()=>{test('MSG-08 formal Task waits for lightweight peer and returns only resolved final answer',async({page,request})=>{
 // Create A and an actual formal delegated Task for B; the user's source turn yields naturally.
 await request.post('/__test__/progress-fixture');
 const a=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:'default'}})).json();await request.post('/api/conversations/'+a.id+'/messages',{data:{text:'hold'}});
 const delegated=await request.post('/api/tasks',{data:{sourceConversationId:a.id,targetAgentId:'progress-reviewer',request:'message-hold: Deliver final release review after peer confirmation',policy:'resume',commandKey:crypto.randomUUID()}});expect(delegated.ok(),await delegated.text()).toBe(true);const b=await delegated.json();
 const detail=async()=>await(await request.get('/api/v2/tasks/'+b.id)).json();const readMessage=async(id:string)=>await(await request.get('/api/agent-messages/'+id)).json();
 expect((await request.post('/__test__/progress-native',{data:{id:a.id,outcome:'completed',text:'Waiting on formal B review'}})).ok()).toBe(true);
 await expect.poll(async()=>(await detail()).runs.at(-1).state).toBe('running');const first=(await detail()).runs.at(-1),beforePeer=await(await request.get('/api/v2/tasks')).json();
 // Formal B owns its directory. C's lightweight inquiry is genuinely queued and cannot interrupt B.
 const peer=await(await request.post('/api/agent-messages',{data:{sourceConversationId:b.targetConversationId,targetAgentId:'progress-engineer',text:'message-hold: Confirm release rollback detail',commandKey:crypto.randomUUID()}})).json();
 await expect.poll(async()=>(await readMessage(peer.id)).state).toBe('queued');await page.goto('/?conversation='+peer.targetConversationId);await expect(page.locator('.queued-input')).toContainText(/智能体\s*询问/);
 // B ends an interim turn; native Run success is truthful but Task/receipt are still waiting.
 expect((await request.post('/__test__/progress-native',{data:{id:b.targetConversationId,outcome:'completed',text:'Waiting on peer; review is not final'}})).ok()).toBe(true);
 await expect.poll(async()=>(await readMessage(peer.id)).state).toBe('running');await page.reload();await expect(page.getByTestId('chat-status')).toHaveText('执行中');
 const waiting=await detail();expect(waiting.task).toMatchObject({state:'waiting',waitingReason:'input',completion:null});expect(waiting.runs).toHaveLength(1);expect(waiting.runs[0]).toMatchObject({id:first.id,state:'succeeded'});expect(waiting.receipts).toHaveLength(0);
 const resumes=async()=>{const events=await(await request.get('/api/conversations/'+a.id+'/history')).json();return events.filter((e:{kind:string;data:{text?:string}})=>e.kind==='user'&&e.data.text?.includes('Task receipts (data)'));};expect(await resumes()).toHaveLength(0);
 // Progress exposes the Task first and its waiting conversation underneath.
 await page.getByRole('link',{name:'任务',exact:true}).click();const card=page.locator('[data-task-id="'+b.id+'"]');await expect(card).toBeVisible();await card.locator('.task-work-related > summary').click();const linked=card.locator('.execution-chat-link[href="/?conversation='+b.targetConversationId+'"]');await expect(linked).toBeVisible();await linked.click();await expect(page).toHaveURL(new RegExp('conversation='+b.targetConversationId));await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 // C's final answer creates a new real B Run on the same Task, not a phantom still-running Run1.
 expect((await request.post('/__test__/message-finish',{data:{messageId:peer.id,text:'Rollback detail confirmed'}})).ok()).toBe(true);await expect.poll(async()=>(await detail()).runs.length).toBe(2);await expect.poll(async()=>(await detail()).runs.at(-1).state).toBe('running');
 const resumed=(await detail()).runs.at(-1);expect(resumed.id).not.toBe(first.id);expect(resumed.nativeTurnId).not.toBe(first.nativeTurnId);expect(resumed.routing).toMatchObject({executionConversationId:b.targetConversationId,destinationConversationId:a.id});expect((await detail()).receipts).toHaveLength(0);expect(await resumes()).toHaveLength(0);
 // No explicit acceptance intent here: final deliverable becomes Review and exactly one final receipt reaches A.
 expect((await request.post('/__test__/progress-native',{data:{id:b.targetConversationId,outcome:'completed',text:'Final release review and rollback confirmed'}})).ok()).toBe(true);
 await expect.poll(async()=>(await detail()).task.state).toBe('review');await expect.poll(async()=>(await detail()).receipts.length).toBe(1);const final=await detail();expect(final.runs.filter((run:{executionId:string})=>run.executionId===first.executionId)).toHaveLength(2);expect(final.runs.find((run:{id:string})=>run.id===resumed.id).state).toBe('succeeded');expect(final.receipts[0].summary).toBe('Final release review and rollback confirmed');expect(final.receipts[0].sourceRunId).toBe(resumed.id);await expect.poll(async()=>(await resumes()).length).toBe(1);expect(await(await request.get('/api/v2/tasks')).json()).toHaveLength(beforePeer.length);
 // Final conversation transcript remains reachable from its Task, with the resolved answer visible.
 await page.getByRole('link',{name:'任务',exact:true}).click();await card.locator('.task-work-related > summary').click();await card.locator('.execution-chat-link[href="/?conversation='+b.targetConversationId+'"]').click();await expect(page.getByText('Final release review and rollback confirmed',{exact:true})).toBeVisible();
});});
