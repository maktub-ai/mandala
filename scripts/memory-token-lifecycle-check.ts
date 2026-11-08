// Read a frozen snapshot, then test revocation only in fresh local copies. No model calls.
import {copyFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {strict as assert} from 'node:assert';
import {openStore} from '../server/store';
import {memoryServices} from '../server/memory-runtime';
import {DomainError} from '../shared/workspace-contracts';
const [snapshotPath,outputPath,factId,sceneId,profileId]=process.argv.slice(2);
if(!snapshotPath||!outputPath||!factId||!sceneId||!profileId)throw new Error('Usage: node --import tsx scripts/memory-token-lifecycle-check.ts snapshot.sqlite fresh-output factId sceneId profileId');
const output=resolve(outputPath);if(existsSync(output))throw new Error('Use a fresh output directory');mkdirSync(output,{recursive:true,mode:0o700});
const results=[];
for(const action of ['correct','retract','source-revoke','permission'] as const){
 const home=join(output,action);mkdirSync(home,{mode:0o700});copyFileSync(snapshotPath,join(home,'state.sqlite'));let revokedConversation:string|null=null;const store=openStore(home),{memory,recall}=memoryServices(home,store,(_p,id)=>{if(id===revokedConversation)throw new DomainError('forbidden',403,'controlled_source_permission_revoked');}),root={userId:store.ownerUserId};
 try{
  const fact=memory.read(root,factId),scene=memory.read(root,sceneId),profile=memory.read(root,profileId),collection=memory.collection(root,fact.collectionId),source=memory.source(root,fact.evidence[0].sourceId);
  assert.equal(fact.status,'active');assert.equal(scene.status,'active');assert.equal(profile.status,'active');
  const before=memory.list(root,{projectId:collection.projectId,status:'active'}),unrelated=before.find(r=>r.layer==='L1'&&r.recordId!==factId&&!r.evidence.some(e=>fact.evidence.some(old=>old.sourceId===e.sourceId))&&!r.dependencies.length)!;assert.ok(unrelated);
  if(action==='correct')memory.correct(root,{recordId:factId,expectedRevision:fact.revision,text:'受控纠正：原界面设计禁令已改为仅在验收前检查。'});
  if(action==='retract')memory.retract(root,{recordId:factId,expectedRevision:fact.revision});
  if(action==='source-revoke')memory.retractSource(root,{sourceId:source.id,expectedRevision:source.revision});
  if(action==='permission'){
   memory.read(root,sceneId,collection.projectId);assert.ok(source.conversationId);revokedConversation=source.conversationId;
   assert.throws(()=>memory.read(root,profileId,collection.projectId));assert.throws(()=>memory.read(root,sceneId,collection.projectId));assert.throws(()=>memory.validateReferences(root,{projectId:collection.projectId,items:[{recordId:factId,revision:fact.revision}]}));
  }else{
   assert.throws(()=>memory.validateReferences(root,{projectId:collection.projectId,items:[{recordId:factId,revision:fact.revision}]}));
   const after=memory.list(root,{projectId:collection.projectId,status:'active'});assert.ok(!after.some(r=>r.recordId===sceneId||r.recordId===profileId));
   const hits=recall.search(root,{projectId:collection.projectId,query:fact.text}).items;assert.ok(!hits.some(r=>r.recordId===sceneId||r.recordId===profileId||r.recordId===factId&&r.text===fact.text));
   if(action==='correct')assert.ok(after.some(r=>r.recordId===factId&&r.text.startsWith('受控纠正')));
  }
  assert.equal(memory.read(root,unrelated.recordId).text,unrelated.text);assert.equal(memory.read(root,unrelated.recordId).revision,unrelated.revision);
  results.push({action,passed:true,oldDerivedUnavailable:true,unrelatedRecordId:unrelated.recordId,modelCalls:0});
 }finally{store.close();}
}
writeFileSync(join(output,'result.json'),JSON.stringify(results,null,2),{mode:0o600});console.log(JSON.stringify(results));
