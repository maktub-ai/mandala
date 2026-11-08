import {test,expect} from '@playwright/test';
import {setAppearanceMode} from './helpers/navigation';
test('progressive first-use App and legacy memory/draft frames fit both themes at all widths',async({page,request})=>{
 const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const original=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:original.revision,config:{version:2,projects:[],agents:[],runtimes:['codex','omp']}}});
 await page.route(url=>url.pathname==='/api/conversations',route=>route.request().method()==='GET'?route.fulfill({json:[]}):route.continue());
 await page.route('**/api/cli/status?*',route=>route.fulfill({json:{status:'ready',version:'synthetic'}}));
 const draft=await(await request.post('/api/knowledge',{data:{kind:'skill',title:'长期协作 · Long bilingual Skill draft',content:'# 可读内容\n\n'+ '保留精确资料、归属与来源。 '.repeat(40),scope:'global',status:'candidate',access:{mode:'owner'}}})).json();
 await request.post('/api/knowledge',{data:{kind:'memory',title:'Legacy preference',content:'准确保留中文偏好与长期上下文。',scope:'global',status:'active',level:'L1',access:{mode:'owner'}}});
 await page.goto('/');const guide=page.getByRole('region',{name:'开始使用 Mandala',exact:true});
 for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);
  for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:950});
   await expect(guide.getByRole('radio',{name:/^Codex/})).toHaveAttribute('aria-checked','true');await expect(guide.getByRole('button',{name:'用 Codex 开始',exact:true})).toBeEnabled();
   await page.screenshot({path:`/tmp/own-onboarding-${theme}-${width}-selected.png`});const box=await guide.boundingBox();if(width===390){expect(box!.x).toBeGreaterThanOrEqual(15);expect(box!.width).toBeLessThanOrEqual(360);}expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }
 for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:950});
  await page.goto('/mana?tab=memory');await expect(page.getByRole('heading',{name:'记忆',level:1,exact:true})).toBeVisible();await page.screenshot({path:`/tmp/own-memory-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/mana?tab=skill&knowledgeId='+draft.id);await expect(page.getByRole('heading',{name:draft.title,exact:true})).toBeVisible();await page.locator('.mana-detail summary').filter({hasText:'查看内容'}).click();if(width<=768)await expect(page.locator('.mana-filters')).toBeHidden();await page.screenshot({path:`/tmp/own-skill-draft-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }}
 expect(pageErrors).toEqual([]);
});
