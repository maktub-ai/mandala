import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import {createMemoryRecall} from '../server/memory-recall';
import type {MemoryProposal} from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-profile-scope-')),store=openStore(home),assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets});
 const members=new Map([['p',new Set(['a','b'])],['q',new Set(['a'])]]);
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeProject:(p,id)=>{if(p.agentId&&!members.get(id)?.has(p.agentId))throw Error('forbidden');}});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 function scene(projectId='p',agentId='a',text='Verify deliveries with source evidence.'){
  const c=memory.ensureCollection(root,{projectId,agentId}),chat=store.createConversation({projectId,agentId,cli:'codex',model:null});
  const event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
  const source=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  const proposal:MemoryProposal={collectionId:c.id,layer:'L1',contentType:'procedure',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'};
  const fact=memory.applyProposal(root,proposal,c.generation,'evidence_extract')!;
  const record=memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:'scene.delivery',support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary')!;
  return {c,record,source};
 }
 const profile=(s:ReturnType<typeof scene>,agentId:string|null,text=s.record.text,replaces:MemoryProposal['replaces']=[])=>memory.applyProposal(root,{collectionId:s.c.id,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',text,operation:replaces.length?'update':'store',replaces,evidence:s.record.evidence,support:[],dependencies:[{recordId:s.record.recordId,revision:s.record.revision}],validUntil:null,certainty:'observed'},memory.collection(root,s.c.id).generation,'layer_summary',{profileScope:{projectId:s.c.projectId,agentId}})!;
 return {home,store,memory,members,scene,profile};
}
test('each project and agent pair keeps one fixed L3 record with immutable versions',()=>{
 const s=setup(),scene=s.scene(),first=s.profile(scene,'a'),second=s.profile(scene,'a','Use verifiable evidence for each delivery.',[{recordId:first.recordId,revision:first.revision}]);
 expect(second.recordId).toBe(first.recordId);expect(second).toMatchObject({revision:2,status:'active',profileScope:{projectId:'p',agentId:'a'}});
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L3')).toHaveLength(1);
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_revisions WHERE record_id=? AND revision=1').get(first.recordId)!.data as string)).toEqual(first);
});
test('two agents share L2 but cannot read or recall each other\'s L3',()=>{
 const s=setup(),scene=s.scene(),a=s.profile(scene,'a'),b=s.profile(scene,'b');
 expect(a.recordId).not.toBe(b.recordId);
 expect(()=>s.memory.read({...root,agentId:'b'},a.recordId,'p')).toThrow('profile_scope_mismatch');
 const recall=createMemoryRecall(s.memory);
 expect(recall.search({...root,agentId:'a'},{projectId:'p',query:'',layers:['L3']}).items.map(r=>r.recordId)).toEqual([a.recordId]);
 expect(recall.search({...root,agentId:'b'},{projectId:'p',query:'',layers:['L3']}).items.map(r=>r.recordId)).toEqual([b.recordId]);
 expect(recall.search(root,{projectId:'p',query:'',layers:['L3']}).items).toEqual([]);
});
test('the same agent has separate L3 documents in separate projects',()=>{
 const s=setup(),p=s.profile(s.scene('p'),'a'),q=s.profile(s.scene('q'),'a'),recall=createMemoryRecall(s.memory);
 expect(p.recordId).not.toBe(q.recordId);
 expect(recall.search({...root,agentId:'a'},{projectId:'q',query:'',layers:['L3']}).items.map(r=>r.recordId)).toEqual([q.recordId]);
});
test('an existing profile requires an exact current revision and cannot be stored as a second document',()=>{
 const s=setup(),scene=s.scene(),first=s.profile(scene,'a');
 expect(()=>s.profile(scene,'a','Different rule.')).toThrow('profile_update_required');
 const second=s.profile(scene,'a','Updated rule.',[{recordId:first.recordId,revision:first.revision}]);
 expect(()=>s.profile(scene,'a','Stale overwrite.',[{recordId:first.recordId,revision:first.revision}])).toThrow('revision_conflict');
 expect(s.memory.read(root,second.recordId).text).toBe('Updated rule.');
});
test('revoking a shared scene invalidates the profile and regeneration reuses its stable ID',()=>{
 const s=setup(),old=s.scene(),first=s.profile(old,'a');
 s.memory.retract(root,{recordId:old.record.recordId,expectedRevision:old.record.revision});
 const inactive=JSON.parse(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(first.recordId)!.data as string);
 expect(inactive.status).toBe('stale');
 const fresh=s.scene('p','a','Check both evidence and target data.'),renewed=s.profile(fresh,'a',fresh.record.text,[{recordId:first.recordId,revision:inactive.revision}]);
 expect(renewed).toMatchObject({recordId:first.recordId,revision:inactive.revision+1,status:'active'});
});

test('current-profile lookup treats null as an exact slot and enforces live membership',()=>{
 const s=setup(),scene=s.scene(),a=s.profile(scene,'a'),anonymous=s.profile(scene,null);
 expect(s.memory.profile(root,{projectId:'p',agentId:null})?.recordId).toBe(anonymous.recordId);
 expect(s.memory.profile({...root,agentId:'a'},{projectId:'p',agentId:'a'})?.recordId).toBe(a.recordId);
 s.members.get('p')!.delete('a');
 expect(()=>s.memory.profile(root,{projectId:'p',agentId:'a'})).toThrow('forbidden');
});

test('retiring old shared L3 preserves its history and fences unscoped queued jobs',()=>{
 const s=setup(),scene=s.scene(),typed=s.profile(scene,'a');
 const old={...typed,recordId:'old-project-profile',profileScope:undefined};
 s.store.database.prepare('INSERT INTO memory_records VALUES(?,?,?)').run(old.recordId,old.collectionId,JSON.stringify(old));
 s.store.database.prepare('INSERT INTO memory_revisions VALUES(?,?,?)').run(old.recordId,old.revision,JSON.stringify(old));
 const job={id:'old-profile-job',collectionId:scene.c.id,principal:root,state:'running',stage:'profile',leaseToken:3,leaseUntil:'2050-01-01',sourceRefs:[],generation:1,error:null};
 s.store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,job.id,JSON.stringify(job));
 expect(s.memory.retireUnscopedProfiles(root)).toEqual({retired:1});
 expect(s.memory.retireUnscopedProfiles(root)).toEqual({retired:0});
 const row=JSON.parse(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(old.recordId)!.data as string);
 expect(row).toMatchObject({status:'stale',revision:2,text:old.text});
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_revisions WHERE record_id=? AND revision=1').get(old.recordId)!.data as string)).toEqual(JSON.parse(JSON.stringify(old)));
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(job.id)!.data as string)).toMatchObject({state:'obsolete',leaseToken:4,error:'profile_scope_migrated'});
 expect(s.memory.profile(root,{projectId:'p',agentId:'a'})?.recordId).toBe(typed.recordId);
});
test('withdrawing one agent profile does not suppress an identical profile of another agent',()=>{
 const s=setup(),scene=s.scene(),a=s.profile(scene,'a'),b=s.profile(scene,'b');
 s.memory.retract(root,{recordId:a.recordId,expectedRevision:a.revision});
 const updated=s.profile(scene,'b',b.text,[{recordId:b.recordId,revision:b.revision}]);
 expect(updated.status).toBe('active');expect(s.memory.profile(root,{projectId:'p',agentId:'b'})?.recordId).toBe(b.recordId);
});

test('edited old source can be replaced without exposing old body or changing profile identity',()=>{
 const s=setup(),old=s.scene(),first=s.profile(old,'a');
 s.store.replaceHistory(old.source.conversationId!,old.source.events[0].id,'edited-thread');
 expect(s.memory.profile({...root,agentId:'a'},{projectId:'p',agentId:'a'})).toBeNull();
 const draft=s.memory.profile({...root,agentId:'a'},{projectId:'p',agentId:'a'},true)!;
 expect(draft).toMatchObject({recordId:first.recordId,revision:first.revision,status:'stale',text:'',evidence:[],dependencies:[]});
 const fresh=s.scene('p','a','Use the updated verifiable delivery process.'),updated=s.profile(fresh,'a',fresh.record.text,[{recordId:draft.recordId,revision:draft.revision}]);
 expect(updated).toMatchObject({recordId:first.recordId,revision:2,status:'active',text:fresh.record.text});expect(s.memory.profile({...root,agentId:'a'},{projectId:'p',agentId:'a'})?.recordId).toBe(first.recordId);
});

test('automatic updates preserve a user-corrected profile rather than replacing its body',()=>{
 const s=setup(),scene=s.scene(),first=s.profile(scene,'a'),corrected=s.memory.correct(root,{recordId:first.recordId,expectedRevision:first.revision,text:'Use the user-confirmed delivery rule.'});
 expect(()=>s.profile(scene,'a','An automatic changed rule.',[{recordId:corrected.recordId,revision:corrected.revision}])).toThrow('profile_user_correction_requires_review');
 expect(s.memory.profile({...root,agentId:'a'},{projectId:'p',agentId:'a'})).toMatchObject({recordId:first.recordId,text:corrected.text,revision:corrected.revision});
});
