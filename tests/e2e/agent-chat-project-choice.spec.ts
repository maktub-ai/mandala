import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';

test.beforeEach(async({request})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 const agents=['single','shared','unbound'].map(id=>({id,name:id,instructions:'Synthetic project selection fixture.',defaultCli:'codex',models:{},mcp:[],skills:[]}));
 const projects=[{id:'p',name:'Project P',agentIds:['single','shared']},{id:'q',name:'Project Q',agentIds:['shared']}].map(project=>({...project,cwd:'',resources:[],mcp:[],skills:[]}));
 const saved=await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents.filter((agent:{systemRole?:string})=>agent.systemRole),...agents],projects}}});
 expect(saved.ok(),await saved.text()).toBe(true);
});

test('defaults a sole associated project and starts the chat in that project',async({page},testInfo)=>{
 await page.goto('/agents/single');
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);
  await page.setViewportSize({width,height:1000});await page.goto('/agents/single');
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await expect(page.getByRole('region',{name:'关联项目',exact:true})).toContainText('Project P');
  await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','p');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`agent-project-${theme}-${width}.png`)});
 }
 await page.locator('.object-header').getByRole('button',{name:'开始对话',exact:true}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/'&&url.searchParams.get('project')==='p'&&url.searchParams.get('agent')==='single');
});

test('preserves an explicit choice to start without a project',async({page})=>{
 await page.goto('/agents/single');
 await chooseOption(page,'对话所属项目','');
 await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','');
 await page.locator('.object-header').getByRole('button',{name:'开始对话',exact:true}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/'&&url.searchParams.get('project')===''&&url.searchParams.get('agent')==='single');
});

test('requires a choice for multiple projects and retains valid incoming project context',async({page})=>{
 await page.goto('/agents/shared');
 await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','');
 await page.goto('/agents/shared?project=q');
 await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','q');
 await page.locator('.object-header').getByRole('button',{name:'开始对话',exact:true}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/'&&url.searchParams.get('project')==='q'&&url.searchParams.get('agent')==='shared');
});

test('keeps an unassociated Agent without a project and ignores unrelated context',async({page})=>{
 await page.goto('/agents/unbound?project=p');
 await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','');
 await page.goto('/agents/single?project=q');
 await expect(page.getByRole('combobox',{name:'对话所属项目',exact:true})).toHaveAttribute('data-value','p');
});
