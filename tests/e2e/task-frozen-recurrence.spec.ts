import {expect,test} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
test.use({storageState:storedUiState('en'),viewport:{width:1280,height:850}});

test('run history displays complete frozen workday and custom weekday recurrences',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'frozen-recurrence'},data:{goal:'Frozen recurrence example',acceptance:'human'}})).json();
 const detail=await(await request.get('/api/v2/tasks/'+task.id)).json(),control=await(await request.get('/api/v2/tasks/'+task.id+'/control')).json();
 const runs=[[1,2,3,4,5],[1,3,5]].map((weekdays,index)=>({id:'frozen-'+index,state:'succeeded',attempt:index+1,createdAt:'2026-10-01T01:00:00.000Z',artifactVersions:[],snapshot:{goal:'Frozen work '+index,criteria:[],rule:{revision:index+1,schedule:{kind:'weekly',weekdays,time:'09:00',timeZone:'Asia/Singapore'}}}}));
 await page.route('**/api/v2/tasks/'+task.id,route=>route.fulfill({json:{...detail,runs}}));
 await page.route('**/api/v2/tasks/'+task.id+'/control',route=>route.fulfill({json:{...control,runs}}));
 await page.goto('/tasks/'+task.id);
 await page.locator('.task-run-history > summary').click();
 const records=page.locator('.task-run-record');await expect(records).toHaveCount(2);
 for(const record of await records.all()){
  if(!(await record.evaluate(node=>node.hasAttribute('open'))))await record.locator(':scope > summary').click();
  await record.getByText('Goal and rule at execution',{exact:true}).click();
 }
 await expect(records.filter({hasText:'Frozen work 0'})).toContainText('Weekdays 09:00 (Asia/Singapore)');
 await expect(records.filter({hasText:'Frozen work 1'})).toContainText('Mon, Wed, Fri 09:00 (Asia/Singapore)');
 await records.filter({hasText:'Frozen work 1'}).screenshot({path:'/private/tmp/mandala-frozen-custom-weekdays.png'});
 await records.filter({hasText:'Frozen work 0'}).screenshot({path:'/private/tmp/mandala-frozen-workdays.png'});
});
