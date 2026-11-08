import { test, expect } from '@playwright/test';
import { chooseOption } from './helpers/select';
import { mkdirSync } from 'node:fs';
test('explicit maintained-file settings assign a human import to an Agent, save scope and disable without deleting versions',async({page,request})=>{
 const state=await (await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision:state.revision,config:{...state.config,agents:[...state.config.agents,{id:'maint-agent',name:'维护 Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}],projects:[...state.config.projects,{id:'maint-project',name:'维护项目',cwd:'/tmp',agentIds:['maint-agent'],resources:[],mcp:[],skills:[]}]}}});
 await page.goto('/assets');await page.getByRole('button',{name:'导入文件',exact:true}).click();await page.getByLabel('文件名称').fill('维护路线图');await page.getByLabel('选择文件',{exact:true}).setInputFiles({name:'roadmap.md',mimeType:'text/markdown',buffer:Buffer.from('# 路线图\n当前待验证')});await page.getByRole('button',{name:'导入并发布'}).click();await expect(page.getByRole('heading',{name:'维护路线图',exact:true})).toBeVisible();
 const id=new URL(page.url()).pathname.split('/').at(-1)!;await page.getByRole('button',{name:'文件设置',exact:true}).click();
 await page.getByRole('checkbox', {name:'持续维护',exact:true}).check();await chooseOption(page,page.getByLabel('维护 智能体',{exact:true}),'maint-agent');await chooseOption(page,page.getByLabel('维护范围',{exact:true}),'maint-project');
 await page.getByLabel('维护条件说明（可选）',{exact:true}).fill('仅在完成验收后更新验证章节；保留其他计划。');
 await expect(page.getByText('启用后，所选 智能体 将成为此文件的归属 智能体，并使用最新版本关联。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'保存维护设置',exact:true}).click();await expect(page.getByRole('status')).toContainText('已保存维护设置');
 expect(await (await request.get('/api/v2/assets/'+id+'/maintenance')).json()).toMatchObject({enabled:true,agentId:'maint-agent',projectId:'maint-project',conditions:'仅在完成验收后更新验证章节；保留其他计划。'});expect((await (await request.get('/api/v2/assets/'+id)).json()).owner.agentId).toBe('maint-agent');
 await page.reload();await page.getByRole('button',{name:'文件设置',exact:true}).click();await expect(page.getByLabel('维护条件说明（可选）',{exact:true})).toHaveValue('仅在完成验收后更新验证章节；保留其他计划。');
 mkdirSync('/tmp/openmana-maintenance-visual',{recursive:true});await page.getByLabel('维护条件说明（可选）',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/openmana-maintenance-visual/maintenance-light.png',fullPage:true});
 await page.evaluate(()=>localStorage.setItem('mana-theme','dark'));await page.reload();await page.getByRole('button',{name:'文件设置',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:'/tmp/openmana-maintenance-visual/maintenance-dark.png',fullPage:true});await page.setViewportSize({width:390,height:850});await expect(page.locator('#asset-settings-panel')).toBeVisible();await page.getByLabel('维护范围',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/openmana-maintenance-visual/maintenance-narrow.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('checkbox',{name:'持续维护',exact:true}).uncheck();await page.getByRole('button',{name:'保存维护设置',exact:true}).click();await expect.poll(async()=> (await (await request.get('/api/v2/assets/'+id+'/maintenance')).json()).enabled).toBe(false);expect((await (await request.get('/api/v2/assets/'+id+'/versions')).json()).length).toBe(1);
 await page.setViewportSize({width:1280,height:850});
 for(const [error,message] of [
  ['maintenance_summary_too_large','记忆进展超过 12,000 个 UTF-16 字符；本次未调用模型。'],
  ['maintenance_snapshot_too_large','记忆进展及来源信息超过 128 KiB；本次未调用模型。'],
  ['maintenance_prompt_too_large','文件与记忆进展的单次输入超过 128 KiB；本次未调用模型。'],
 ]){
  await page.route('**/api/v2/assets/'+id+'/maintenance',route=>route.fulfill({json:{enabled:false,revision:2,agentId:'maint-agent',projectId:'maint-project',lastCheck:{state:'failed',error,versionId:null}}}));
  await page.reload();await page.getByRole('button',{name:'文件设置',exact:true}).click();await expect(page.getByText(message,{exact:true})).toBeVisible();await page.unroute('**/api/v2/assets/'+id+'/maintenance');
 }

 await page.evaluate(()=>localStorage.setItem('mana-language','en'));
 await page.route('**/api/v2/assets/'+id+'/maintenance',route=>route.fulfill({json:{enabled:false,revision:2,agentId:'maint-agent',projectId:'maint-project',lastCheck:{state:'failed',error:'maintenance_prompt_too_large',versionId:null}}}));
 await page.reload();await page.getByRole('button',{name:'File settings',exact:true}).click();await expect(page.getByText('The file and memory progress input exceeds 128 KiB; no model call was made.',{exact:true})).toBeVisible();

});
