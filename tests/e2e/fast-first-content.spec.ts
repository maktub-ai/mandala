import {test,expect} from './helpers/execution-fixture';

test('opens the known Mandala chat without waiting for another configuration read',async({page,request})=>{
 const {ordinary,mandala}=await(await request.post('/__test__/chat-history')).json();
 await page.goto('/?conversation='+ordinary);
 await expect(page.locator('.messages').getByText('History answer 25',{exact:true})).toBeVisible();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/mandala',async route=>{await held;await route.continue();});
 try{
  await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'Mandala',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('/mandala\\?conversation='+mandala),{timeout:1000});
  await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();
  await expect(page.locator('.messages').getByText('History answer 25',{exact:true})).toBeVisible();
 }finally{release();}
});

test('cold opens and chat switches use compact history without losing the answer or reasoning',async({page,request})=>{
 const {ordinary,mandala}=await(await request.post('/__test__/chat-history-dense')).json();
 const streams:string[]=[];page.on('request',request=>{if(request.url().includes('/events?'))streams.push(request.url());});
 for(const id of [ordinary,mandala]){
  const history=await request.get('/api/conversations/'+id+'/history?recent=5&compact=1');
  expect((await history.body()).byteLength).toBeLessThan(20000);
  const start=Date.now();await page.goto((id===ordinary?'/':'/mandala')+'?conversation='+id);
  await expect(page.locator('.messages').getByText('History answer 25',{exact:true})).toBeVisible();
  test.info().annotations.push({type:id===ordinary?'cold-content-ms':'mandala-content-ms',description:String(Date.now()-start)});
  expect(streams.some(url=>url.includes('/'+id+'/events?')&&url.includes('compact=1'))).toBe(true);
  const turn=page.locator('.chat-turn').filter({hasText:'History request 25'});
  await turn.getByRole('button',{name:'展开本轮过程',exact:true}).click();
  await turn.locator('.run-reasoning-summary > summary').click();
  await expect(turn.locator('.run-reasoning-summary p').filter({hasText:'Synthetic final reasoning'})).toBeVisible();
 }
 const switched=Date.now();
 await page.getByRole('button',{name:'Dense history',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('conversation='+ordinary));
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();
 await expect(page.locator('.messages').getByText('History answer 25',{exact:true})).toBeVisible();
 test.info().annotations.push({type:'switch-content-ms',description:String(Date.now()-switched)});
 expect(streams.filter(url=>url.includes('/'+ordinary+'/events?')&&url.includes('compact=1')).length).toBeGreaterThan(1);
 await page.screenshot({path:test.info().outputPath('history-light.png')});
 await page.emulateMedia({colorScheme:'dark'});
 await page.screenshot({path:test.info().outputPath('history-dark.png')});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:test.info().outputPath('history-narrow.png')});
});
