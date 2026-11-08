import {test,expect} from '@playwright/test';

test.beforeEach(async({request,page})=>{
 const snapshot=await(await request.get('/api/config')).json();snapshot.config={version:2,projects:[],agents:[{id:'design-reader',name:'Design reader',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]}]};await request.put('/api/config',{data:snapshot});
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
});
for(const width of [1440,1024,768,390])for(const theme of ['light','dark'])test(`Settings and Market composition ${width} ${theme}`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});await page.addInitScript(theme=>localStorage.setItem('mana-theme',theme),theme);
 for(const route of ['/settings/general?agent=design-reader','/settings/runtimes','/settings/system','/settings/mcp','/mana/skills']){
  await page.goto(route);const main=page.locator('main.settings-main');await expect(main).not.toHaveClass(/object-experience/);
  const nav=page.getByRole('navigation',{name:'Settings and connections',exact:true});await expect(nav).toBeVisible();await expect(nav.getByRole('link')).toHaveCount(5);
  expect(await main.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  if(route.includes('general')){const gaps=await page.locator('.settings-page-body > section').evaluateAll(nodes=>nodes.slice(1).map((node,i)=>node.getBoundingClientRect().top-nodes[i].getBoundingClientRect().bottom));expect(Math.min(...gaps)).toBeGreaterThanOrEqual(24);const group=await page.locator('.theme-settings').boundingBox();if(width>=1024)expect(group!.width).toBeGreaterThan(width===1440?600:400);}
  await page.screenshot({path:info.outputPath(route.split('?')[0].replaceAll('/','-')+'.png'),fullPage:true});
 }
 await page.goto('/market');await expect(page.locator('.market-card').first()).toBeVisible();const cards=page.locator('.market-card');
 if(width>=1024){const a=await cards.nth(0).boundingBox(),b=await cards.nth(1).boundingBox();expect(Math.abs(a!.y-b!.y)).toBeLessThan(1);expect(b!.x).toBeGreaterThan(a!.x+a!.width);}
 expect(await page.locator('.market-main').evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('market.png'),fullPage:true});await cards.first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(cards.first()).toBeFocused();
 await page.getByRole('button',{name:'Installed',exact:true}).click();await expect(page.locator('.market-empty')).toBeVisible();
 await page.getByRole('button',{name:'Manage sources',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.screenshot({path:info.outputPath('sources.png')});await page.keyboard.press('Escape');
});
