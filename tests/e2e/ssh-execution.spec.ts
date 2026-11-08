import {expect,test} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {waitForAutosave} from './helpers/settings';

const machine={id:'ssh-ui-machine',name:'构建服务器',host:'build-linux'};
async function seed(request:any){
 const {config,revision}=await(await request.get('/api/config')).json();
 const project={id:'ssh-ui-project-'+crypto.randomUUID(),name:'SSH UI 项目',cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[],workspaces:[{id:'default',name:'Default',cwd:'/tmp',resources:[]}]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,executionMachines:[machine],projects:[...config.projects.filter((p:any)=>p.id!==project.id),project]}}})).ok()).toBe(true);
 return project;
}

test('remote machines are listed with status, tested before adding, and explain failures with a next step',async({page,request})=>{
 await seed(request);await page.goto('/settings/execution-machines');
 await expect(page.getByRole('heading',{name:'远程机器',exact:true})).toBeVisible();
 const row=page.getByRole('region',{name:machine.name,exact:true});
 await expect(row).toContainText('build-linux');await expect(row).toContainText('未检测');
 await page.route('**/api/execution-machines/probe',route=>route.fulfill({status:400,json:{error:'SSH failed (255): Host key verification failed.'}}));
 await row.getByRole('button',{name:'测试连接',exact:true}).click();
 await expect(row.getByRole('alert')).toContainText('ssh build-linux');await expect(row.getByRole('alert')).toContainText('Host key verification failed');
 await expect(row).toContainText('连接失败');
 await page.unroute('**/api/execution-machines/probe');
 await page.route('**/api/execution-machines/probe',route=>route.fulfill({json:{platform:'linux',nodeVersion:'22.23.2',runtimes:[{id:'codex',installed:true},{id:'omp',installed:false}]}}));
 await row.getByRole('button',{name:'测试连接',exact:true}).click();
 await expect(row).toContainText('可连接');
 await expect(row.getByRole('status').filter({hasText:'Linux'})).toContainText('Codex');
 await expect(row.getByRole('status').filter({hasText:'Linux'})).toContainText('OMP（未安装）');
 await expect(row.getByText(/不代表已登录/)).toBeVisible();
 await expect(page.locator('input[type=password]')).toHaveCount(0);
 await row.getByRole('button',{name:'编辑',exact:true}).click();
 const edit=page.getByRole('region',{name:'编辑 '+machine.name,exact:true});
 await edit.getByRole('textbox',{name:'机器名称',exact:true}).fill('中文构建机');await edit.getByRole('button',{name:'保存',exact:true}).click();await waitForAutosave(page);
 expect((await(await request.get('/api/config')).json()).config.executionMachines[0].name).toBe('中文构建机');
 await page.getByRole('button',{name:'添加机器',exact:true}).click();
 const editor=page.getByRole('region',{name:'新增远程机器',exact:true});
 await editor.getByRole('textbox',{name:'机器名称',exact:true}).fill('备用机');await editor.getByRole('textbox',{name:'SSH 目标',exact:true}).fill('user@backup');
 await page.unroute('**/api/execution-machines/probe');
 await page.route('**/api/execution-machines/probe',route=>route.fulfill({status:400,json:{error:'SSH failed (255): user@backup: Permission denied (publickey).'}}));
 await editor.getByRole('button',{name:'测试并添加',exact:true}).click();
 await expect(editor.getByRole('alert')).toContainText('ssh-agent');
 expect((await(await request.get('/api/config')).json()).config.executionMachines).toHaveLength(1);
 await editor.getByRole('button',{name:'仍然添加',exact:true}).click();await waitForAutosave(page);
 expect((await(await request.get('/api/config')).json()).config.executionMachines).toEqual(expect.arrayContaining([expect.objectContaining({name:'备用机',host:'user@backup'})]));
 await page.reload();await expect(page.getByRole('region',{name:'备用机',exact:true})).toContainText('user@backup');
});

test('remote workspace saves its machine and POSIX path without local browsing or cloning, and local defaults remain available',async({page,request})=>{
 const project=await seed(request);await page.goto(`/projects/${project.id}/settings?tab=resources`);
 await expect(page.getByRole('combobox',{name:'执行机器',exact:true})).toHaveAttribute('data-value','');
 await expect(page.getByRole('button',{name:'浏览文件夹',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'从仓库克隆',exact:true})).toBeEnabled();
 await page.route('**/api/execution-machines/check-path',route=>route.fulfill({json:{exists:false,isDirectory:false}}));
 await chooseOption(page,'执行机器',machine.id);await page.getByRole('textbox',{name:'主工作目录',exact:true}).fill('/srv/项目');
 await expect(page.getByText('机器上不存在这个目录。',{exact:true})).toBeVisible();
 await page.unroute('**/api/execution-machines/check-path');await page.route('**/api/execution-machines/check-path',route=>route.fulfill({json:{exists:true,isDirectory:true,realpath:'/srv/项目'}}));
 await page.getByRole('textbox',{name:'主工作目录',exact:true}).fill('/srv/项目/');await page.getByRole('textbox',{name:'主工作目录',exact:true}).fill('/srv/项目');
 await expect(page.getByText('目录存在',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'浏览文件夹',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'从仓库克隆',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'添加资源',exact:true}).click();await expect(page.getByRole('button',{name:'浏览本地目录',exact:true})).toBeDisabled();
 await expect(page.getByText('目录资源位于同一台执行机器。',{exact:true})).toBeVisible();await page.getByRole('textbox',{name:'资源名称',exact:true}).fill('远程资料');await page.getByRole('textbox',{name:'资源位置',exact:true}).fill('/srv/resources');await waitForAutosave(page);
 const saved=(await(await request.get('/api/config')).json()).config.projects.find((p:any)=>p.id===project.id);expect(saved.workspaces[0]).toMatchObject({machineId:machine.id,cwd:'/srv/项目'});
 await page.reload();await expect(page.getByRole('combobox',{name:'执行机器',exact:true})).toHaveAttribute('data-value',machine.id);
 await chooseOption(page,'执行机器','');await expect(page.getByRole('textbox',{name:'主工作目录',exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.getByRole('textbox',{name:'主工作目录',exact:true})).toHaveValue('/srv/项目');await expect(page.getByRole('combobox',{name:'执行机器',exact:true})).toHaveAttribute('data-value',machine.id);
 await chooseOption(page,'执行机器','');await expect(page.getByRole('textbox',{name:'主工作目录',exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'浏览文件夹',exact:true})).toBeEnabled();await page.getByRole('textbox',{name:'主工作目录',exact:true}).fill('/tmp');await page.getByRole('textbox',{name:'资源位置',exact:true}).fill('/tmp');await waitForAutosave(page);const local=(await(await request.get('/api/config')).json()).config.projects.find((p:any)=>p.id===project.id).workspaces[0];expect(local.machineId).toBeUndefined();expect(local.cwd).toBe('/tmp');
});

test('conversation location remains pinned after machine and workspace edits, including an unavailable remote host',async({page,request})=>{
 const project=await seed(request);let {config,revision}=await(await request.get('/api/config')).json();const p=config.projects.find((p:any)=>p.id===project.id);p.workspaces[0]={...p.workspaces[0],machineId:machine.id,cwd:'/srv/original'};
 expect((await request.put('/api/config',{data:{revision,config}})).ok()).toBe(true);
 const response=await request.post('/api/conversations',{data:{projectId:project.id,workspaceId:'default',agentId:'',cli:'codex'}});expect(response.ok()).toBe(true);const chat=await response.json();await request.patch('/api/conversations/'+chat.id,{data:{title:'Pinned SSH UI'}});
 ({config,revision}=await(await request.get('/api/config')).json());config.executionMachines[0]={...machine,name:'新名称',host:'different-host'};config.projects.find((p:any)=>p.id===project.id).workspaces[0].cwd='/srv/changed';await request.put('/api/config',{data:{revision,config}});
 await page.route(`**/api/conversations/${chat.id}/environment`,route=>route.fulfill({status:503,json:{error:'Host unavailable'}}));
 await page.goto('/?conversation='+chat.id+'&project='+project.id);const row=page.getByRole('button',{name:'Pinned SSH UI',exact:true});await expect(row).toHaveAttribute('title',/构建服务器.*build-linux.*\/srv\/original/);
 await expect(page.getByRole('button',{name:'对话上下文',exact:true})).toContainText('构建服务器');await page.getByRole('button',{name:'对话上下文',exact:true}).click();const popover=page.getByRole('dialog',{name:'对话上下文',exact:true});await expect(popover).toContainText('构建服务器');await expect(popover).toContainText('build-linux');await expect(popover).toContainText('/srv/original');await expect(popover).not.toContainText('different-host');
});

test('reloading an authoritative config after a revision conflict replaces machine fields without retaining a stale host',async({page,request})=>{
 await seed(request);await page.goto('/settings/execution-machines');
 await page.getByRole('region',{name:machine.name,exact:true}).getByRole('button',{name:'编辑',exact:true}).click();
 const editor=page.getByRole('region',{name:'编辑 '+machine.name,exact:true});
 await editor.getByRole('textbox',{name:'机器名称',exact:true}).fill('未保存机器名');
 const {config,revision}=await(await request.get('/api/config')).json();config.executionMachines[0]={...machine,name:'并发更新机器',host:'updated-linux'};
 expect((await request.put('/api/config',{data:{revision,config}})).ok()).toBe(true);
 await editor.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.settings-save-error')).toBeVisible();await page.getByRole('button',{name:'重新读取配置',exact:true}).click();
 const row=page.getByRole('region',{name:'并发更新机器',exact:true});await expect(row).toContainText('updated-linux');
 await row.getByRole('button',{name:'编辑',exact:true}).click();
 const again=page.getByRole('region',{name:'编辑 并发更新机器',exact:true});
 await expect(again.getByRole('textbox',{name:'SSH 目标',exact:true})).toHaveValue('updated-linux');
 await again.getByRole('textbox',{name:'机器名称',exact:true}).fill('仅修改名称');await again.getByRole('button',{name:'保存',exact:true}).click();await waitForAutosave(page);
 expect((await(await request.get('/api/config')).json()).config.executionMachines[0]).toMatchObject({name:'仅修改名称',host:'updated-linux'});
});
