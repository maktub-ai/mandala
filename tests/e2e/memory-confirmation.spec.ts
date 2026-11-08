import {expect} from '@playwright/test';
import {test} from './helpers/isolated-authority';
test('retired confirmation and correction endpoints preserve legacy candidate content, status and revision',async({isolatedAuthority})=>{
 const {request}=isolatedAuthority;
 const entry=await(await request.post('/api/knowledge',{data:{kind:'memory',level:'L3',title:'Historical synthetic candidate',content:'Synthetic retained legacy rule.',status:'candidate',scope:'global'}})).json();
 const records=await(await request.get('/api/v2/memory/records')).json(),candidate=records.records.find((r:any)=>r.legacyId===entry.id);
 expect(candidate).toMatchObject({layer:'L1',status:'proposed',revision:1});
 for(const action of ['confirm','correct']){
  const response=await request.post('/api/v2/memory/records/'+candidate.recordId+'/'+action,{data:{expectedRevision:1,...action==='correct'?{text:'Changed rule'}:{}}});
  expect(response.status()).toBe(410);expect(await response.json()).toMatchObject({error:'legacy_memory_confirmation_retired'});
  expect(await(await request.get('/api/v2/memory/records/'+candidate.recordId)).json()).toEqual(candidate);
 }
 const patch=await request.patch('/api/knowledge/'+entry.id,{data:{status:'active'}});expect(patch.status()).toBe(410);
 expect(await(await request.get('/api/v2/memory/records/'+candidate.recordId)).json()).toEqual(candidate);
 expect((await request.post('/api/v2/memory/records/'+candidate.recordId+'/retract',{data:{expectedRevision:1}})).ok()).toBe(true);
 const withdrawn=await(await request.get('/api/v2/memory/records/'+candidate.recordId)).json();
 expect(withdrawn).toMatchObject({status:'retracted',revision:2});
 expect((await request.post('/api/v2/memory/records/'+candidate.recordId+'/correct',{data:{expectedRevision:2,text:'Changed rule'}})).status()).toBe(410);
 expect((await request.patch('/api/knowledge/'+entry.id,{data:{content:'Changed rule'}})).status()).toBe(410);
 expect(await(await request.get('/api/v2/memory/records/'+candidate.recordId)).json()).toEqual(withdrawn);
});
