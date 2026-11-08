import {expect,type APIRequestContext,type Page} from '@playwright/test';
export async function seedRuleForEditing(request:APIRequestContext,page:Page,projectId:string,agentId:string,name='Existing schedule',instructions='Review personal notes') {
 const response=await request.post('/api/automations',{data:{name,instructions,projectId,agentId,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}});
 expect(response.ok()).toBe(true);
 await page.goto('/schedules?project='+projectId);await page.getByRole('button',{name,exact:true}).click();
 await page.getByRole('article',{name,exact:true}).getByRole('button',{name:/^(编辑|Edit)$/,exact:true}).click();
}
