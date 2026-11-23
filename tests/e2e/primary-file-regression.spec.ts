import {expect,test} from '@playwright/test';
for(const primaryRawHref of [false,true])test('primary chat opens a saved HTML version via '+(primaryRawHref?'historical absolute path':'pinned asset link'),async({page,request})=>{
 const primary=await(await request.get('/api/mandala')).json(), id=primary.conversation.id;
 expect(primary.conversation.purpose).toBe('mandala-main');
 const r=await request.post('/__test__/published-deliverable',{data:{conversationId:id,primaryHtml:true,primaryRawHref}});
 expect(r.ok()).toBe(true);const asset=await r.json();
 const expected='/api/v2/assets/'+asset.asset.id+'/versions/'+asset.version.id+'/files/0';
 expect((await request.get(expected)).ok()).toBe(true);
 const newerStage=await(await request.post('/api/v2/assets/uploads?name='+asset.name,{data:'<h1>New head HTML</h1>'})).json();
 expect((await request.post('/api/v2/assets/'+asset.asset.id+'/versions',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedHeadVersionId:asset.version.id,submissionId:newerStage.submissionId,provenance:{sourceVersions:[]}}})).ok()).toBe(true);
 await page.goto('/?conversation='+id);
 const link=page.getByRole('link',{name:primaryRawHref?'Synthetic historical result':'Synthetic result',exact:true});
 await expect(link).toHaveAttribute('href','/assets/'+asset.asset.id+'?version='+asset.version.id,{timeout:8000});
 const instrument=page.locator('#chat-environment-panel'), frame=instrument.locator('iframe[title="synthetic-primary.html"]'), scheduled=instrument.getByRole('tab',{name:/^定时$|^Scheduled$/});
 await scheduled.click();
 await expect(scheduled).toHaveAttribute('aria-selected','true');
 await link.click();
 await expect(scheduled).toBeHidden();
 const preview=async()=>{
  await expect(instrument.getByRole('heading',{name:'synthetic-primary.html',exact:true})).toBeVisible({timeout:5000});
  await expect(frame).toHaveAttribute('src',expected+'?preview=1');
  await expect(frame).toHaveAttribute('sandbox','allow-scripts');
  await expect(frame.contentFrame().getByRole('heading',{name:'Synthetic saved HTML'})).toBeVisible();
 };
 await preview();
 await instrument.getByRole('button',{name:/关闭预览|Close preview/}).click();
 await expect(scheduled).toBeVisible();await expect(scheduled).toHaveAttribute('aria-selected','true');
 await link.click();await preview();
});
