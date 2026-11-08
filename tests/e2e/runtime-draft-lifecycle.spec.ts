import { expect, test, type APIRequestContext } from '@playwright/test';
const defaults={args:['--profile','saved-profile'],env:{SERVICE:'${RUNTIME_SAVED_SOURCE}'},approvalMode:'auto',fullAccess:false};
async function seed(request:APIRequestContext){
 const current=await (await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision:current.revision,config:{version:2,runtimes:['codex'],projects:[],agents:[{id:'draft-agent',name:'Draft Agent',defaultCli:'codex',instructions:'Synthetic',models:{},mcp:[],skills:[]}],runtimeDefaults:{codex:defaults}}}})).ok()).toBe(true);
}
test('saved Runtime defaults hydrate on direct load and refresh and survive no-op saves',async({page,request})=>{
 await seed(request);
 for(let pass=0;pass<2;pass++){
  if(pass===0)await page.goto('/settings/runtimes/codex');else await page.reload();
  await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--profile\nsaved-profile');
  await expect(page.getByRole('textbox',{name:'变量名称',exact:true})).toHaveValue('SERVICE');
  await expect(page.getByRole('textbox',{name:'环境变量来源名称',exact:true})).toHaveValue('RUNTIME_SAVED_SOURCE');
  await expect(page.getByRole('combobox',{name:'文件和网络权限',exact:true})).toHaveAttribute('data-value','native');
 }
 await expect(page.getByRole('button',{name:'保存配置',exact:true})).toHaveCount(0);
 expect((await (await request.get('/api/config')).json()).config.runtimeDefaults.codex).toEqual(defaults);
});
test('Runtime changes save automatically before refresh or leaving the page',async({page,request})=>{
 await seed(request);await page.goto('/settings/runtimes/codex');
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--strict-config');
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.runtimeDefaults.codex.args).toEqual(['--strict-config']);
 await page.reload();await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--strict-config');
 await page.getByRole('link',{name:'通用设置',exact:true}).click();await expect(page).toHaveURL('/settings/general');
});
test('delayed automatic Runtime save preserves newer input and unrelated settings',async({page,request})=>{
 await seed(request);await page.goto('/settings/runtimes');await page.getByRole('region',{name:'Codex',exact:true}).getByRole('button',{name:'配置',exact:true}).click();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let submitted=false;
 await page.route('**/api/config',async route=>{if(route.request().method()==='PUT'){submitted=true;await gate;await route.continue();}else await route.continue();});
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--strict-config');await expect.poll(()=>submitted).toBe(true);
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--newer-profile');
 await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--newer-profile');
 release();await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.runtimeDefaults.codex.args).toEqual(['--newer-profile']);
 const saved=(await (await request.get('/api/config')).json()).config;expect(saved.runtimeDefaults.codex.args).toEqual(['--newer-profile']);expect(saved.agents[0].name).toBe('Draft Agent');
});
