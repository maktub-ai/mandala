import {ensureConfiguredMandala} from './configured-mandala';
import { legacyWiki } from './legacy-wiki-fixture';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openStore} from '../server/store';
import {readConfig,writeConfig} from '../server/config';
import {createSkillService} from '../server/skill-service';
import {createSkillManagement} from '../server/skill-http';
import {createSkillLearning} from '../server/skill-learning';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createKnowledgeBase} from '../server/knowledge-base';
import {registerSkillConversationRead} from '../server/skill-evidence';
import {workspacePrincipal} from '../server/workspace-identity';
import {createMemoryRuntime,memoryHistoryReferences} from '../server/memory-runtime';
import {createSessionManager} from '../server/sessions';
let home:string,store:ReturnType<typeof openStore>,runtime:ReturnType<typeof createSkillLearning>|undefined,manager:ReturnType<typeof createSessionManager>|undefined,memory:ReturnType<typeof createMemoryRuntime>|undefined;
const content='---\nname: review\ndescription: Review changes\n---\nPRIVATE_SKILL_EVIDENCE';
const loadConfig=async()=>(await readConfig(home)).config;
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'skill-evidence-'));store=openStore(home);const s=await readConfig(home);await writeConfig(home,{...s.config,agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]})),projects:[{id:'p',name:'p',cwd:home,resources:[],agentIds:['a','b'],mcp:[],skills:[]}]},s.revision);});
afterEach(async()=>{await runtime?.close();await manager?.close();await memory?.close();runtime=undefined;manager=undefined;memory=undefined;store.close();await rm(home,{recursive:true,force:true});});
function evidence(){const c=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),event=store.appendEvent(c.id,'user',{text:'PRIVATE_SKILL_EVIDENCE'});return {c,source:{agentId:'a',projectId:'p',method:'dialogue' as const,verification:'draft' as const,conversationId:c.id,eventIds:[event.id],eventFingerprints:{[event.id]:createHash('sha256').update(JSON.stringify(event)).digest('hex')}}};}
async function register(source?:ReturnType<typeof evidence>['source']){return await createSkillService(home,store)('a','skill_register',{name:'review',content},'seed',()=>{},source,{projectId:'p'}) as any;}
async function share(id:string){const s=await readConfig(home);s.config.agents[1].skillIds=[id];await writeConfig(home,s.config,s.revision);}
test('same Project assignment never grants another Agent the source conversation',async()=>{const {source}=evidence(),{skill}=await register(source);await share(skill.id);await expect(createSkillService(home,store)('b','skill_read',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});});
test('generic Skill body/history and Wiki ingestion reject replaced dialogue evidence on every Store',async()=>{
 const {c,source}=evidence(),{skill}=await register(source),root=workspacePrincipal(store),assets=createAssets(store,createAssetFiles(home));assets.setAccess(root,skill.versionRef.assetId,{mode:'all'},assets.getAuthorizedAsset(root,skill.versionRef.assetId).revision);store.replaceHistory(c.id,source.eventIds[0],'replaced');
 expect(()=>assets.readAssetFile(root,skill.versionRef,'0')).toThrow();expect(()=>assets.listVersions({...root,agentId:'b'},skill.versionRef.assetId)).toThrow();
 const second=openStore(home);try{expect(()=>createAssets(second,createAssetFiles(home)).readAssetFile(root,skill.versionRef,'0')).toThrow();}finally{second.close();}
 const wiki=createKnowledgeBase({home,store,loadConfig});try{const base=await legacyWiki(home,store,wiki,{name:'Skills',purpose:'Skills',maintainerAgentId:'a',automatic:false,reception:{enabled:false}});await expect(wiki.addSource(root,base.id,{...skill.versionRef,replace:false})).rejects.toMatchObject({status:403});}finally{await wiki.close();}
});
test('unavailable Skill references survive unrelated config edits while body edits still fail closed',async()=>{
 const {c,source}=evidence(),{skill}=await register(source);await createSkillService(home,store)('a','skill_register',{name:'safe',content:content.replace('name: review','name: safe')},'safe',()=>{});store.replaceHistory(c.id,source.eventIds[0],'replaced');const s=await readConfig(home);expect(s.config.skillLibrary!.find(x=>x.id===skill.id)!.content).toBeUndefined();s.config.agents[1].name='Renamed';await writeConfig(home,s.config,s.revision);const saved=await readConfig(home);expect(saved.config.agents[1].name).toBe('Renamed');expect(saved.config.skillLibrary!.find(x=>x.id===skill.id)!.versionRef).toEqual(skill.versionRef);saved.config.skillLibrary!.find(x=>x.id===skill.id)!.content=content+' edit';await expect(writeConfig(home,saved.config,saved.revision)).rejects.toMatchObject({status:403});
});
test('safe shared Skills hide private proposals and revoked proposals cannot be listed or accepted',async()=>{
 const {skill}=await register();await share(skill.id);const {c,source}=evidence(),service=createSkillService(home,store),proposal:any=await service('a','skill_update',{skillId:skill.id,content:content+' private proposal',expectedVersionId:skill.versionRef.versionId},'proposal',()=>{},source,{projectId:'p'});
 expect(await service('b','skill_suggestions',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).toEqual({items:[]});store.replaceHistory(c.id,source.eventIds[0],'replaced');expect(await service('a','skill_suggestions',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).toEqual({items:[]});expect((await createSkillManagement(home,store).detail(skill.id)).suggestions).toEqual([]);await expect(service('a','skill_accept',{skillId:skill.id,suggestionId:proposal.suggestion.id},'accept',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
});
test.each([false,true])('protected Memory history is checked before capture with host authority=%s',async host=>{
 const root=workspacePrincipal(store);memory=createMemoryRuntime({home,store,loadConfig,schedule:false,verifyOutput:false,generate:async()=> '[]',embed:async texts=>texts.map(()=>[1,0])});await memory.initialize();await memory.getSettings();
 const other=store.createConversation({projectId:'',agentId:'b',cli:'codex',model:null}),event=store.appendEvent(other.id,'user',{text:'Private remembered fact'});store.appendEvent(other.id,'status',{status:'idle'});const collection=memory.memory.ensureCollection(root,{projectId:null,agentId:'b'}),captured=memory.memory.captureConversation(root,{collectionId:collection.id,conversationId:other.id,trigger:'explicit',kind:'request'}).sources[0],record=memory.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:'Private remembered fact',operation:'store',replaces:[],evidence:[{sourceId:captured.id,sourceRevision:captured.revision}],support:[{sourceId:captured.id,eventId:event.id,quote:'Private remembered fact'}],validUntil:null,certainty:'user_asserted'},collection.generation,'evidence_extract')!;
 let calls=0;if(host)manager=createSessionManager(store,loadConfig,undefined,undefined,home,undefined,undefined,memory,{generate:async()=>{calls++;return JSON.stringify({action:'new',name:'review',content});}});
 const {c}=evidence();store.appendEvent(c.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:record.recordId,revision:record.revision}]});store.appendEvent(c.id,'status',{status:'idle'});expect(()=>memory!.memory.history({...root,agentId:'a'},{projectId:'p',items:memoryHistoryReferences(store,c.id)})).toThrow();runtime=createSkillLearning({home,store,loadConfig,generate:async()=>{calls++;return JSON.stringify({action:'new',name:'review',content});}});await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(0);expect((await loadConfig()).skillLibrary??[]).toHaveLength(0);expect(store.database.prepare("SELECT COUNT(*) AS n FROM skill_learning_batches WHERE json_extract(data,'$.conversationId')=?").get(c.id)!.n).toBe(0);
});

test('revoked inherited Task history blocks generic Skill and Wiki reads',async()=>{
 const {writeFile}=await import('node:fs/promises'),{createTasks}=await import('../server/tasks');const root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files);
 await writeFile(join(home,'task.txt'),'Task private evidence');const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'task.txt',manifestPath:'task.txt'}]),input=assets.importAsset(root,{kind:'file',title:'Task',agentId:'a',submissionId:stage.submissionId},'task-file');
 const tasks=createTasks(store,{assets,resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'Read evidence',sourceVersions:[{assetId:input.asset.id,versionId:input.version.id}],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})}),task=tasks.createTask(root,{goal:'Read',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'task'),run=tasks.startTask(root,task.id,task.revision,'run');
 manager=createSessionManager(store,loadConfig,undefined,undefined,home);const {c,source}=evidence();store.inheritConversationTaskRuns(c.id,[run.id]);const {skill}=await register(source);expect(assets.readAssetFile(root,skill.versionRef,'0').size).toBeGreaterThan(0);
 assets.setAccess(root,input.asset.id,{mode:'private'},assets.getAuthorizedAsset(root,input.asset.id).revision);expect(()=>assets.readAssetFile(root,skill.versionRef,'0')).toThrow();await expect(createSkillService(home,store)('a','skill_read',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});expect((await readConfig(home)).config.skillLibrary![0].unavailable).toBe(true);
 const wiki=manager.knowledgeBase,base=await legacyWiki(home,store,wiki,{name:'Derived',purpose:'Evidence',maintainerAgentId:'a',automatic:false,reception:{enabled:false}});await expect(wiki.addSource(root,base.id,{...skill.versionRef,replace:false})).rejects.toMatchObject({status:403});
});

test('proposal replay checks its saved source even when the retry supplies no evidence',async()=>{
 const {skill}=await register();await share(skill.id);const {c,source}=evidence(),service=createSkillService(home,store),args={skillId:skill.id,content:content+' proposal',expectedVersionId:skill.versionRef.versionId};await service('a','skill_update',args,'proposal-replay',()=>{},source,{projectId:'p'});store.replaceHistory(c.id,source.eventIds[0],'replaced');await expect(service('a','skill_update',args,'proposal-replay',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
});
test('version history checks each immutable source for the actual reader rather than the current safe head',async()=>{
 const {source}=evidence(),{skill}=await register(source);const snapshot=await readConfig(home);snapshot.config.skillLibrary![0].content=content+' safe revision';snapshot.config.skillLibrary![0].source={method:'agent',verification:'draft'};await writeConfig(home,snapshot.config,snapshot.revision);await share(skill.id);const service=createSkillService(home,store);expect(await service('b','skill_read',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content:content+' safe revision'});await expect(service('b','skill_versions',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
});

async function ownMemory(){
 const root=workspacePrincipal(store);memory=createMemoryRuntime({home,store,loadConfig,schedule:false,verifyOutput:false,generate:async()=> '[]',embed:async texts=>texts.map(()=>[1,0])});await memory.initialize();await memory.getSettings();const c=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),event=store.appendEvent(c.id,'user',{text:'Remember private evidence'});store.appendEvent(c.id,'status',{status:'idle'});const collection=memory.memory.ensureCollection(root,{projectId:null,agentId:'a'}),source=memory.memory.captureConversation(root,{collectionId:collection.id,conversationId:c.id,trigger:'explicit',kind:'request'}).sources[0],record=memory.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:'Remember private evidence',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:'Remember private evidence'}],validUntil:null,certainty:'user_asserted'},collection.generation,'evidence_extract')!;
 manager=createSessionManager(store,loadConfig,undefined,undefined,home,undefined,undefined,memory);const assets=createAssets(store,createAssetFiles(home));return {ack:(id:string)=>store.appendEvent(id,'metadata',{memoryUse:'acknowledged',items:[{recordId:record.recordId,revision:record.revision}]}),revoke:()=>assets.setAccess(root,collection.id,{mode:'private'},assets.getAuthorizedAsset(root,collection.id).revision)};
}
test('revoking real inherited Memory blocks owner/generic Skill, dependent Wiki and private suggestion reads',async()=>{
 const protectedHistory=await ownMemory(),{c,source}=evidence();protectedHistory.ack(c.id);const {skill}=await register(source),root=workspacePrincipal(store),assets=createAssets(store,createAssetFiles(home));expect(assets.readAssetFile(root,skill.versionRef,'0').size).toBeGreaterThan(0);
 const safe:any=await createSkillService(home,store)('a','skill_register',{name:'safe',content:content.replace('name: review','name: safe')},'safe',()=>{});await share(safe.skill.id);const service=createSkillService(home,store),proposal:any=await service('a','skill_update',{skillId:safe.skill.id,content:content.replace('name: review','name: safe')+' proposal',expectedVersionId:safe.skill.versionRef.versionId},'memory-proposal',()=>{},source,{projectId:'p'});
 expect(await service('b','skill_suggestions',{skillId:safe.skill.id},'',()=>{},undefined,{projectId:'p'})).toEqual({items:[]});protectedHistory.revoke();expect(()=>assets.readAssetFile(root,skill.versionRef,'0')).toThrow();expect((await readConfig(home)).config.skillLibrary!.find(x=>x.id===skill.id)!.unavailable).toBe(true);expect(await service('a','skill_suggestions',{skillId:safe.skill.id},'',()=>{},undefined,{projectId:'p'})).toEqual({items:[]});await expect(createSkillManagement(home,store).decide(safe.skill.id,proposal.suggestion.id,'accept',safe.skill.versionRef.versionId)).rejects.toMatchObject({status:403});
 const base=await legacyWiki(home,store,manager!.knowledgeBase,{name:'Memory',purpose:'Evidence',maintainerAgentId:'a',automatic:false,reception:{enabled:false}});await expect(manager!.knowledgeBase.addSource(root,base.id,{...skill.versionRef,replace:false})).rejects.toMatchObject({status:403});
});
test('Memory revoked after generation cannot publish saved output',async()=>{
 const protectedHistory=await ownMemory(),{c}=evidence();protectedHistory.ack(c.id);store.appendEvent(c.id,'status',{status:'idle'});let calls=0;runtime=createSkillLearning({home,store,loadConfig,generate:async()=>{calls++;return JSON.stringify({action:'new',name:'review',content});},beforePublish:protectedHistory.revoke});await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(1);expect((await loadConfig()).skillLibrary??[]).toHaveLength(0);
});
test('proposal supporting versions are authorized for the actual reader and rechecked inside acceptance commit',async()=>{
 const {writeFile}=await import('node:fs/promises'),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files);await writeFile(join(home,'support.txt'),'Sensitive support');const staged=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'support.txt',manifestPath:'support.txt'}]),support=assets.importAsset(root,{kind:'file',title:'Support',agentId:'a',submissionId:staged.submissionId},'support');const {skill}=await register();await share(skill.id);const service=createSkillService(home,store),proposal:any=await service('a','skill_update',{skillId:skill.id,content:content+' supported proposal',expectedVersionId:skill.versionRef.versionId},'supported',()=>{},{method:'agent',verification:'draft',agentId:'a',sourceVersions:[{assetId:support.asset.id,versionId:support.version.id}]},{projectId:'p'});
 expect(await service('b','skill_suggestions',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).toEqual({items:[]});let checks=0;await expect(service('a','skill_accept',{skillId:skill.id,suggestionId:proposal.suggestion.id},'accept',()=>{if(++checks===4)assets.setAccess(root,support.asset.id,{mode:'private'},assets.getAuthorizedAsset(root,support.asset.id).revision);},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});expect((await readConfig(home)).config.skillLibrary![0].versionRef).toEqual(skill.versionRef);
});

test('human acceptance cannot publish B private dialogue under A canonical Skill authority',async()=>{
 const {skill}=await register();await share(skill.id);const c=store.createConversation({projectId:'p',agentId:'b',cli:'codex',model:null}),event=store.appendEvent(c.id,'user',{text:'B PRIVATE_PROPOSAL'}),source={agentId:'b',projectId:'p',method:'dialogue' as const,verification:'draft' as const,conversationId:c.id,eventIds:[event.id],eventFingerprints:{[event.id]:createHash('sha256').update(JSON.stringify(event)).digest('hex')}};
 const proposal:any=await createSkillService(home,store)('b','skill_update',{skillId:skill.id,content:content+' B PRIVATE_PROPOSAL',expectedVersionId:skill.versionRef.versionId},'b-proposal',()=>{},source,{projectId:'p'});expect((await createSkillManagement(home,store).detail(skill.id)).suggestions).toHaveLength(1);
 await expect(createSkillManagement(home,store).decide(skill.id,proposal.suggestion.id,'accept',skill.versionRef.versionId)).rejects.toMatchObject({status:403});expect((await readConfig(home)).config.skillLibrary![0].versionRef).toEqual(skill.versionRef);
});

test('human acceptance preserves explicitly shared supporting Asset permissions for both proposer and maintainer',async()=>{
 const {writeFile}=await import('node:fs/promises'),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files);await writeFile(join(home,'shared.txt'),'Shared support');const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'shared.txt',manifestPath:'shared.txt'}]),input=assets.importAsset(root,{kind:'file',title:'Shared support',agentId:'b',submissionId:stage.submissionId},'shared');assets.setAccess(root,input.asset.id,{mode:'all'},input.asset.revision);
 const {skill}=await register();await share(skill.id);const suggestion:any=await createSkillService(home,store)('b','skill_update',{skillId:skill.id,content:content+' shared supported change',expectedVersionId:skill.versionRef.versionId},'shared-proposal',()=>{},{method:'agent',verification:'draft',agentId:'b',sourceVersions:[{assetId:input.asset.id,versionId:input.version.id}]},{projectId:'p'});
 const accepted=await createSkillManagement(home,store).decide(skill.id,suggestion.suggestion.id,'accept',skill.versionRef.versionId);expect(accepted.skill.content).toContain('shared supported change');expect(await createSkillService(home,store)('a','skill_read',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content:accepted.skill.content});
});

test.each([false,true])('project-only supporting sources require the canonical maintainer membership=%s',async member=>{
 const {writeFile}=await import('node:fs/promises'),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files),config=await readConfig(home);config.config.projects[0].agentIds=member?['a','b']:['b'];await writeConfig(home,config.config,config.revision);await writeFile(join(home,'project.txt'),'PROJECT_ONLY_SUPPORT');const staged=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'project.txt',manifestPath:'project.txt'}]),input=assets.importAsset(root,{kind:'file',title:'Project-only support',agentId:'b',submissionId:staged.submissionId},'project-only');assets.setAccess(root,input.asset.id,{mode:'selected',projectIds:['p']},input.asset.revision);
 const {skill}=await register();await share(skill.id);const proposal:any=await createSkillService(home,store)('b','skill_update',{skillId:skill.id,content:content+' PROJECT_ONLY_SUPPORT',expectedVersionId:skill.versionRef.versionId},'project-proposal',()=>{},{method:'agent',verification:'draft',agentId:'b',projectId:'p',sourceVersions:[{assetId:input.asset.id,versionId:input.version.id}]},{projectId:'p'});
 if(!member){await expect(createSkillManagement(home,store).decide(skill.id,proposal.suggestion.id,'accept',skill.versionRef.versionId)).rejects.toMatchObject({status:403});return;}
 const accepted=await createSkillManagement(home,store).decide(skill.id,proposal.suggestion.id,'accept',skill.versionRef.versionId);expect(accepted.skill.content).toContain('PROJECT_ONLY_SUPPORT');const next=await readConfig(home);next.config.projects[0].agentIds=['b'];await writeConfig(home,next.config,next.revision);expect(()=>assets.readAssetFile(root,accepted.skill.versionRef!,'0')).toThrow();await expect(createSkillService(home,store)('a','skill_read',{skillId:skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
});

test('a separate assigned reader loses project-only supporting source access when removed from the project',async()=>{
 const {writeFile}=await import('node:fs/promises'),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files),config=await readConfig(home);config.config.agents.push({id:'reader',name:'Reader',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]});config.config.projects[0].agentIds.push('reader');await writeConfig(home,config.config,config.revision);await writeFile(join(home,'reader-support.txt'),'Scoped supporting evidence');const staged=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'reader-support.txt',manifestPath:'reader-support.txt'}]),input=assets.importAsset(root,{kind:'file',title:'Scoped support',agentId:'a',submissionId:staged.submissionId},'reader-support');assets.setAccess(root,input.asset.id,{mode:'selected',projectIds:['p']},input.asset.revision);
 const service=createSkillService(home,store),registered:any=await service('a','skill_register',{name:'review',content},'reader-skill',()=>{},{method:'agent',verification:'draft',agentId:'a',projectId:'p',sourceVersions:[{assetId:input.asset.id,versionId:input.version.id}]},{projectId:'p'});const assignment=await readConfig(home);assignment.config.agents.find(a=>a.id==='reader')!.skillIds=[registered.skill.id];await writeConfig(home,assignment.config,assignment.revision);expect(await service('reader','skill_read',{skillId:registered.skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content});
 const removed=await readConfig(home);removed.config.projects[0].agentIds=['a','b'];await writeConfig(home,removed.config,removed.revision);expect(assets.readAssetFile(root,registered.skill.versionRef,'0').size).toBeGreaterThan(0);await expect(service('reader','skill_read',{skillId:registered.skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
});

test('receipt-only historical evidence fails closed without the live host authority',async()=>{
 const {c,source}=evidence();store.appendEvent(c.id,'metadata',{receiptContext:true,receiptIds:['receipt-only'],sourceVersions:[]});
 await expect(register(source)).rejects.toMatchObject({code:'skill_evidence_unavailable'});
});

test('configured system Project sharing permits Project-only support and retains private dialogue/source ACLs',async()=>{
 const {ensureMandalaConfig}=await import('../server/config'),system=(await ensureConfiguredMandala(home)).config.mandala!.agentId;
 const {writeFile}=await import('node:fs/promises'),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files);
 await writeFile(join(home,'support.txt'),'Shared Project support');const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'support.txt',manifestPath:'support.txt'}]);
 const file=assets.importAsset(root,{kind:'file',title:'Support',agentId:'a',submissionId:stage.submissionId},'project-support');assets.setAccess(root,file.asset.id,{mode:'selected',projectIds:['p']},file.asset.revision);
 const service=createSkillService(home,store),created:any=await service('a','skill_register',{name:'review',content},'project-skill',()=>{},{method:'agent',verification:'draft',agentId:'a',projectId:'p',sourceVersions:[{assetId:file.asset.id,versionId:file.version.id}]},{projectId:'p'});
 const cfg=await readConfig(home);cfg.config.projects[0].skillIds=[created.skill.id];await writeConfig(home,cfg.config,cfg.revision);
 expect(await service(system,'skill_read',{skillId:created.skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content});
 await expect(service(system,'skill_read',{skillId:created.skill.id},'',()=>{})).rejects.toMatchObject({status:403});
 assets.setAccess(root,file.asset.id,{mode:'owner'},assets.getAuthorizedAsset(root,file.asset.id).revision);
 await expect(service(system,'skill_read',{skillId:created.skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
 const privateEvidence=evidence();await expect(service(system,'skill_register',{name:'private-dialogue',content:content.replace('name: review','name: private-dialogue')},'private-dialogue',()=>{},privateEvidence.source,{projectId:'p'})).rejects.toMatchObject({status:403});
});

test('settings-only config reads skip Skill hydration while normal reads retain fresh evidence checks',async()=>{
 const {c,source}=evidence();await register(source);
 const authorize=vi.fn(),release=registerSkillConversationRead(store,authorize);
 try{
  const settings=await readConfig(home,{hydrateSkills:false});
  expect(settings.config.agents.map(a=>a.id)).toEqual(['a','b']);
  expect(settings.config.skillLibrary![0].content).toBeUndefined();
  expect(authorize).not.toHaveBeenCalled();
  expect((await readConfig(home)).config.skillLibrary![0].content).toBe(content);
  expect(authorize).toHaveBeenCalled();
  store.replaceHistory(c.id,source.eventIds[0],'replaced');
  expect((await readConfig(home)).config.skillLibrary![0].unavailable).toBe(true);
 }finally{release();}
});
