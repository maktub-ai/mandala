// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P14 completed chat drop targets follow objective reopen state instead of silently choosing another lane',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await request.post('/api/conversation-progress/'+d.long,{data:{action:'complete'}});await page.goto('/tasks?type=conversations&view=board');const card=page.locator('[data-conversation-id="'+d.long+'"]');
 // A recent idle chat reopens to Active, so Needs attention cannot advertise acceptance.
 const destination=page.getByRole('region',{name:'待处理',exact:true});await card.dragTo(destination,{sourcePosition:{x:6,y:6}});await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();
 expect((await(await request.get('/api/conversation-progress')).json()).find((r:{id:string})=>r.id===d.long).completedAt).toBeTruthy();await card.dragTo(page.getByRole('region',{name:'进行中与最近',exact:true}),{sourcePosition:{x:6,y:6}});await expect(page.getByRole('region',{name:'进行中与最近',exact:true}).locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();
 // Conversely, an interrupted chat reopens to Needs attention, never Active.
 await request.post('/api/conversation-progress/'+d.expiredInterrupted,{data:{action:'complete'}});await request.post('/__test__/progress-age',{data:{id:d.expiredInterrupted,ageMinutes:1}});await page.reload();const stopped=page.locator('[data-conversation-id="'+d.expiredInterrupted+'"]');await stopped.dragTo(page.getByRole('region',{name:'进行中与最近',exact:true}),{sourcePosition:{x:6,y:6}});await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.expiredInterrupted+'"]')).toBeVisible();await stopped.dragTo(destination,{sourcePosition:{x:6,y:6}});await expect(destination.locator('[data-conversation-id="'+d.expiredInterrupted+'"]')).toBeVisible();
 expect((await(await request.get('/api/conversations/'+d.expiredInterrupted)).json()).conversation.status).toBe('interrupted');

});});
