import {expect,test} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
import {setAppearanceMode} from './helpers/navigation';
import {chooseOption} from './helpers/select';
import {mkdirSync} from 'node:fs';

test.use({storageState:storedUiState('en')});
test('source schedule surfaces render both themes and all required widths',async({page,request})=>{
 test.setTimeout(120000);
 const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'render-scheduler',name:'Release operations',instructions:'Synthetic rendered review',defaultCli:'codex',models:{},mcp:[],skills:[]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}})).ok()).toBe(true);
 const base=await(await request.post('/api/automations',{data:{name:'Workday release report · 工作日报',instructions:'Review the release evidence and report outstanding actions. Preserve source links and request confirmation when a decision is needed.',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,executionMode:'continuous',enabled:false,schedule:{kind:'weekly',weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 const at='2026-10-31T01:00:00.000Z',statuses=['queued','starting','running','approval','succeeded','unknown','missed','failed','interrupted','legacy_unverified','completed'] as const;
 const rules=statuses.map((status,index)=>({...base,id:base.id+'-'+index,name:index===4?base.name:['Queued review','Starting data check','Running release scan','Approval required','', 'Unconfirmed native state','Missed occurrence','Failed report','Interrupted check','Historical unverified','Accepted report'][index],enabled:index===4,nextRunAt:index===4?'2026-11-02T01:00:00.000Z':null,executionMode:index%2?'independent':'continuous'}));
 const runs=statuses.map((status,index)=>({id:'render-run-'+index,automationId:rules[index].id,name:rules[index].name,projectId:'',agentId:agent.id,cli:'codex',instructions:'Synthetic review',scheduledAt:at,createdAt:at,status,taskId:'render-task-'+index,taskState:index===4?'review':index===10?'completed':'waiting',waitingReason:index===3?'approval':null}));
 await page.route('**/api/automations',route=>route.fulfill({json:{version:1,automations:rules,runs}}));
 const dir='.impeccable/review/system-agent-schedules-task4';mkdirSync(dir,{recursive:true});
 await page.goto('/schedules');
 for(const theme of ['light','dark'] as const){
  await setAppearanceMode(page,theme);
  for(const width of [1991,1440,1024,768,390]){
   await page.setViewportSize({width,height:950});await page.goto('/schedules');await expect(page.locator('.schedule-row')).toHaveCount(statuses.length);await expect(page.getByRole('button',{name:base.name,exact:true}).locator('.schedule-row-trigger')).toContainText('Weekdays 09:00');await expect(page.locator('.schedule-row').filter({hasText:'Awaiting review'})).toBeVisible();await page.screenshot({path:`${dir}/${theme}-${width}-list.png`,fullPage:true});
   await page.getByRole('button',{name:base.name,exact:true}).click();await expect(page.locator('.schedule-detail-history')).toContainText('Awaiting review');await page.screenshot({path:`${dir}/${theme}-${width}-detail.png`,fullPage:true});
   await page.getByRole('article',{name:base.name,exact:true}).getByRole('button',{name:'Edit',exact:true}).click();const form=page.locator('.automation-editor');await expect(form).toContainText('Saving keeps this schedule enabled. Future runs use these changes.');await expect(form.getByRole('combobox',{name:'Execution mode',exact:true})).toHaveAttribute('data-value','continuous');await expect(form.getByRole('checkbox',{name:'Fri',exact:true})).toBeChecked();await form.getByRole('checkbox',{name:'Fri',exact:true}).focus();await page.keyboard.press('Space');await expect(form.getByRole('checkbox',{name:'Fri',exact:true})).not.toBeChecked();await page.keyboard.press('Space');await chooseOption(page,form.getByRole('combobox',{name:'Execution mode',exact:true}),'independent');await expect(form.getByRole('combobox',{name:'Execution conversation',exact:true})).toHaveCount(0);await page.screenshot({path:`${dir}/${theme}-${width}-editor.png`,fullPage:true});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await form.getByRole('button',{name:'Cancel',exact:true}).click();
  }
  await page.setViewportSize({width:1991,height:950});await page.goto('/agents');await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();await page.screenshot({path:`${dir}/${theme}-1991-agents.png`,fullPage:true});await page.goto('/schedules');
 }
 // Settled empty and read failure states use the same actual source page.
 await page.unroute('**/api/automations');await page.route('**/api/automations',route=>route.fulfill({json:{version:1,automations:[],runs:[]}}));await page.goto('/schedules');await expect(page.getByText('No scheduled tasks yet',{exact:true})).toBeVisible();await page.screenshot({path:`${dir}/empty.png`,fullPage:true});
 await page.unroute('**/api/automations');await page.route('**/api/automations',route=>route.fulfill({status:503,json:{error:'Synthetic schedule service unavailable'}}));await page.goto('/schedules');await expect(page.getByRole('alert')).toContainText('Synthetic schedule service unavailable');await page.screenshot({path:`${dir}/error.png`,fullPage:true});
});
test.describe('Chinese schedule surface',()=>{
 test.use({storageState:storedUiState('zh-CN')});
 test('Chinese main paths preserve real copy at desktop and narrow widths',async({page,request})=>{
  const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'chinese-scheduler',name:'发布巡检助手',instructions:'合成验收',defaultCli:'codex',models:{},mcp:[],skills:[]};
  expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}})).ok()).toBe(true);
  const saved=await(await request.post('/api/automations',{data:{name:'工作日早报 · 发布与风险检查',instructions:'检查发布记录并汇总待处理事项。保留来源链接；需要决策时请求人工确认。',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,executionMode:'continuous',enabled:false,schedule:{kind:'weekly',weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'}}})).json();
  const rule={...saved,enabled:true,nextRunAt:'2026-11-02T01:00:00.000Z'};await page.route('**/api/automations',route=>route.fulfill({json:{version:1,automations:[rule],runs:[{id:'chinese-reviewed-run',automationId:saved.id,name:saved.name,projectId:'',agentId:agent.id,cli:'codex',instructions:'合成验收',scheduledAt:'2026-10-31T01:00:00.000Z',createdAt:'2026-10-31T01:00:00.000Z',status:'succeeded',taskState:'review',taskId:'chinese-review-task'}]}}));
  const dir='.impeccable/review/system-agent-schedules-task4';await page.goto('/schedules');
  for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);for(const width of [1991,390]){
   await page.setViewportSize({width,height:950});await page.goto('/schedules');await expect(page.locator('.schedule-row')).toContainText('下次：');await expect(page.locator('.schedule-row-trigger')).toContainText('工作日 09:00');await page.screenshot({path:`${dir}/zh-${theme}-${width}-list.png`,fullPage:true});await page.getByRole('button',{name:saved.name,exact:true}).click();const detail=page.getByRole('article',{name:saved.name,exact:true});await expect(detail).toContainText('下次运行：');await expect(detail.locator('dt').filter({hasText:'工作目录'})).toHaveCount(0);await page.screenshot({path:`${dir}/zh-${theme}-${width}-detail.png`,fullPage:true});await detail.getByRole('button',{name:'编辑',exact:true}).click();const form=page.getByRole('form',{name:'编辑计划',exact:true});await expect(form).toContainText('保存后计划保持启用，后续执行使用本次修改。');await expect(form.getByLabel('计划名称',{exact:true})).toHaveValue(saved.name);await expect(form.getByLabel('工作内容',{exact:true})).toHaveValue(saved.instructions);await page.screenshot({path:`${dir}/zh-${theme}-${width}-editor.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await form.getByRole('button',{name:'取消',exact:true}).click();
  }}
 });
});
