// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P32 interrupt sends selected Q2 once and leaves Q1 pending while Q2 runs',async({page,request})=>{

 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',workspaceId:null}})).json();await request.post('/api/conversations/'+chat.id+'/messages',{data:{text:'hold'}});
 const q1=await(await request.post('/api/conversations/'+chat.id+'/queue',{data:{text:'Q1 must remain queued',commandKey:crypto.randomUUID()}})).json();const q2=await(await request.post('/api/conversations/'+chat.id+'/queue',{data:{text:'message-hold: Q2 selected',commandKey:crypto.randomUUID()}})).json();
 await page.goto('/?conversation='+chat.id);const selected=page.locator('.queued-input').filter({hasText:'message-hold: Q2 selected'});await selected.getByRole('button',{name:'打断并发送',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+chat.id+'/queue')).json()).find((q:{id:string})=>q.id===q2.id)?.state).toBe('running');const queue=await(await request.get('/api/conversations/'+chat.id+'/queue')).json();expect(queue.find((q:{id:string})=>q.id===q1.id).state).toBe('queued');expect(queue.filter((q:{id:string})=>q.id===q2.id)).toHaveLength(1);
 await expect(page.locator('.queued-input').filter({hasText:'Q1 must remain queued'})).toBeVisible();await expect(page.getByRole('button',{name:'停止执行',exact:true})).toBeVisible();

});});
