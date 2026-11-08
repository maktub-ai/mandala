import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateHome } from '../server/home-migration';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { saveAttachment, loadAttachments, readAttachmentBytes } from '../server/attachments';
import { createTaskResources } from '../server/task-resources';
import { createSessionManager } from '../server/sessions';
import { claimServiceHome } from '../server/service-home-lock';

const roots: string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'mandala-home-')));roots.push(root);
 const from=join(root,'.open-mana'),to=join(root,'.mandala'),backup=join(root,'backup');
 return {root,from,to,backup};
}

it('moves a complete home, retains original identity and history, rebases owned paths and creates new chats in the canonical home',async()=>{
 const f=await fixture(),store=openStore(f.from),workspace=join(f.from,'workspaces','project');
 await fs.mkdir(workspace,{recursive:true});await fs.writeFile(join(workspace,'note.txt'),'retained workspace');
 const initial=await readConfig(f.from);
 await writeConfig(f.from,{runtimes:['codex','omp'],version:2,projects:[{id:'p',name:'Mandala',cwd:workspace,agentIds:[],mcp:[],skills:[],resources:[{id:'external',label:'external',kind:'local',location:'/external/open-mana'}]}],agents:[]},initial.revision);
 const configPath=join(f.from,'config.json'),savedConfig=JSON.parse(await fs.readFile(configPath,'utf8'));
 savedConfig.connections=[{id:'fixture',name:'fixture',transport:'stdio',command:join(f.from,'tools','mcp'),args:['--script',join(f.from,'cases','mcp.mjs'),'unmodified OpenMana argument','/external/open-mana']}];await fs.writeFile(configPath,JSON.stringify(savedConfig));
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null,cwd:workspace});
 store.updateConversation(chat.id,{nativeId:'/native/old-session.jsonl'});
 const attachment=await saveAttachment(f.from,chat.id,'retained.txt',Buffer.from('original attachment bytes'));
 const loaded=(await loadAttachments(f.from,chat.id,[attachment.id]))[0];
 const text='Historical OpenMana request: '+f.from;
 const event=store.appendEvent(chat.id,'user',{text,nativeText:text,attachments:[loaded]});
 store.database.exec('CREATE TABLE fixture_memory(body TEXT NOT NULL)');
 store.database.prepare('INSERT INTO fixture_memory VALUES (?)').run(text);
 createTaskResources(store).claim({kind:'run',id:'historical-claim'},[workspace],'write');
 store.close();
 await fs.writeFile(join(f.from,'accounts.json'),'synthetic identity bytes',{mode:0o600});
 await fs.writeFile(join(f.from,'.custom-state'),'hidden state');
 await fs.symlink('/external/retained',join(f.from,'external-link'),'junction');
 const result=await migrateHome(f.from,f.to,f.backup);
 expect(result.status).toBe('migrated');expect(lstatSync(f.from).isSymbolicLink()).toBe(true);expect(realpathSync(f.from)).toBe(f.to);
 expect(readFileSync(join(f.to,'accounts.json'),'utf8')).toBe('synthetic identity bytes');
 expect(readFileSync(join(f.backup,'home','accounts.json'),'utf8')).toBe('synthetic identity bytes');
 expect(readFileSync(join(f.to,'.custom-state'),'utf8')).toBe('hidden state');
 expect(await fs.readlink(join(f.to,'external-link'))).toBe('/external/retained');
 expect(existsSync(join(f.backup,'home','.workspace-maintenance'))).toBe(false);
 const config=(await readConfig(f.to)).config;
 expect(config.projects[0].cwd).toBe(join(f.to,'workspaces','project'));
 expect(config.projects[0].resources[0].location).toBe('/external/open-mana');
 expect(config.connections?.[0]).toMatchObject({command:join(f.to,'tools','mcp'),args:['--script',join(f.to,'cases','mcp.mjs'),'unmodified OpenMana argument','/external/open-mana']});
 const migrated=openStore(f.to);
 try{
  expect(migrated.getConversation(chat.id)).toMatchObject({cwd:join(f.to,'workspaces','project'),nativeId:'/native/old-session.jsonl'});
  expect(migrated.listEvents(chat.id,0)[0]).toMatchObject({id:event.id,data:{text,nativeText:text,attachments:[{path:join(f.to,'attachments',chat.id,attachment.id,'files','retained.txt')}]}});
  expect(migrated.database.prepare('SELECT body FROM fixture_memory').get()?.body).toBe(text);
  expect(JSON.parse(migrated.database.prepare('SELECT paths FROM task_directory_claims').get()!.paths as string)).toEqual([join(f.to,'workspaces','project')]);
  expect(await readAttachmentBytes(f.to,(await loadAttachments(f.to,chat.id,[attachment.id]))[0])).toEqual(Buffer.from('original attachment bytes'));
  expect(await readAttachmentBytes(f.from,loaded)).toEqual(Buffer.from('original attachment bytes'));
  let cwd='';
  const manager=createSessionManager(migrated,async()=>config,async()=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async input=>{cwd=input.cwd;return 'new-native';},resumeThread:async()=>{},startTurn:async()=> 'turn',interrupt:async()=>{},replyApproval(){},close(){}}),undefined,f.to);
  try{const fresh=await manager.create('','','fixture','codex');await manager.send(fresh.id,'new request');expect(cwd).toBe(join(f.to,'workspaces','conversations',fresh.id));}finally{await manager.close();}
 }finally{migrated.close();}
 const saved=openStore(join(f.backup,'home'));try{expect(saved.listEvents(chat.id,0)[0].data).toMatchObject({text,attachments:[{path:loaded.path}]});}finally{saved.close();}
 expect((await migrateHome(f.from,f.to,f.backup)).status).toBe('already_migrated');
});

it('refuses a live Store without moving data or leaving migration locks',async()=>{
 const f=await fixture(),store=openStore(f.from);
 try{await expect(migrateHome(f.from,f.to,f.backup)).rejects.toThrow('workspace_in_use');expect(existsSync(f.to)).toBe(false);expect(existsSync(f.backup)).toBe(false);}finally{store.close();}
 expect(existsSync(f.to+'.migrating')).toBe(false);
});

it('migrates explicitly selected nested profiles without rewriting archived snapshots',async()=>{
 const f=await fixture(),relative='cases/connected-workspace',nested=join(f.from,relative);
 openStore(f.from).close();const store=openStore(nested),chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null,cwd:join(nested,'workspaces','old')});
 const attachment=await saveAttachment(nested,chat.id,'nested.txt',Buffer.from('nested attachment'));
 store.appendEvent(chat.id,'user',{text:'historical OpenMana',attachments:await loadAttachments(nested,chat.id,[attachment.id])});store.close();
 const archive=join(f.from,'archived');await fs.cp(nested,archive,{recursive:true});const original=readFileSync(join(archive,'state.sqlite'));
 await migrateHome(f.from,f.to,f.backup,[relative]);
 expect(readFileSync(join(f.to,'archived','state.sqlite'))).toEqual(original);
 const migrated=openStore(join(f.to,relative));
 try{const data=migrated.listEvents(chat.id,0)[0].data as {attachments:Parameters<typeof readAttachmentBytes>[1][]};expect(await readAttachmentBytes(join(f.to,relative),data.attachments[0])).toEqual(Buffer.from('nested attachment'));expect(migrated.getConversation(chat.id)?.cwd).toBe(join(f.to,relative,'workspaces','old'));}finally{migrated.close();}
 expect(existsSync(join(f.backup,'home',relative,'.service-home-lock'))).toBe(false);
});

it('refuses an unselected nested live Store',async()=>{
 const f=await fixture();openStore(f.from).close();const store=openStore(join(f.from,'cases','active'));
 try{await expect(migrateHome(f.from,f.to,f.backup)).rejects.toThrow('workspace_in_use');expect(existsSync(f.to)).toBe(false);}finally{store.close();}
});

it('refuses nested profiles outside the source or reached through symlinks',async()=>{
 const f=await fixture();openStore(f.from).close();const external=join(f.root,'external');openStore(external).close();await fs.symlink(external,join(f.from,'linked'));
 for(const relative of ['../external','linked'])await expect(migrateHome(f.from,f.to,f.backup,[relative])).rejects.toThrow('invalid_nested_home');
});

it.each(['directory','dangling link'] as const)('refuses an occupied destination: %s',async kind=>{
 const f=await fixture();openStore(f.from).close();
 if(kind==='directory'){await fs.mkdir(f.to);await fs.writeFile(join(f.to,'keep'),'unrelated');}else await fs.symlink(join(f.root,'missing'),f.to,'junction');
 await expect(migrateHome(f.from,f.to,f.backup)).rejects.toThrow('migration_target_exists');
 expect(lstatSync(f.from).isDirectory()).toBe(true);expect(existsSync(f.backup)).toBe(false);
 if(kind==='directory')expect(readFileSync(join(f.to,'keep'),'utf8')).toBe('unrelated');else expect(lstatSync(f.to).isSymbolicLink()).toBe(true);
});

it('rolls back publication when creating the compatibility link fails',async()=>{
 const f=await fixture();openStore(f.from).close();await fs.writeFile(join(f.from,'accounts.json'),'retained identity');
 vi.spyOn(fs,'symlink').mockRejectedValueOnce(new Error('synthetic_link_failure'));
 await expect(migrateHome(f.from,f.to,f.backup)).rejects.toThrow('synthetic_link_failure');
 expect(lstatSync(f.from).isDirectory()).toBe(true);expect(readFileSync(join(f.from,'accounts.json'),'utf8')).toBe('retained identity');
 expect(existsSync(f.to)).toBe(false);expect(existsSync(f.to+'.migrating')).toBe(false);
 openStore(f.from).close();
});

it.each(['config.json','state.sqlite','current.json','control-current.json'])('refuses linked mutable metadata before rewriting %s',async name=>{
 const f=await fixture(),release=name.endsWith('current.json'),from=release?f.from+'-releases':f.from,to=release?f.to+'-releases':f.to;
 if(release)await fs.mkdir(from);else openStore(from).close();
 const external=join(f.root,'external-'+name);
 if(name==='state.sqlite')await fs.rename(join(from,name),external);
 else await fs.writeFile(external,JSON.stringify(name==='config.json'?{runtimes:['codex','omp'],version:2,projects:[{cwd:join(from,'workspaces')}],agents:[]}:{home:f.from,directory:join(from,'source')}));
 const original=readFileSync(external);await fs.symlink(external,join(from,name));
 await expect(migrateHome(from,to,f.backup)).rejects.toThrow('migration_unsafe_metadata');
 expect(readFileSync(external)).toEqual(original);expect(lstatSync(from).isDirectory()).toBe(true);expect(existsSync(to)).toBe(false);
});

it('restores the source on disk-full publication failure without allocating another temporary directory',async()=>{
 const f=await fixture();openStore(f.from).close();await fs.writeFile(join(f.from,'accounts.json'),'disk-full original');
 const original=fs.mkdtemp.bind(fs);let calls=0;
 vi.spyOn(fs,'mkdtemp').mockImplementation(async(...args:Parameters<typeof fs.mkdtemp>)=>{if(calls++)throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});return original(...args);});
 vi.spyOn(fs,'symlink').mockRejectedValueOnce(Object.assign(new Error('ENOSPC'),{code:'ENOSPC'}));
 await expect(migrateHome(f.from,f.to,f.backup)).rejects.toThrow('ENOSPC');
 expect(lstatSync(f.from).isDirectory()).toBe(true);expect(readFileSync(join(f.from,'accounts.json'),'utf8')).toBe('disk-full original');
 expect(existsSync(f.to)).toBe(false);expect(existsSync(f.to+'.migrating')).toBe(false);openStore(f.from).close();
});

it('refuses a live account-service home lock and migrates after release',async()=>{
 const f=await fixture(),from=f.from+'-account-service',to=f.to+'-account-service';
 const lock=claimServiceHome(from);
 try{await expect(migrateHome(from,to,f.backup)).rejects.toThrow('service_home_in_use');expect(existsSync(to)).toBe(false);}
 finally{lock.release();}
 expect((await migrateHome(from,to,f.backup)).status).toBe('migrated');
});

it.each(['account-service','releases'] as const)('preserves ancillary %s data and updates release manifest paths',async suffix=>{
 const f=await fixture(),from=f.from+'-'+suffix,to=f.to+'-'+suffix;
 await fs.mkdir(from);await fs.writeFile(join(from,'accounts.json'),'ancillary bytes');
 if(suffix==='releases')await fs.writeFile(join(from,'current.json'),JSON.stringify({directory:join(from,'source'),home:f.from,sha:'preserved',pid:42}));
 await migrateHome(from,to,f.backup);
 expect(realpathSync(from)).toBe(to);expect(readFileSync(join(to,'accounts.json'),'utf8')).toBe('ancillary bytes');
 if(suffix==='releases')expect(JSON.parse(readFileSync(join(to,'current.json'),'utf8'))).toMatchObject({directory:join(to,'source'),home:f.to,sha:'preserved',pid:42});
});
