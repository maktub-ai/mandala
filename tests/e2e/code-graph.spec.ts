import { setAppearanceMode } from './helpers/navigation';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';

test('directory settings persist, expose real repository root and independently refresh or disable bindings',async({page,request,executionDirectory},testInfo)=>{
 const child=join(executionDirectory,'child');await mkdir(child);execFileSync('git',['init','-q',executionDirectory]);await writeFile(join(child,'leaf.ts'),'export function leaf() { return 1; }');await writeFile(join(executionDirectory,'outside.ts'),'export function outside() { return 2; }');
 const {revision}=await(await request.get('/api/config')).json();const resource={id:'local',label:'Local copy',kind:'local',location:child};
 expect((await request.put('/api/config',{data:{revision,config:{version:2,agents:[],projects:[{id:'graph',name:'CodeGraph fixture',cwd:child,resources:[resource],agentIds:[],mcp:[],skills:[],workspaces:[{id:'w',name:'Source',cwd:child,resources:[resource,{id:'remote',label:'Repository origin',kind:'remote-git',location:'https://example.com/repo.git'}]}]}]}}})).ok()).toBe(true);
 const saved=async()=>(await(await request.get('/api/config')).json()).config.projects[0].workspaces[0];
 await page.goto('/projects/manage?project=graph&tab=resources');const main=page.locator('.code-graph-binding').first(),local=page.locator('.resource-row').first().locator('.code-graph-binding'),remote=page.locator('.resource-row').last().locator('.code-graph-binding');
 await expect(main).toContainText('未启用');await expect(remote).toContainText('远程引用尚未检出');await expect(remote.getByRole('checkbox')).toBeDisabled();
 await main.getByRole('checkbox').check();await expect.poll(async()=>(await saved()).codeGraph).toEqual({enabled:true,scope:'directory'});
 await main.getByRole('button',{name:'刷新索引',exact:true}).click();await expect(main).toContainText('索引可用');await expect(main).toContainText(child);await expect(main).toContainText('1 文件');
 await local.getByRole('checkbox').check();await expect.poll(async()=>(await saved()).resources[0].codeGraph?.enabled).toBe(true);await local.getByRole('button',{name:'刷新索引',exact:true}).click();await expect(local).toContainText('索引可用');
 await chooseOption(page,main.getByRole('combobox',{name:'索引范围'}),'repository');await expect.poll(async()=>(await saved()).codeGraph.scope).toBe('repository');await main.getByRole('button',{name:'刷新索引',exact:true}).click();await expect(main).toContainText('2 文件');await expect(main).toContainText('此绑定将读取整个仓库');await expect(local).toContainText('1 文件');
 await main.getByRole('checkbox').uncheck();await expect.poll(async()=>(await saved()).codeGraph.enabled).toBe(false);await local.getByRole('button',{name:'刷新索引',exact:true}).click();await expect(local).toContainText('索引可用');
 await page.reload();await expect(main.getByRole('checkbox')).not.toBeChecked();await expect(local.getByRole('checkbox')).toBeChecked();
 for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);await page.setViewportSize({width:390,height:844});await expect(main.getByRole('combobox')).toBeVisible();await expect(local.getByRole('button',{name:'刷新索引',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`code-graph-${theme}.png`),fullPage:true});}
});
