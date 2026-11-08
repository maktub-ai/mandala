import {putRuntimeConfig} from './helpers/runtime-config';
import {waitForAutosave} from './helpers/settings';
import { test, expect } from '@playwright/test';
import { chooseOption, enterModelId, expectSelection } from './helpers/select';

test('background tasks save separate CLI and model profiles without changing Agent models', async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await putRuntimeConfig(request, { version: 2, system:{cli:'codex',memory:{language:'en'}},
    projects: [{ id: 'profiles', name: 'Synthetic profiles', cwd: '/tmp', agentIds: ['worker'], resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'worker', name: 'Worker', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
  })).ok()).toBe(true);
  await page.goto('/settings/system');
  const title = page.getByRole('region', { name: '自动标题', exact: true });
  const memory = page.getByRole('region', { name: '记忆提炼', exact: true });
  const progress = page.getByRole('region', { name: '任务进度评估', exact: true });
  await expect(title).toBeVisible();
  const progressToggle=progress.getByRole('switch',{name:'任务进度评估',exact:true});
  await expect(progressToggle).toBeChecked();await progressToggle.uncheck();await waitForAutosave(page);
  expect((await(await request.get('/api/config')).json()).config.system.automaticTaskProgress).toBe(false);
  await page.reload();await expect(progressToggle).not.toBeChecked();await progressToggle.check();await waitForAutosave(page);
  await chooseOption(page, title.getByRole('combobox', { name: '执行端', exact: true }), 'omp');
  await enterModelId(page,title.getByLabel('模型',{exact:true}),'synthetic-small');
  await chooseOption(page, memory.getByRole('combobox', { name: '执行端', exact: true }), 'codex');
  await enterModelId(page,memory.getByLabel('模型',{exact:true}),'synthetic-balanced');
  await expect(progress).toBeVisible();await chooseOption(page,progress.getByRole('combobox',{name:'执行端',exact:true}),'omp');await enterModelId(page,progress.getByLabel('模型',{exact:true}),'synthetic-progress');
  await page.getByLabel('自动生成对话标题', { exact: true }).check();
  for (const label of ['请求记忆生成','请求记忆读取']) await expect(memory.getByLabel(label,{exact:true})).toBeChecked();
  await memory.getByLabel('请求记忆生成', {exact:true}).uncheck();
  await memory.getByLabel('请求记忆生成', {exact:true}).check();
  await waitForAutosave(page);
  const saved = (await (await request.get('/api/config')).json()).config;
  expect(saved.system.tasks).toEqual({ title: { cli: 'omp', model: 'synthetic-small' }, memory: { cli: 'codex', model: 'synthetic-balanced' }, taskProgress:{cli:'omp',model:'synthetic-progress'} });
  expect(saved.system.memory).toMatchObject({language:'en',request:{generate:true,read:true}});
  expect(saved.agents[0].models).toEqual({});
  await page.reload();
  await expectSelection(title.getByLabel('模型',{exact:true}),'synthetic-small');
  await expectSelection(memory.getByLabel('模型',{exact:true}),'synthetic-balanced');
  await expectSelection(progress.getByLabel('模型',{exact:true}),'synthetic-progress');
  await chooseOption(page,progress.getByRole('combobox',{name:'执行端',exact:true}),'');await waitForAutosave(page);expect((await(await request.get('/api/config')).json()).config.system.tasks.taskProgress).toBeUndefined();await expectSelection(progress.getByLabel('模型',{exact:true}),'');
  for (const label of ['请求记忆生成','请求记忆读取']) await expect(memory.getByLabel(label,{exact:true})).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('system defaults and task overrides offer all enabled runtimes and persist ACP selections',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await putRuntimeConfig(request, {version:2,runtimes:['codex','omp','claude','gemini'],projects:[],agents:[]})).ok()).toBe(true);
 const requested:string[]=[];
 await page.route('**/api/models?**',route=>{requested.push(route.request().url());return route.fulfill({json:[{id:'synthetic-model',label:'Synthetic model'}]});});
 await page.goto('/settings/system');
 const defaults=page.getByRole('region',{name:'系统默认',exact:true});
 for(const name of ['Codex','OMP','Claude Code','Gemini CLI'])await expect(defaults.getByRole('radio',{name,exact:true})).toBeVisible();
 await expect(defaults.getByRole('radio',{name:'OpenCode',exact:true})).toHaveCount(0);
 await defaults.getByRole('radio',{name:'Gemini CLI',exact:true}).click();await waitForAutosave(page);
 const title=page.getByRole('region',{name:'自动标题',exact:true});
 await chooseOption(page,title.getByRole('combobox',{name:'执行端',exact:true}),'claude');await waitForAutosave(page);
 await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.system).toMatchObject({cli:'gemini',tasks:{title:{cli:'claude'}}});
 await page.reload();await expect(defaults.getByRole('radio',{name:'Gemini CLI',exact:true})).toBeChecked();
 expect(requested.some(url=>url.includes('scope=system')&&url.includes('cli=gemini'))).toBe(true);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/system-runtime-options-390.png',fullPage:true});
});
