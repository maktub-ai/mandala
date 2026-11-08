import {readConfiguredRuntime} from './configured-runtime';
import {afterEach,expect,test} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {backupWorkspace,restoreWorkspace} from '../server/workspace-backup';
import {openStore} from '../server/store';
import {writeConfig} from '../server/config';
import {memoryServices} from '../server/memory-runtime';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTaskResources} from '../server/task-resources';
import {saveAttachment,loadAttachments,readAttachmentBytes} from '../server/attachments';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import type {CodexClient,CodexOptions} from '../server/codex';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(){const root=mkdtempSync(join(tmpdir(),'mana-backup-'));roots.push(root);return {root,home:join(root,'original'),snapshot:join(root,'snapshot'),restored:join(root,'restored')};}
test('offline snapshot restores real chat, configuration, memory authority and associated files after original is removed',async()=>{
 const f=fixture(),store=openStore(f.home),root={userId:'local'},initial=await readConfiguredRuntime(f.home);
 const workspace=join(f.home,'workspaces','p');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'note.txt'),'workspace bytes');
 writeFileSync(join(workspace,'script.sh'),'#!/bin/sh\nexit 0\n');chmodSync(join(workspace,'script.sh'),0o755);
 await writeConfig(f.home,{runtimes:['codex','omp'],version:2,projects:[{id:'p',name:'P',cwd:workspace,agentIds:['a'],mcp:[],skills:[],resources:[{id:'external',label:'external',kind:'local',location:'/external/repo'}]}],agents:[{id:'a',name:'A',defaultCli:'codex',models:{codex:'fixture-model'},instructions:'restore context',mcp:[],skills:[]}],system:{cli:'codex',memory:{request:{generate:false,read:true}}}},initial.revision);
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:'fixture-model',cwd:workspace});store.updateConversation(chat.id,{nativeId:'native-original',status:'idle'});
 createTaskResources(store).claim({kind:'invocation',id:'existing',conversationId:chat.id},[workspace],'write');
 const attachment=await saveAttachment(f.home,chat.id,'attachment.txt',Buffer.from('attachment bytes'));
 const event=store.appendEvent(chat.id,'user',{text:'project uses synthetic-bun',attachments:[attachment]});store.appendEvent(chat.id,'status',{status:'idle'});
 const {memory,recall,tasks}=memoryServices(f.home,store),collection=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const source=memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const record=memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:'project uses synthetic-bun',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:'project uses synthetic-bun'}],validUntil:null,certainty:'user_asserted',pipeline:'request'},collection.generation,'evidence_extract')!;
 const corrected=memory.correct(root,{recordId:record.recordId,expectedRevision:record.revision,text:'project uses synthetic-pnpm'});
 const task=tasks.createTask(root,{goal:'restore task',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'task');
 const files=createAssetFiles(f.home),assets=createAssets(store,files),asset=assets.createAsset(root,{kind:'document',title:'restored artifact',owner:root});
 const publisher={...root,runId:'fixture'};
 const staged=await files.stageFiles(publisher,'fixture',[{allowedRoot:workspace,relativePath:'note.txt',manifestPath:'note.txt'}]);
 const version=assets.publishAssetVersion(publisher,{assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'fixture',sourceVersions:[]}},'publish');
 mkdirSync(join(f.home,'runtime','cli'),{recursive:true});writeFileSync(join(f.home,'runtime','cli','token'),'synthetic-token');
 mkdirSync(join(f.home,'outputs','fixture'),{recursive:true});writeFileSync(join(f.home,'outputs','fixture','result.txt'),'output bytes');
 const history=store.listEvents(chat.id,0),search=recall.search(root,{projectId:'p',query:'synthetic-pnpm'}),memoryRows=store.database.prepare('SELECT * FROM memory_revisions ORDER BY revision').all();store.close();
 await backupWorkspace(f.home,f.snapshot);rmSync(f.home,{recursive:true});await restoreWorkspace(f.snapshot,f.restored);
 expect(existsSync(join(f.restored,'runtime'))).toBe(false);expect(existsSync(join(f.restored,'staging'))).toBe(false);
 expect(statSync(f.snapshot).mode&0o777).toBe(0o700);expect(statSync(join(f.snapshot,'config.json')).mode&0o777).toBe(0o600);
 const config=(await readConfiguredRuntime(f.restored)).config;expect(config.projects[0].cwd).toBe(join(f.restored,'workspaces','p'));expect(config.projects[0].resources[0].location).toBe('/external/repo');expect(config.agents[0].models.codex).toBe('fixture-model');expect(config.system?.memory?.request).toEqual({generate:false,read:true});
 const restored=openStore(f.restored);try{
  expect(restored.getConversation(chat.id)).toMatchObject({nativeId:'native-original',cwd:join(f.restored,'workspaces','p'),status:'idle'});expect(restored.listEvents(chat.id,0)).toEqual(history);
  const services=memoryServices(f.restored,restored);expect(services.memory.read(root,record.recordId).revision).toBe(corrected.revision);expect(services.recall.search(root,{projectId:'p',query:'synthetic-pnpm'})).toEqual(search);expect(services.recall.search(root,{projectId:'p',query:'bun'}).items).toEqual([]);
  expect(restored.database.prepare('SELECT * FROM memory_revisions ORDER BY revision').all()).toEqual(memoryRows);expect(services.tasks.getTask(root,task.id)).toEqual(task);
  const restoredFiles=createAssetFiles(f.restored),restoredAssets=createAssets(restored,restoredFiles);expect(restoredAssets.getAuthorizedVersion(root,{assetId:asset.id,versionId:version.id})).toEqual(version);expect(readFileSync(restoredFiles.blobPath(version.files[0].blobHash),'utf8')).toBe('workspace bytes');
  expect(await readAttachmentBytes(f.restored,(await loadAttachments(f.restored,chat.id,[attachment.id]))[0])).toEqual(Buffer.from('attachment bytes'));
  expect(readFileSync(join(f.restored,'outputs','fixture','result.txt'),'utf8')).toBe('output bytes');
  expect(statSync(join(f.restored,'workspaces','p','script.sh')).mode&0o777).toBe(0o700);
  expect(createTaskResources(restored).claim({kind:'run',id:'new'},[join(f.restored,'workspaces','p')],'write')).toBe('queued');
 }finally{restored.close();}
});
test.each([
 {name:'external parent traversal',suffix:'/workspaces/../../external',managed:false},
 {name:'managed parent alias outside its prefix',suffix:'/other/../workspaces/p',managed:true},
 {name:'managed parent alias within its prefix',suffix:'/workspaces/other/../p',managed:true},
])('restore classifies $name by normalized ownership and preserves external spelling',async({suffix,managed})=>{
 const f=fixture();f.restored=join(f.root,'target','restored');const store=openStore(f.home),initial=await readConfiguredRuntime(f.home),path=f.home+suffix;
 for(const path of ['workspaces/other','other','workspaces/p'])mkdirSync(join(f.home,path),{recursive:true});mkdirSync(join(f.root,'external'));
 await writeConfig(f.home,{runtimes:['codex','omp'],version:2,projects:[{id:'p',name:'P',cwd:path,agentIds:[],mcp:[],skills:[{name:'fixture',path}],resources:[{id:'r',label:'R',kind:'local',location:path}]}],agents:[]},initial.revision);
 const chat=store.createConversation({projectId:'p',agentId:'',cli:'codex',model:null,cwd:path});store.appendEvent(chat.id,'user',{text:path});store.close();
 await backupWorkspace(f.home,f.snapshot);rmSync(f.home,{recursive:true});await restoreWorkspace(f.snapshot,f.restored);
 const expected=managed?join(f.restored,'workspaces','p'):path,config=(await readConfiguredRuntime(f.restored)).config,project=config.projects[0];
 expect(project.cwd).toBe(expected);expect(project.resources[0].location).toBe(expected);expect(config.skillLibrary![0].path).toBe(expected);
 const restored=openStore(f.restored);try{expect(restored.getConversation(chat.id)?.cwd).toBe(expected);expect(restored.listEvents(chat.id,0)[0].data).toEqual({text:path});}finally{restored.close();}
});
test('restored HTTP downloads real sent attachments in the original and forked chat after the old home is deleted',async()=>{
 const f=fixture();let callbacks:CodexOptions;
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{callbacks=options;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'native-original',resumeThread:async()=>{},startTurn:async()=> 'turn',forkThread:async()=> 'native-branch',interrupt:async()=>{},replyApproval(){},close(){}};};
 const serve=async(home:string)=>{
  await readConfiguredRuntime(home);const store=openStore(home),manager=createSessionManager(store,async()=>(await readConfiguredRuntime(home)).config,factory,undefined,home),server=createHttpServer({requireIdentity:false,home,store,manager});
  server.listen(0,'127.0.0.1');await once(server,'listening');let closed=false;
  return {store,manager,url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,async close(){if(closed)return;closed=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await manager.close();store.close();}};
 };
 const original=await serve(f.home);let restored:Awaited<ReturnType<typeof serve>>|undefined;
 try{
  const chat=await original.manager.create('','',undefined,'codex'),bytes='ATTACHMENT_RESTORE_OK';
  const uploaded=await fetch(original.url+`/api/conversations/${chat.id}/attachments?name=sample.txt`,{method:'POST',headers:{Origin:original.url,'Content-Type':'application/octet-stream'},body:bytes});expect(uploaded.status).toBe(201);const attachment=await uploaded.json();
  const sent=await fetch(original.url+`/api/conversations/${chat.id}/messages`,{method:'POST',headers:{Origin:original.url,'Content-Type':'application/json'},body:JSON.stringify({text:'original attachment',attachments:[attachment.id]})});expect(sent.status).toBe(200);
  callbacks!.onEvent({method:'turn/completed',params:{threadId:'native-original',turn:{id:'turn',status:'completed'}}});
  const checkpoint=original.store.listEvents(chat.id,0).filter(e=>e.kind==='status'&&(e.data as {status:string}).status==='idle').at(-1)!;
  const branch=await original.manager.fork(chat.id,checkpoint.id);
  const path=join(f.home,'attachments',chat.id,attachment.id,'files','sample.txt');
  for(const id of [chat.id,branch.id]){
   expect((original.store.listEvents(id,0).find(e=>e.kind==='user')!.data as {attachments:{path:string}[]}).attachments[0].path).toBe(path);
   const response=await fetch(original.url+`/api/conversations/${id}/attachments/${attachment.id}?download=1`);expect(response.status).toBe(200);expect(await response.text()).toBe(bytes);
  }
  await original.close();await backupWorkspace(f.home,f.snapshot);rmSync(f.home,{recursive:true});restored=await (async()=>{await restoreWorkspace(f.snapshot,f.restored);return serve(f.restored);})();
  for(const id of [chat.id,branch.id]){
   const response=await fetch(restored.url+`/api/conversations/${id}/attachments/${attachment.id}?download=1`);expect(response.status).toBe(200);expect(await response.text()).toBe(bytes);
   const user=restored.store.listEvents(id,0).find(e=>e.kind==='user')!.data as {attachments:{path:string}[];nativeText:string};
   expect(user.attachments[0].path).toBe(join(f.restored,'attachments',chat.id,attachment.id,'files','sample.txt'));expect(user.nativeText).toContain(path);
  }
 }finally{await restored?.close();await original.close();}
});
test('snapshot refuses an active Store and does not leave partial output',async()=>{const f=fixture(),store=openStore(f.home);try{await expect(backupWorkspace(f.home,f.snapshot)).rejects.toThrow('workspace_in_use');expect(existsSync(f.snapshot)).toBe(false);}finally{store.close();}});
test('SQLite snapshot includes committed WAL without relying on raw database copy',async()=>{
 const f=fixture();mkdirSync(f.home);const db=new DatabaseSync(join(f.home,'state.sqlite'));db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES (\'committed WAL\')');
 try{expect(statSync(join(f.home,'state.sqlite-wal')).size).toBeGreaterThan(0);await backupWorkspace(f.home,f.snapshot);}finally{db.close();}
 await restoreWorkspace(f.snapshot,f.restored);const restored=new DatabaseSync(join(f.restored,'state.sqlite'));try{expect(restored.prepare('SELECT value FROM fixture').get()?.value).toBe('committed WAL');}finally{restored.close();}
});
test.each(['corruption','traversal','symlink','existing destination'] as const)('restore rejects %s before publishing a workspace',async(kind)=>{
 const f=fixture(),store=openStore(f.home);store.close();await backupWorkspace(f.home,f.snapshot);
 if(kind==='corruption')writeFileSync(join(f.snapshot,'state.sqlite'),'corrupt');
 if(kind==='traversal'){const path=join(f.snapshot,'backup.json'),manifest=JSON.parse(readFileSync(path,'utf8'));manifest.files[0].path='../outside';writeFileSync(path,JSON.stringify(manifest));}
 if(kind==='symlink'){const path=join(f.snapshot,'state.sqlite');rmSync(path);symlinkSync(join(f.home,'state.sqlite'),path);}
 if(kind==='existing destination'){mkdirSync(f.restored);writeFileSync(join(f.restored,'keep'),'original');}
 await expect(restoreWorkspace(f.snapshot,f.restored)).rejects.toThrow();expect(existsSync(f.restored)).toBe(kind==='existing destination');if(kind==='existing destination')expect(readFileSync(join(f.restored,'keep'),'utf8')).toBe('original');
});
test('backup refuses managed symlinks and snapshots inside the source workspace',async()=>{
 const f=fixture(),store=openStore(f.home);store.close();mkdirSync(join(f.home,'workspaces'));symlinkSync('/tmp',join(f.home,'workspaces','outside'));
 await expect(backupWorkspace(f.home,f.snapshot)).rejects.toThrow('backup_unsafe_file');expect(existsSync(f.snapshot)).toBe(false);
 await expect(backupWorkspace(f.home,join(f.home,'nested'))).rejects.toThrow('backup_inside_workspace');
});


test('offline backup and restore retain the desktop appearance document', async () => {
 const f=fixture(),store=openStore(f.home);store.close();
 const appearance=JSON.stringify({version:1,mode:'light',light:'catppuccin-latte',dark:'nord-dark'});
 writeFileSync(join(f.home,'desktop-appearance.json'),appearance,{mode:0o600});
 const preferences=JSON.stringify({version:1,values:{'mana-language':'zh-CN','mana-progress-view':'list'}});writeFileSync(join(f.home,'desktop-preferences.json'),preferences,{mode:0o600});
 await backupWorkspace(f.home,f.snapshot);await restoreWorkspace(f.snapshot,f.restored);
 expect(readFileSync(join(f.restored,'desktop-appearance.json'),'utf8')).toBe(appearance);
 expect(readFileSync(join(f.restored,'desktop-preferences.json'),'utf8')).toBe(preferences);
});
