import {expect,test} from '@playwright/test';
import {storedUiState} from './helpers/preferences';

test.use({storageState:storedUiState('en')});
test('a large coordinator history can open and leave without a blank application',async({page,request})=>{
 test.setTimeout(60000);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const {conversation}=await(await request.get('/api/mandala')).json();
 const id=conversation.id,at='2026-10-30T17:00:00.000Z';
 const data=(eventId:number,kind:string,value:unknown)=>`id: ${eventId}\ndata: ${JSON.stringify({id:eventId,conversationId:id,kind,data:value,createdAt:at})}\n\n`;
 const parts=[data(1,'user',{text:'Synthetic large history'})];
 for(let i=2;i<140000;i++)parts.push(data(i,'tool',{method:'item/reasoning/textDelta',params:{turnId:'large',itemId:'reason',delta:'Synthetic historical reasoning. '}}));
 parts.push(data(140000,'text',{text:'Synthetic historical result',itemId:'answer',snapshot:true}),data(140001,'status',{status:'idle'}),'event: history-ready\ndata: {"cursor":140001}\n\n');
 await page.route('**/api/conversations/'+id+'/events?*',route=>route.fulfill({status:200,contentType:'text/event-stream',body:parts.join('')}));
 await page.goto('/mandala?conversation='+id);
 await expect(page.locator('.composer')).toBeVisible({timeout:30000});
 await expect(page.getByText('Synthetic historical result',{exact:true})).toBeVisible({timeout:30000});
 await page.getByRole('link',{name:'Projects',exact:true}).click();
 await expect(page).toHaveURL(/\/projects/);
 expect(errors).toEqual([]);
});
