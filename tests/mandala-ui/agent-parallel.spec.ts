import {expect,test} from '@playwright/test';
for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`Agent parallel limit persists ${mode} ${width}`,async({page,request},testInfo)=>{
 await request.post('/__test__/mandala-panels');
 const current=await(await request.get('/api/config')).json();
 const config=current.config??current;
 const agent=config.agents.find((a:{systemRole?:string})=>!a.systemRole);
 expect(agent).toBeTruthy();
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);
 await page.setViewportSize({width,height:1000});
 await page.goto('/agents/'+agent.id+'?tab=execution');
 const limit=page.getByRole('spinbutton',{name:'后台并行上限',exact:true});
 await expect(limit).toBeVisible();
 await limit.fill('2');
 await expect.poll(async()=>{const body=await(await request.get('/api/config')).json();return(body.config??body).agents.find((a:{id:string})=>a.id===agent.id).maxParallel;}).toBe(2);
 await page.reload();await expect(limit).toHaveValue('2');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath(`agent-parallel-${mode}-${width}.png`),fullPage:true});
});
