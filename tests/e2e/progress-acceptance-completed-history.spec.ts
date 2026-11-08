// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{test('P15 completed chats expire from the default window and remain findable in history',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await request.post('/api/conversation-progress/'+d.long,{data:{action:'complete'}});expect((await request.post('/__test__/progress-age',{data:{id:d.long,ageMinutes:61}})).ok()).toBe(true);
 await page.goto('/tasks?type=conversations&window=60');await expect(page.locator('[data-conversation-id="'+d.long+'"]')).toHaveCount(0);
 if(await page.getByRole('button',{name:'筛选',exact:true}).getAttribute('aria-expanded')==='false')await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'可见范围','all');const card=page.locator('[data-conversation-id="'+d.long+'"]');await expect(card).toContainText('已完成');
 const state=(await(await request.get('/api/conversation-progress?windowMinutes=60')).json()).find((r:{id:string})=>r.id===d.long);expect(state.completedAt).toBeTruthy();expect(state.withinWindow).toBe(false);
 await chooseOption(page,'可见范围','active');await expect(card).toHaveCount(0);await chooseOption(page,'最近使用窗口','240');await expect(card).toContainText('已完成');
 expect((await(await request.get('/api/conversations/'+d.long)).json()).conversation.status).toBe('idle');

});});
