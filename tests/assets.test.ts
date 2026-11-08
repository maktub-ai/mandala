import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
test('CAS and command replay publish immutable authorized versions', async () => {
 const home=mkdtempSync(join(tmpdir(),'assets-')), store=openStore(home), files=createAssetFiles(home), service=createAssets(store,files);
 const p={userId:'u',agentId:'a',runId:'r'};
 writeFileSync(join(home,'a.txt'),'secret');
 const staged=await files.stageFiles(p,'r',[{allowedRoot:home,relativePath:'a.txt',manifestPath:'document.md'}]);
 const asset=service.createAsset(p,{kind:'document',title:'test',owner:{userId:'u',agentId:'a'}});
 const input={assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'r',sourceVersions:[]}};
 const v1=service.publishAssetVersion(p,input,'one');
 expect(service.publishAssetVersion(p,input,'one')).toEqual(v1);
 expect(()=>service.publishAssetVersion(p,{...input,expectedHeadVersionId:v1.id},'one')).toThrow(expect.objectContaining({code:'idempotency_conflict',status:409,message:'idempotency_conflict'}));
 const v2=service.publishAssetVersion(p,{...input,expectedHeadVersionId:v1.id},'two');
 expect(v2.ordinal).toBe(2);
 expect(()=>service.publishAssetVersion(p,{...input,expectedHeadVersionId:v1.id},'three')).toThrow(expect.objectContaining({code:'head_conflict',status:409,message:'head_conflict'}));
 expect(()=>service.getAuthorizedVersion({userId:'u',agentId:'b'},{assetId:asset.id,versionId:v1.id})).toThrow(expect.objectContaining({status:403,message:'forbidden'}));
 store.close();
});
test('rollback leaves durable orphan, expired replay succeeds, and revoked sources block historical derived versions', async () => {
 const home=mkdtempSync(join(tmpdir(),'assets-')), store=openStore(home), files=createAssetFiles(home), service=createAssets(store,files);
 const user={userId:'u'}, a={userId:'u',agentId:'a',runId:'r'}, b={userId:'u',agentId:'b',runId:'s'};
 writeFileSync(join(home,'a.txt'),'same');
 const upload=async(p:typeof a)=>files.stageFiles(p,p.runId,[{allowedRoot:home,relativePath:'a.txt',manifestPath:'document.md'}]);
 const staged=await upload(a), other=await upload(b);
 expect(other.files[0].blobHash).toBe(staged.files[0].blobHash);
 const source=service.createAsset(a,{kind:'document',title:'source',owner:{userId:'u',agentId:'a'}});
 const body={assetId:source.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'r',sourceVersions:[]}};
 const beforeEvents=store.listOutbox(0);
 store.database.exec("CREATE TRIGGER fail_version AFTER INSERT ON command_dedup BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(()=>service.publishAssetVersion(a,body,'publish')).toThrow(expect.objectContaining({code:'storage_failure',status:500,message:'Storage transaction failed'}));
 expect(service.getAuthorizedAsset(user,source.id).headVersionId).toBeNull();
 expect(store.database.prepare('SELECT count(*) AS n FROM asset_versions').get()!.n).toBe(0);
 expect(store.listOutbox(0)).toEqual(beforeEvents);
 for(const table of ['artifact_links','command_dedup','asset_version_files','blobs'])expect(store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
 expect(existsSync(files.blobPath(staged.files[0].blobHash))).toBe(true);
 expect(readFileSync(files.blobPath(staged.files[0].blobHash),'utf8')).toBe('same');
 store.database.exec('DROP TRIGGER fail_version');
 const version=service.publishAssetVersion(a,body,'publish');
 const leasePath=join(home,'staging',staged.submissionId,'manifest.json');
 const lease=JSON.parse(readFileSync(leasePath,'utf8'));lease.manifest.expiresAt='2000-01-01T00:00:00Z';writeFileSync(leasePath,JSON.stringify(lease));
 expect(service.publishAssetVersion(a,body,'publish').id).toBe(version.id);
 const target=service.createAsset(b,{kind:'document',title:'target',owner:{userId:'u',agentId:'b'}});
 expect(()=>service.publishAssetVersion(b,{...body,assetId:target.id,provenance:{runId:'s',sourceVersions:[]}},'steal')).toThrow(expect.objectContaining({code:'forbidden',status:403,message:'Staging lease belongs to another principal or Run'}));
 const derived=service.createAsset(a,{kind:'document',title:'derived',owner:{userId:'u',agentId:'a'}});
 const fresh=await upload(a);
 const derivedVersion=service.publishAssetVersion(a,{...body,assetId:derived.id,submissionId:fresh.submissionId,provenance:{runId:'r',sourceVersions:[{assetId:source.id,versionId:version.id}]}},'derive');
 expect(()=>service.setAccess(user,derived.id,{mode:'all'},2)).toThrow(expect.objectContaining({code:'source_scope_conflict',status:403,message:'source_scope_conflict'}));
 service.setLifecycle(user,source.id,'retracted',2);
 expect(()=>service.getAuthorizedVersion(a,{assetId:derived.id,versionId:derivedVersion.id})).toThrow(expect.objectContaining({status:403,message:'forbidden'}));
 expect(()=>service.publishAssetVersion(a,body,'publish')).toThrow(expect.objectContaining({status:403,message:'forbidden'}));
 store.close();
});
test.each(['retracted','narrowed'] as const)('latest binding denies a %s necessary source', async (change) => {
 const home=mkdtempSync(join(tmpdir(),'assets-')), store=openStore(home), files=createAssetFiles(home), service=createAssets(store,files);
 const user={userId:'u'}, agent={userId:'u',agentId:'a',runId:'r'};
 writeFileSync(join(home,'source.txt'),'restricted source');
 const staged=await files.stageFiles(agent,'r',[{allowedRoot:home,relativePath:'source.txt',manifestPath:'document.md'}]);
 const source=service.createAsset(agent,{kind:'document',title:'source',owner:{userId:'u',agentId:'a'}});
 const input={expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'r',sourceVersions:[]}};
 const sv=service.publishAssetVersion(agent,{...input,assetId:source.id},'source');
 const derived=service.createAsset(agent,{kind:'skill',title:'derived',owner:{userId:'u',agentId:'a'}});
 const dv=service.publishAssetVersion(agent,{...input,assetId:derived.id,provenance:{runId:'r',sourceVersions:[{assetId:source.id,versionId:sv.id}]}},'derived');
 if(change==='retracted')service.setLifecycle(user,source.id,'retracted',2);
 else service.setAccess(user,source.id,{mode:'private'},2);
 expect(()=>service.getAuthorizedVersion(agent,{assetId:derived.id,versionId:dv.id})).toThrow(expect.objectContaining({code:'forbidden',status:403,message:'forbidden'}));
 expect(()=>service.bind(agent,{ownerType:'agent',ownerId:'a',assetId:derived.id,versionPolicy:'latest'})).toThrow(expect.objectContaining({code:'forbidden',status:403,message:'forbidden'}));
 expect(store.database.prepare('SELECT count(*) AS n FROM asset_bindings').get()!.n).toBe(0);
 store.close();
});
test('owner/private/selected/all keep grants distinct from bindings and personal identity', async () => {
 const home=mkdtempSync(join(tmpdir(),'assets-')), store=openStore(home), files=createAssetFiles(home), service=createAssets(store,files);
 const user={userId:'u'}, a={userId:'u',agentId:'a',runId:'r'}, b={userId:'u',agentId:'b'}, foreign={userId:'other',agentId:'a'};
 writeFileSync(join(home,'data.txt'),'private bytes');
 const staged=await files.stageFiles(a,'r',[{allowedRoot:home,relativePath:'data.txt',manifestPath:'document.md'}]);
 const asset=service.createAsset(a,{kind:'document',title:'private title',owner:{userId:'u',agentId:'a'}});
 expect(()=>service.bind(a,{ownerType:'agent',ownerId:'a',assetId:asset.id,versionPolicy:'latest'})).toThrow(expect.objectContaining({code:'asset_not_ready',status:409}));
 const v=service.publishAssetVersion(a,{assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'r',sourceVersions:[]}},'publish');
 const ref={assetId:asset.id,versionId:v.id};
 const denied=(p:typeof user)=>{
  try{service.getAuthorizedVersion(p,ref);throw new Error('read accepted');}catch(error){
   expect(error).toMatchObject({name:'DomainError',code:'forbidden',status:403,message:'forbidden'});
   expect(JSON.stringify(error)).not.toContain(staged.files[0].blobHash);
   expect(JSON.stringify(error)).not.toContain('private bytes');
   expect(service.listAssets(p)).toEqual([]);
  }
 };
 expect(service.getAuthorizedVersion(a,ref).id).toBe(v.id);denied(b);denied(foreign);
 service.bind(user,{ownerType:'agent',ownerId:'b',assetId:asset.id,versionPolicy:'latest'});
 denied(b);expect(store.database.prepare('SELECT count(*) AS n FROM asset_grants').get()!.n).toBe(0);
 expect(()=>service.setLifecycle(b,asset.id,'retracted',2)).toThrow(expect.objectContaining({status:403,code:'forbidden'}));
 let current=service.setAccess(user,asset.id,{mode:'private'},2);denied(a);denied(b);
 expect(service.getAuthorizedVersion(user,ref).id).toBe(v.id);
 current=service.setAccess(user,asset.id,{mode:'selected',agentIds:['b']},current.revision);
 denied(a);expect(service.getAuthorizedVersion(b,ref).id).toBe(v.id);
 current=service.setAccess(user,asset.id,{mode:'selected',projectIds:['project']},current.revision);denied(a);denied(b);
 current=service.setAccess(user,asset.id,{mode:'all'},current.revision);
 expect(service.getAuthorizedVersion(a,ref).id).toBe(v.id);expect(service.getAuthorizedVersion(b,ref).id).toBe(v.id);denied(foreign);
 expect(service.getAuthorizedVersion(a,ref).accessRevision).toBe(current.accessRevision);
 store.close();
});
test('GC retains all historical files, pins and leases, and discovers aged disk-only orphans', async () => {
 const { mkdirSync, utimesSync } = await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'assets-gc-')), store=openStore(home), files=createAssetFiles(home), service=createAssets(store,files), p={userId:'local'};
 writeFileSync(join(home,'a.txt'),'retained');
 const staged=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'a.txt',manifestPath:'document.md'}]);
 const imported=service.importAsset(p,{kind:'document',title:'retained',submissionId:staged.submissionId},'gc');
 service.pinVersion('run-1',{assetId:imported.asset.id,versionId:imported.version.id});
 writeFileSync(join(home,'a.txt'),'head2');
 const second=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'a.txt',manifestPath:'document.md'}]);
 service.publishAssetVersion(p,{assetId:imported.asset.id,expectedHeadVersionId:imported.version.id,submissionId:second.submissionId,files:second.files,provenance:{sourceVersions:[]}},'head2');
 const hash='a'.repeat(64), path=files.blobPath(hash);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'orphan');
 const now=Date.now(), old=new Date(now-86400001);utimesSync(path,old,old);
 expect(service.listGcCandidates(new Date(now).toISOString()).map(x=>x.blobHash)).toEqual([hash]);
 expect(()=>service.pinVersion('run-2',{assetId:'wrong',versionId:imported.version.id})).toThrow();
 const fresh='b'.repeat(64), freshPath=files.blobPath(fresh);mkdirSync(join(freshPath,'..'),{recursive:true});writeFileSync(freshPath,'fresh');
 writeFileSync(join(home,'a.txt'),'leased');const leased=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'a.txt',manifestPath:'document.md'}]);utimesSync(files.blobPath(leased.files[0].blobHash),old,old);
 expect(service.listGcCandidates(new Date(now+100).toISOString()).map(x=>x.blobHash)).toEqual([hash]);
 store.close();
});
test('legacy repeated diamond authority visits each node once and rechecks revoked nested sources on a later read',async()=>{
 const {vi}=await import('vitest'),{rmSync}=await import('node:fs');const home=mkdtempSync(join(tmpdir(),'asset-graph-')),store=openStore(home),files=createAssetFiles(home),assets=createAssets(store,files),p={userId:'local'};
 try{writeFileSync(join(home,'input'),'graph');const stage=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'input',manifestPath:'graph.txt'}]);
 const nodes:ReturnType<typeof assets.importAsset>[]=[];for(let i=0;i<8;i++){const refs=nodes.flatMap(node=>[{assetId:node.asset.id,versionId:node.version.id},{assetId:node.asset.id,versionId:node.version.id}]);nodes.push(assets.importAsset(p,{kind:'file',title:'Node'+i,submissionId:stage.submissionId,sourceVersions:refs},'node-'+i));}
 const spy=vi.spyOn(store.database,'prepare'),last=nodes.at(-1)!;assets.getAuthorizedVersion(p,{assetId:last.asset.id,versionId:last.version.id});const reads=spy.mock.calls.filter(([sql])=>sql==='SELECT data FROM asset_versions WHERE id=? AND asset_id=?').length;spy.mockRestore();expect(reads).toBe(8);
 assets.setLifecycle(p,nodes[0].asset.id,'retracted',nodes[0].asset.revision);expect(()=>assets.getAuthorizedVersion(p,{assetId:last.asset.id,versionId:last.version.id})).toThrow('forbidden');
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
test('asset authority rejects a cyclic persisted graph instead of recursion overflow',async()=>{
 const {rmSync}=await import('node:fs');const home=mkdtempSync(join(tmpdir(),'asset-cycle-')),store=openStore(home),files=createAssetFiles(home),assets=createAssets(store,files),p={userId:'local'};
 try{writeFileSync(join(home,'input'),'cycle');const stage=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'input',manifestPath:'graph.txt'}]);const a=assets.importAsset(p,{kind:'file',title:'Cycle',submissionId:stage.submissionId},'cycle');store.database.prepare('UPDATE asset_versions SET data=? WHERE id=?').run(JSON.stringify({...a.version,provenance:{sourceVersions:[{assetId:a.asset.id,versionId:a.version.id}]}}),a.version.id);expect(()=>assets.getAuthorizedVersion(p,{assetId:a.asset.id,versionId:a.version.id})).toThrow(expect.objectContaining({code:'asset_source_cycle',status:403}));
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
