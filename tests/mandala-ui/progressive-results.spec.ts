import {expect,test} from '@playwright/test';

test.beforeAll(async({request})=>{await request.post('/__test__/chat-history');await request.post('/__test__/execution-results');});

for(const readingEarlier of [false,true])test(`late result cards preserve ${readingEarlier?'earlier reading':'the latest reply'}`,async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 const results=await(await request.get('/api/conversations/'+fixture.mainId+'/results')).json();
 const cards=[{...results[1],createdAt:new Date(Date.now()+1000).toISOString(),summary:'Deferred result details. '.repeat(300)}];
 const history=await(await request.get('/api/conversations/'+fixture.mainId+'/history?recent=5&compact=1')).json();
 await page.route('**/api/conversations/'+fixture.mainId+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:history.events.map((event:unknown)=>'data: '+JSON.stringify(event)+'\n\n').join('')+'event: history-ready\ndata: {}\n\n'}));
 let requested=false;let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/conversations/'+fixture.mainId+'/results',async route=>{requested=true;await held;await route.fulfill({json:cards});});
 try{
  await page.goto('/mandala');
  const viewport=page.locator('.conversation'),gap=()=>viewport.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop);
  await expect(page.locator('.messages')).toContainText('History answer 25');
  await expect.poll(gap).toBeLessThan(4);
  await expect.poll(()=>requested).toBe(true);
  if(readingEarlier){await viewport.hover();await page.mouse.wheel(0,-250);await expect.poll(gap).toBeGreaterThan(100);}
  const initialHeight=await viewport.evaluate(el=>el.scrollHeight);
  release();
  await expect(page.locator('.execution-result')).toHaveCount(1);
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight)).toBeGreaterThan(initialHeight+300);
  if(readingEarlier)await expect.poll(gap).toBeGreaterThan(100);
  else await expect.poll(gap).toBeLessThan(4);
 }finally{release();}
});
