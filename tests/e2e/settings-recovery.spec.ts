import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';

async function reset(request:import('@playwright/test').APIRequestContext){const {revision}=await(await request.get('/api/config')).json();expect((await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex','omp'],projects:[],agents:[],system:{cli:'omp',model:'shared-model'}}}})).ok()).toBe(true);}

test('system defaults are visible and inherited choices name the effective runtime and model',async({page,request})=>{
 await reset(request);await page.route('**/api/models?**',route=>route.fulfill({json:[]}));await page.goto('/settings/system');
 await expect(page.getByRole('combobox',{name:'系统任务模型',exact:true})).toBeVisible();
 const title=page.getByRole('region',{name:'自动标题',exact:true});
 await expect(title.getByRole('combobox',{name:'执行端',exact:true})).toContainText('OMP');
 await expect(title.getByRole('combobox',{name:'模型',exact:true})).toContainText('shared-model');
});

test('empty and partial MCP creation never poisons autosave and can be cancelled or left',async({page,request})=>{
 await reset(request);await page.goto('/settings/mcp');await page.getByRole('button',{name:'添加 MCP',exact:true}).click();
 await expect(page.getByRole('button',{name:'取消新增 MCP',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'创建 MCP',exact:true})).toBeDisabled();
 await page.getByRole('textbox',{name:'MCP 名称',exact:true}).fill('unfinished');
 await page.waitForTimeout(800);expect((await(await request.get('/api/config')).json()).config.connections??[]).toEqual([]);
 await page.getByRole('button',{name:'取消新增 MCP',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'MCP 名称',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'添加 MCP',exact:true}).click();await page.getByRole('link',{name:'系统任务',exact:true}).click();
 await page.getByRole('switch',{name:'自动生成对话标题',exact:true}).check();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.system.automaticTitles).toBe(true);
 await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('link',{name:'MCP 连接',exact:true}).click();await expect(page.getByRole('textbox',{name:'MCP 名称',exact:true})).toHaveCount(0);
});

test('MCP creation validates locally then persists only after explicit create',async({page,request})=>{
 await reset(request);await page.goto('/settings/mcp');await page.getByRole('button',{name:'添加 MCP',exact:true}).click();
 await page.getByRole('textbox',{name:'MCP 名称',exact:true}).fill('example');await chooseOption(page,'连接类型','http');
 await page.getByRole('textbox',{name:'URL',exact:true}).fill('invalid-url');await expect(page.getByRole('button',{name:'创建 MCP',exact:true})).toBeDisabled();
 await page.getByRole('textbox',{name:'URL',exact:true}).fill(' HTTPS://example.com/mcp');await page.getByRole('button',{name:'创建 MCP',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.connections?.[0]?.url).toBe('https://example.com/mcp');await page.reload();await expect(page.getByRole('textbox',{name:'MCP 名称',exact:true})).toHaveValue('example');
});

test('native MCP discovery reports scope and never claims connectivity',async({page,request})=>{
 await reset(request);await page.route('**/api/capabilities?**',route=>route.fulfill({json:{mcp:[{name:'local-example',source:'native',path:'/synthetic/config.toml',definition:{command:'example'}}],skills:[]}}));
 await page.goto('/settings/mcp');await page.getByText('本地已注册的 MCP',{exact:true}).click();await expect(page.getByText('local-example',{exact:true})).toBeVisible();await expect(page.getByText('已发现，尚未测试连接',{exact:true})).toBeVisible();
});
