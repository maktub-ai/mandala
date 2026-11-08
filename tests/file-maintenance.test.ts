import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { createMemoryRuntime } from '../server/memory-runtime';
import { createFileMaintenance } from '../server/file-maintenance';
import { workspacePrincipal } from '../server/workspace-identity';
import { getUsage } from '../server/usage';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanups.splice(0))await fn();});
async function setup(output='{"operation":"replace","text":"计划：已完成验证"}') {
 const home=mkdtempSync(join(tmpdir(),'file-maintenance-')),store=openStore(home),root=workspacePrincipal(store),config=(await readConfig(home)).config;
 config.agents=[{id:'a',name:'Agent',instructions:'',defaultCli:'codex',models:{codex:'fixture-model'},mcp:[],skills:[]}];
 config.projects=[{id:'p',name:'Project',cwd:home,agentIds:['a'],mcp:[],skills:[],resources:[]}];
 writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const files=createAssetFiles(home),assets=createAssets(store,files);
 writeFileSync(join(home,'input'),'计划：待验证');
 const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'input',manifestPath:'notes/roadmap.md'}]);
 const imported=assets.importAsset(root,{kind:'file',title:'Roadmap',submissionId:stage.submissionId},'import');
 const memoryRuntime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:false,embed:async texts=>texts.map(()=>[1,0]),generate:async(_c,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage==='conflict')return JSON.stringify(data.atoms);
  const layer=data.stage==='extract'?'L1':data.stage==='scene'?'L2':'L3';
  if(layer==='L1')return JSON.stringify(data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').map((event:any)=>({collectionId:data.collectionId,layer,contentType:'fact',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies:[],validUntil:null,certainty:'user_asserted'}))));
  const parents=data.records.filter((r:any)=>r.layer===(layer==='L2'?'L1':'L2')),old=data.records.find((r:any)=>r.layer===layer);
  return JSON.stringify(parents.length?[{collectionId:data.collectionId,layer,semanticKey:layer==='L2'?'scene.verification':'persona.operating-doctrine',contentType:'fact',text:parents.map((r:any)=>r.text).join('\n'),operation:old?'update':'store',replaces:old?[{recordId:old.recordId,revision:old.revision}]:[],evidence:[...new Map(parents.flatMap((r:any)=>r.evidence).map((e:any)=>[JSON.stringify(e),e])).values()],support:[],dependencies:parents.map((r:any)=>({recordId:r.recordId,revision:r.revision})),validUntil:null,certainty:'observed'}]:[]);
 }});await memoryRuntime.initialize();
 const generate=vi.fn(async(_config:unknown,_prompt:string,_signal:AbortSignal)=>output);
 let service=createFileMaintenance({home,store,loadConfig:async()=>config,memoryRuntime,generate});
 cleanups.push(async()=>{await service.close();await memoryRuntime.close();store.close();rmSync(home,{recursive:true,force:true});});
 const enable=()=>service.configure(root,imported.asset.id,{enabled:true,agentId:'a',projectId:'p',expectedRevision:service.status(root,imported.asset.id).revision});
 const summary=async(agentId='a',projectId='p')=>{const chat=store.createConversation({agentId,projectId,cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:'验证完成 '+store.listConversations().length});store.appendEvent(chat.id,'text',{text:'收到'});store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);await memoryRuntime.captureConversation(chat.id,'completed','request');await memoryRuntime.drain();return chat;};
 return {home,store,root,config,files,assets,imported,memoryRuntime,generate,get service(){return service;},enable,summary,restart:async()=>{await service.close();service=createFileMaintenance({home,store,loadConfig:async()=>config,memoryRuntime,generate});}};
}
test('maintenance conditions persist, guide generation and can be cleared without changing the default',async()=>{
 const s=await setup('{"operation":"unchanged"}'),id=s.imported.asset.id;
 const conditions='仅当验证完成时更新“验证”章节；保留其他计划。';
 await s.service.configure(s.root,id,{enabled:true,agentId:'a',projectId:'p',expectedRevision:0,conditions});
 await s.restart();expect(s.service.status(s.root,id)).toMatchObject({conditions,revision:1});
 await s.summary();await s.service.reconcile();await s.service.drain();
 const prompt=s.generate.mock.calls[0][1];expect(prompt).toContain(JSON.stringify(conditions));expect(prompt).toContain('completedMemoryProgress');expect(prompt).toContain('No tools');
 expect(s.assets.listVersions(s.root,id)).toHaveLength(1);
 await s.service.configure(s.root,id,{enabled:true,agentId:'a',projectId:'p',expectedRevision:1,conditions:''});
 expect(s.service.status(s.root,id)).toMatchObject({conditions:'',revision:2});
});
test.each([123,'x'.repeat(4001),'bad\0condition'])('invalid maintenance conditions never change the policy (%s)',async conditions=>{
 const s=await setup();await expect(s.service.configure(s.root,s.imported.asset.id,{enabled:true,agentId:'a',expectedRevision:0,conditions} as any)).rejects.toThrow('invalid_maintenance');
 expect(s.service.status(s.root,s.imported.asset.id).revision).toBe(0);
});
test('changing conditions while a check runs prevents publication with the previous instructions',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{await s.service.configure(s.root,s.imported.asset.id,{enabled:true,agentId:'a',projectId:'p',expectedRevision:1,conditions:'只记录最终验收'});return '{"operation":"replace","text":"计划：已完成"}';});
 await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);
 expect(s.service.status(s.root,s.imported.asset.id)).toMatchObject({revision:2,conditions:'只记录最终验收',lastCheck:{state:'failed'}});
});
test('explicit enable assigns human-owned text to the chosen Agent without sharing and validates unsupported targets',async()=>{
 const s=await setup();await s.enable();const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id);
 expect(a.owner.agentId).toBe('a');expect(a.accessPolicy).toEqual({mode:'owner'});expect(s.service.status(s.root,a.id)).toMatchObject({enabled:true,agentId:'a',projectId:'p',revision:1});
 await expect(s.service.configure({...s.root,agentId:'a'},a.id,{enabled:false,expectedRevision:1})).rejects.toThrow();
 s.config.agents[0].defaultCli='claude';await expect(s.enable()).rejects.toThrow(/runtime/);
});
test('completed deep-memory request with no standalone summaries triggers exactly one update with actual Agent model, usage and no fake run',async()=>{
 const s=await setup();await s.enable();await s.summary();expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM memory_session_summaries').get()!.n).toBe(0);await s.service.reconcile();await s.service.drain();await s.service.reconcile();await s.service.drain();
 const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id),versions=s.assets.listVersions(s.root,a.id);
 expect(versions).toHaveLength(2);expect(versions[0].files[0].path).toBe('notes/roadmap.md');expect(readFileSync(s.files.blobPath(versions[0].files[0].blobHash),'utf8')).toBe('计划：已完成验证');expect(versions[0].provenance.runId).toBeUndefined();expect(versions[0].provenance.sourceVersions).toContainEqual({assetId:a.id,versionId:s.imported.version.id});
 expect(s.service.status(s.root,a.id).lastCheck?.state).toBe('updated');
 const usage=getUsage(s.store,{period:'today',timeZone:'UTC'}).recent.filter(e=>e.category==='fileMaintenance');expect(usage).toHaveLength(1);expect(usage[0]).toMatchObject({agentId:'a',projectId:'p',model:'fixture-model',status:'completed'});
 expect(usage[0].runId).toBeUndefined();
 expect(s.generate.mock.calls[0][0]).toMatchObject({cli:'codex',model:'fixture-model'});expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM work_tasks').get()!.n).toBe(0);
});
test('unmarked, historical, failed, legacy session and incomplete request extraction never trigger a model call',async()=>{
 const s=await setup();await s.summary();await s.service.reconcile();expect(s.generate).not.toHaveBeenCalled();await s.enable();await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();
 await s.summary();const job=s.memoryRuntime.jobs.list(s.root).at(-1)!;
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'failed'}),job.id);await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,kind:'session'}),job.id);await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,extraction:{nextChunk:1,totalChunks:2}}),job.id);await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();
});
test.each(['{"operation":"unchanged"}','{"operation":"replace","text":"计划：待验证"}'])('unchanged or identical bytes produce no version (%s)',async output=>{
 const s=await setup(output);await s.enable();await s.summary();await s.service.reconcile();await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.state).toBe('unchanged');
});
test('disable during generation prevents publication and later jobs do not resurrect that policy',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{await s.service.configure(s.root,s.imported.asset.id,{enabled:false,expectedRevision:1});return '{"operation":"replace","text":"计划：已完成"}';});
 await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id)).toMatchObject({enabled:false,revision:2});
});
test('a concurrent human edit fails expected-head CAS and preserves the human version',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{writeFileSync(join(s.home,'human'),'人工编辑');const stage=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'human',manifestPath:'notes/roadmap.md'}]);s.assets.publishAssetVersion(s.root,{assetId:s.imported.asset.id,expectedHeadVersionId:s.imported.version.id,...stage,provenance:{sourceVersions:[]}},'human');return '{"operation":"replace","text":"计划：已完成"}';});
 await s.service.drain();const versions=s.assets.listVersions(s.root,s.imported.asset.id);expect(versions).toHaveLength(2);expect(readFileSync(s.files.blobPath(versions[0].files[0].blobHash),'utf8')).toBe('人工编辑');expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.error).toBe('head_conflict');
});
test.each(['{"operation":"replace","text":"x","agentId":"other"}',JSON.stringify({operation:'replace',text:'x'.repeat(24001)})])('invalid output fails once without unbounded retry',async output=>{
 const s=await setup(output);await s.enable();await s.summary();await s.service.reconcile();await s.service.drain();await s.restart();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.state).toBe('failed');
});
test('Agent-wide policy checks conversations in its projects; other Agent and wrong exact project do not trigger',async()=>{
 const s=await setup();await s.service.configure(s.root,s.imported.asset.id,{enabled:true,agentId:'a',projectId:null,expectedRevision:0});await s.summary();await s.service.reconcile();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);
});
test('repeated successful jobs with identical evidence and restart never generate a second check',async()=>{
 const s=await setup('{"operation":"unchanged"}');await s.enable();await s.summary();await s.service.reconcile();await s.service.drain();
 const job=s.memoryRuntime.jobs.list(s.root).at(-1)!;
 const id='repeated-job';s.store.database.prepare('INSERT INTO memory_jobs VALUES (?,?,?)').run(id,'repeated-key',JSON.stringify({...job,id}));
 await s.restart();await s.service.reconcile();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM file_maintenance_checks').get()!.n).toBe(1);
});
test('generated output resumes after restart with no second model call',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 const original=s.store.transaction;s.store.transaction=(fn)=>original(()=>{const result=fn();const row=s.store.database.prepare("SELECT id FROM file_maintenance_checks WHERE json_extract(data,'$.state')='generated'").get();if(row)void s.service.close();return result;});
 await s.service.drain();s.store.transaction=original;expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);
 await s.restart();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(2);
});
test('abort awaits native completion; restart retries interrupted generation once using new usage identity',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async(_c,_p,signal)=>new Promise<string>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));
 const work=s.service.drain();await vi.waitFor(()=>expect(s.generate).toHaveBeenCalledTimes(1));await s.service.close();await work;expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);
 await s.restart();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(2);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(2);
 const usage=getUsage(s.store,{period:'today',timeZone:'UTC'}).recent.filter(e=>e.category==='fileMaintenance');expect(new Set(usage.map(e=>e.executionId)).size).toBe(2);expect(usage.map(e=>e.status).sort()).toEqual(['completed','interrupted']);
});
test('publication and durable check result roll back together when check commit fails',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();s.store.database.exec("CREATE TRIGGER deny_maintenance_commit BEFORE UPDATE ON file_maintenance_checks WHEN json_extract(NEW.data,'$.state')='published' BEGIN SELECT RAISE(ABORT,'fault'); END");
 await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.state).toBe('failed');expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.versionId).toBeNull();expect(s.store.database.prepare("SELECT COUNT(*) AS n FROM command_dedup WHERE command_key LIKE 'maint:%'").get()!.n).toBe(0);
});
test('revoking saved summary evidence blocks derived version reads for both human and Agent',async()=>{
 const s=await setup();await s.enable();const chat=await s.summary();await s.service.reconcile();await s.service.drain();const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id);
 s.store.database.prepare("UPDATE events SET superseded=1 WHERE conversationId=? AND kind='user'").run(chat.id);
 expect(()=>s.assets.readAssetFile(s.root,{assetId:a.id,versionId:a.headVersionId!},'0')).toThrow('maintenance_source_changed');expect(()=>s.assets.getAuthorizedVersion({...s.root,agentId:'a'},{assetId:a.id,versionId:a.headVersionId!})).toThrow('maintenance_source_changed');
 expect(s.assets.readAssetFile(s.root,{assetId:a.id,versionId:s.imported.version.id},'0').size).toBeGreaterThan(0);
});
test.each(['membership','binding','evidence','access'])('rechecks %s after awaited model work and never publishes stale authority',async reason=>{
 const s=await setup();await s.enable();const chat=await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{
  if(reason==='membership')s.config.projects[0].agentIds=[];
  if(reason==='binding')s.assets.removeBinding(s.root,'project','p',s.imported.asset.id);
  if(reason==='evidence')s.store.database.prepare("UPDATE events SET superseded=1 WHERE conversationId=? AND kind='user'").run(chat.id);
  if(reason==='access'){const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id);s.assets.setAccess(s.root,a.id,{mode:'all'},a.revision);}
  return '{"operation":"replace","text":"计划：已完成"}';
 });await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.state).toBe('failed');
});
import { createRunArtifacts } from '../server/run-artifacts';
test('bound interactive update preserves actual run provenance, declared path, stable retry and explicit policy',async()=>{
 const s=await setup();await s.enable();const principal={...s.root,agentId:'a',runId:'actual-invocation'};
 writeFileSync(join(s.home,'update'),'计划：交互更新');
 const artifacts=createRunArtifacts({store:s.store,files:s.files,assets:s.assets,principal,outputRoot:s.home,sourceVersions:[],assertActive(){},maintenanceUpdate:(args)=>s.service.updateGate(principal,'p',args)});
 const args={assetId:s.imported.asset.id,expectedHeadVersionId:s.imported.version.id,path:'update'};
 const result=await artifacts.update(args,'interactive-update');expect(result.version.provenance.runId).toBe('actual-invocation');expect(result.version.files[0].path).toBe('notes/roadmap.md');
 expect((await artifacts.update(args,'interactive-update')).version.id).toBe(result.version.id);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(2);
 await expect(artifacts.update({...args,path:'../outside'},'unsafe')).rejects.toThrow();await expect(s.service.updateGate({...principal,agentId:'other'},'p',args)).rejects.toThrow();await expect(s.service.updateGate(principal,null,args)).rejects.toThrow();
});
test('disabling preserves readable saved versions; broadening access cannot expose private summary to another Agent',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();await s.service.drain();const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id);
 await s.service.configure(s.root,a.id,{enabled:false,expectedRevision:1});expect(s.assets.getAuthorizedVersion(s.root,{assetId:a.id,versionId:a.headVersionId!}).id).toBe(a.headVersionId);
 expect(()=>s.assets.setAccess(s.root,a.id,{mode:'all'},a.revision)).toThrow('source_scope_conflict');expect(()=>s.assets.getAuthorizedVersion({...s.root,agentId:'other'},{assetId:a.id,versionId:a.headVersionId!})).toThrow('forbidden');
});
test('enable rejects private external provenance rather than assigning ownership and later silently skipping checks',async()=>{
 const s=await setup();writeFileSync(join(s.home,'private'),'私有来源');const stage=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'private',manifestPath:'private.md'}]);const source=s.assets.importAsset(s.root,{kind:'file',title:'Private',submissionId:stage.submissionId},'private');
 writeFileSync(join(s.home,'derived'),'计划：待验证');const replacement=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'derived',manifestPath:'roadmap.md'}]);s.assets.publishAssetVersion(s.root,{assetId:s.imported.asset.id,expectedHeadVersionId:s.imported.version.id,...replacement,provenance:{sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}]}},'derived');
 await expect(s.enable()).rejects.toThrow('maintenance_source_scope_unsupported');expect(s.assets.getAuthorizedAsset(s.root,s.imported.asset.id).owner.agentId).toBeUndefined();expect(s.service.status(s.root,s.imported.asset.id).enabled).toBe(false);
});
import { memoryHash } from '../server/memory-store';
function seedSummaryChunks(s:Awaited<ReturnType<typeof setup>>,texts:string[]){
 const job=s.memoryRuntime.jobs.list(s.root).at(-1)!,fact=s.memoryRuntime.memory.list(s.root,{projectId:'p',status:'active',layer:'L1'})[0];
 // Synthetic persisted facts exercise the maintenance boundary without another model call.
 texts.forEach((text,i)=>{const record={...fact,recordId:i?fact.recordId+'-budget-'+i:fact.recordId,text,contentHash:memoryHash(text)},data=JSON.stringify(record);
  s.store.database.prepare('INSERT OR REPLACE INTO memory_records VALUES (?,?,?)').run(record.recordId,record.collectionId,data);
  s.store.database.prepare('INSERT OR REPLACE INTO memory_revisions VALUES (?,?,?)').run(record.recordId,record.revision,data);
  s.store.database.prepare('INSERT OR REPLACE INTO memory_record_scope VALUES (?,?,?,?,?)').run(record.recordId,'p','a','active','L1');
 });
}
test('two queued summaries each generate from the head current at their first execution',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>'{"operation":"replace","text":"计划：第一轮"}').mockImplementationOnce(async(_c,prompt)=>{expect(prompt).toContain('计划：第一轮');return '{"operation":"replace","text":"计划：第二轮"}';});
 await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(2);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(3);expect(s.store.database.prepare("SELECT COUNT(*) AS n FROM file_maintenance_checks WHERE json_extract(data,'$.state')='published'").get()!.n).toBe(2);
});
test('a second summary queued while the first model is working uses the first published head',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{await s.summary();await s.service.reconcile();return '{"operation":"replace","text":"计划：慢调用完成"}';}).mockImplementationOnce(async(_c,prompt)=>{expect(prompt).toContain('计划：慢调用完成');return '{"operation":"replace","text":"计划：新会话完成"}';});
 await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(2);expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(3);
});
test('interrupted generation keeps its original baseline after restart and rejects a later human edit',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();s.generate.mockImplementationOnce(async(_c,_p,signal)=>new Promise<string>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));
 const work=s.service.drain();await vi.waitFor(()=>expect(s.generate).toHaveBeenCalledTimes(1));await s.service.close();await work;
 writeFileSync(join(s.home,'human'),'人工编辑');const stage=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'human',manifestPath:'roadmap.md'}]);s.assets.publishAssetVersion(s.root,{assetId:s.imported.asset.id,expectedHeadVersionId:s.imported.version.id,...stage,provenance:{sourceVersions:[]}},'after-interruption');
 await s.restart();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.error).toBe('head_conflict');
});
test('summary overflow produces a small durable failed watermark and zero model work without repeated enqueue',async()=>{
 const s=await setup();await s.enable();await s.summary();seedSummaryChunks(s,['进'.repeat(6000),'进'.repeat(6000)]);
 await s.service.reconcile();await s.service.drain();await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();expect(s.service.status(s.root,s.imported.asset.id).lastCheck).toMatchObject({state:'failed',error:'maintenance_summary_too_large'});
 const rows=s.store.database.prepare('SELECT data FROM file_maintenance_checks').all();expect(rows).toHaveLength(1);expect(Buffer.byteLength(rows[0].data as string)).toBeLessThan(2048);expect(rows[0].data).not.toContain('进进进');
});
test.each([[['中'.repeat(5999),'🙂'.repeat(2999)+'中']], [['\u0001'.repeat(5999),'\u0001'.repeat(5999)]]])('complete summary accepts exact 12000 UTF16 budget including multibyte and escaped data',async chunks=>{
 const s=await setup('{"operation":"unchanged"}');await s.enable();await s.summary();seedSummaryChunks(s,chunks);await s.service.reconcile();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.state).toBe('unchanged');
});
test('serialized prompt expansion exceeding 128KiB fails before generation and drops summary payload',async()=>{
 const s=await setup();
 // Publish valid managed bytes: the target's allowed UTF16 limit does not bound JSON escaping.
 writeFileSync(join(s.home,'escaped'),'\u0001'.repeat(24000));const stage=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'escaped',manifestPath:'roadmap.md'}]);s.assets.publishAssetVersion(s.root,{assetId:s.imported.asset.id,expectedHeadVersionId:s.imported.version.id,...stage,provenance:{sourceVersions:[]}},'escaped-target');
 await s.enable();await s.summary();seedSummaryChunks(s,['x'.repeat(5999),'x'.repeat(5999)]);await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.error).toBe('maintenance_prompt_too_large');const row=s.store.database.prepare('SELECT data FROM file_maintenance_checks').get()!;expect(Buffer.byteLength(row.data as string)).toBeLessThan(2048);
});
test('twenty sequential maintained versions keep one unique direct predecessor rather than copied ancestry',async()=>{
 const s=await setup();await s.enable();let prior=s.imported.version.id;
 for(let i=0;i<20;i++){
  // This lineage test seeds completed request progress; engine execution is covered above.
  const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),event=s.store.appendEvent(chat.id,'user',{text:'验证进展 '+i});s.store.appendEvent(chat.id,'status',{status:'idle'});
  const captured=await s.memoryRuntime.captureConversation(chat.id),source=captured.sources[0],job=captured.jobs[0];
  s.memoryRuntime.memory.applyProposal(s.root,{collectionId:source.collectionId,layer:'L1',contentType:'fact',text:'验证进展 '+i,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:'验证进展 '+i}],validUntil:null,certainty:'user_asserted',pipeline:'request'},job.generation,'evidence_extract');
  s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed',stage:'scene',completedAt:new Date().toISOString(),extraction:{nextChunk:1,totalChunks:1}}),job.id);
  await s.service.reconcile();s.generate.mockImplementationOnce(async()=>JSON.stringify({operation:'replace',text:'计划：第'+i+'次更新'}));await s.service.drain();
  const asset=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id),version=s.assets.getAuthorizedVersion(s.root,{assetId:asset.id,versionId:asset.headVersionId!});expect(version.provenance.sourceVersions).toEqual([{assetId:asset.id,versionId:prior}]);prior=version.id;
 }
 expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(21);
});
test('bound updates deduplicate direct input references without flattening old ancestors',async()=>{
 const s=await setup();await s.enable();const principal={...s.root,agentId:'a',runId:'bound-direct'};
 let prior=s.imported.version.id;
 for(let i=0;i<3;i++){writeFileSync(join(s.home,'update'),'计划：交互'+i);const ref={assetId:s.imported.asset.id,versionId:prior};const artifacts=createRunArtifacts({store:s.store,files:s.files,assets:s.assets,principal,outputRoot:s.home,sourceVersions:[ref,ref],assertActive(){},maintenanceUpdate:args=>s.service.updateGate(principal,'p',args)});const result=await artifacts.update({assetId:s.imported.asset.id,expectedHeadVersionId:prior,path:'update'},'direct-'+i);expect(result.version.provenance.sourceVersions).toEqual([ref]);prior=result.version.id;}
});
test('Files index retains healthy items when maintained summary evidence is withdrawn; direct read still denies',async()=>{
 const s=await setup();await s.enable();const chat=await s.summary();await s.service.reconcile();await s.service.drain();writeFileSync(join(s.home,'healthy'),'healthy');const stage=await s.files.stageFiles(s.root,null,[{allowedRoot:s.home,relativePath:'healthy',manifestPath:'healthy.md'}]);const healthy=s.assets.importAsset(s.root,{kind:'file',title:'Healthy',submissionId:stage.submissionId},'healthy');
 s.store.database.prepare("UPDATE events SET superseded=1 WHERE conversationId=? AND kind='user'").run(chat.id);
 const {createAssetHttp}=await import('../server/asset-http');const handler=createAssetHttp(s.home,s.store,()=>{},s.service);let status=0,body:any;const res={headersSent:false,writeHead(code:number){status=code;},end(text:string){body=JSON.parse(text);}};
 await handler({method:'GET'} as any,res as any,new URL('http://localhost/api/v2/assets'),async()=>undefined);expect(status).toBe(200);expect(body.find((a:any)=>a.id===healthy.asset.id)).toMatchObject({availability:'managed_local'});expect(body.find((a:any)=>a.id===s.imported.asset.id)).toMatchObject({availability:'access_denied'});const a=s.assets.getAuthorizedAsset(s.root,s.imported.asset.id);expect(()=>s.assets.readAssetFile(s.root,{assetId:a.id,versionId:a.headVersionId!},'0')).toThrow('maintenance_source_changed');
});
test('serialized saved-summary metadata exceeding 128KiB persists only a small failed watermark',async()=>{
 const s=await setup();await s.enable();await s.summary();const job=s.memoryRuntime.jobs.list(s.root).at(-1)!,largeId='j'.repeat(128*1024);
 s.store.database.prepare('UPDATE memory_jobs SET id=?,data=? WHERE id=?').run(largeId,JSON.stringify({...job,id:largeId}),job.id);
 await s.service.reconcile();await s.service.drain();await s.service.reconcile();expect(s.generate).not.toHaveBeenCalled();expect(s.service.status(s.root,s.imported.asset.id).lastCheck?.error).toBe('maintenance_snapshot_too_large');const rows=s.store.database.prepare('SELECT data FROM file_maintenance_checks').all();expect(rows).toHaveLength(1);expect(Buffer.byteLength(rows[0].data as string)).toBeLessThan(2048);
});

test('a corrected deep-memory fact during generation prevents publication',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 s.generate.mockImplementationOnce(async()=>{const fact=s.memoryRuntime.memory.list(s.root,{projectId:'p',layer:'L1',status:'active'})[0];s.memoryRuntime.memory.correct(s.root,{recordId:fact.recordId,expectedRevision:fact.revision,text:'此前验证未完成'});return '{"operation":"replace","text":"计划：已完成"}';});
 await s.service.drain();expect(s.assets.listVersions(s.root,s.imported.asset.id)).toHaveLength(1);expect(s.service.status(s.root,s.imported.asset.id).lastCheck).toMatchObject({state:'failed',error:'maintenance_source_changed'});
});
test('legacy queued summary-based file checks remain untouched and never call the model',async()=>{
 const s=await setup();await s.enable();await s.summary();await s.service.reconcile();
 const row=s.store.database.prepare('SELECT id,data FROM file_maintenance_checks').get()!,value=JSON.parse(row.data as string);delete value.summary.kind;delete value.summary.recordRefs;
 const bytes=JSON.stringify(value);s.store.database.prepare('UPDATE file_maintenance_checks SET data=? WHERE id=?').run(bytes,row.id);
 await s.restart();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();expect(s.store.database.prepare('SELECT data FROM file_maintenance_checks WHERE id=?').get(row.id)?.data).toBe(bytes);
});
test('compatible evidence append does not replay a previously checked progress watermark',async()=>{
 const s=await setup('{"operation":"unchanged"}');await s.enable();await s.summary();await s.service.reconcile();await s.service.drain();
 const job=s.memoryRuntime.jobs.list(s.root).at(-1)!,fact=s.memoryRuntime.memory.list(s.root,{projectId:'p',layer:'L1',status:'active'})[0];
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),event=s.store.appendEvent(chat.id,'user',{text:fact.text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const c=s.memoryRuntime.memory.captureConversation(s.root,{collectionId:fact.collectionId,conversationId:chat.id,trigger:'completed',kind:'request'}),source=c.sources[0];
 s.memoryRuntime.memory.applyProposal(s.root,{collectionId:fact.collectionId,layer:'L1',contentType:'fact',text:fact.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:fact.text}],validUntil:null,certainty:'user_asserted',pipeline:'request'},job.generation,'evidence_extract');
 await s.service.reconcile();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM file_maintenance_checks').get()!.n).toBe(1);
});

test('upgrade does not replay completed request history for an already-enabled file policy',async()=>{
 const s=await setup();await s.enable();await s.summary();
 // Simulate the pre-adapter database, which has the scan cursor but no request cutover.
 s.store.database.prepare('DELETE FROM file_maintenance_scan WHERE id=2').run();await s.restart();
 await s.service.reconcile();await s.service.drain();expect(s.generate).not.toHaveBeenCalled();
 await s.summary();await s.service.reconcile();await s.service.drain();expect(s.generate).toHaveBeenCalledTimes(1);
});

test('file maintenance without an optional memory runtime does not require memory tables',async()=>{
 const home=mkdtempSync(join(tmpdir(),'maintenance-no-memory-')),store=openStore(home),config=(await readConfig(home)).config;
 let service:ReturnType<typeof createFileMaintenance>|undefined;
 try{service=createFileMaintenance({home,store,loadConfig:async()=>config});await service.reconcile();await service.drain();expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_jobs'").get()).toBeUndefined();}
 finally{await service?.close();store.close();rmSync(home,{recursive:true,force:true});}
});
