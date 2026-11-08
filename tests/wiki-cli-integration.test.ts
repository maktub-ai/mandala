import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { readConfig, writeConfig } from '../server/config';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import type { CodexClient, CodexOptions } from '../server/codex';
import { businessCliContext } from './business-cli-context';
import { invokeBusinessCli } from '../server/business-cli-http';
import { findCommand } from '../cli/commands.mjs';
import type { IncomingMessage } from 'node:http';
let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,native:CodexOptions,context:ReturnType<typeof businessCliContext>;
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'wiki-cli-'));const c=await readConfig(home);await writeConfig(home,{...c.config,agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},runtime:{codex:{fullAccess:false}},mcp:[],skills:[]}]},c.revision);store=openStore(home);manager=createSessionManager(store,async()=>(await readConfig(home)).config,async(options):Promise<CodexClient>=>{native=options;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{context=businessCliContext(p.instructions);return 'native';},resumeThread:async()=>{},startTurn:async()=> 'turn',interrupt:async()=>{},replyApproval(){},close(){}};},undefined,home);const chat=await manager.create('','a',undefined,undefined,{workspaceId:null});await manager.send(chat.id,'Create a wiki');});
afterEach(async()=>{await manager.close();store.close();await rm(home,{recursive:true,force:true});});
const invoke=(command:string,args:Record<string,unknown>,commandKey=command)=>invokeBusinessCli(manager,{headers:{authorization:'Bearer '+context.token}} as IncomingMessage,{command,args,commandKey},name=>findCommand(name)?.boundTool);
const input={name:'Bound wiki',purpose:'Verified conclusions',automatic:false,reception:{enabled:false,agentId:'a'}};
test('actual bound launcher creates and lists a wiki; retries preserve one object and changed input is rejected',async()=>{
 await projectChat('a');
 const run=(args:string[])=>new Promise<any>((resolve,reject)=>execFile(context.launcher,args,(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(JSON.parse(stdout))));
 const first=await run(['wiki','create','--data',JSON.stringify({...input,maintainerAgentId:'a'}),'--key','once']);const second=await invoke('wiki create',{...input,maintainerAgentId:'a'},'once') as any;expect(second.id).toBe(first.data.id);expect(await invoke('wiki list',{})).toHaveLength(1);expect(first.data.maintainerAgentId).toBe('a');await expect(invoke('wiki create',{...input,name:'Changed'},'once')).rejects.toMatchObject({status:409});
});
test('Wiki host rejects identity/path overrides and expired invocation before mutation',async()=>{
 for(const extra of [{agentId:'b'},{path:'/tmp/source'}])await expect(invoke('wiki create',{...input,...extra},'bad')).rejects.toMatchObject({status:422});
 native.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});await expect(invoke('wiki create',input,'expired')).rejects.toMatchObject({status:403});expect(store.database.prepare('SELECT COUNT(*) AS n FROM wiki_bases').get()!.n).toBe(0);
});

async function projectChat(agentId='') {
 const saved=await readConfig(home);await writeConfig(home,{...saved.config,projects:[{id:'p',name:'Project P',cwd:home,agentIds:['a'],resources:[],skills:[],mcp:[]},{id:'q',name:'Project Q',cwd:home,agentIds:['a'],resources:[],skills:[],mcp:[]}]},saved.revision);
 const c=await manager.create('p',agentId,undefined,'codex',{workspaceId:null});await manager.send(c.id,'Create project knowledge');return c;
}
test.each(['','a'])('Project Chat with Agent %j creates a Project-owned Wiki through the real bound CLI',async agentId=>{
 await projectChat(agentId);const args={name:'Project Wiki',purpose:'Project knowledge',projectId:'p',automatic:false,reception:{enabled:false}};
 const first=await invoke('wiki create',args,'project-once') as any;expect(first).toMatchObject({projectId:'p',ownership:'project',maintainerAgentId:null});
 expect((await invoke('wiki create',args,'project-once') as any).id).toBe(first.id);expect(await invoke('wiki list',{})).toHaveLength(1);
 expect(JSON.parse(store.database.prepare('SELECT data FROM assets WHERE id=?').get(first.id)!.data as string).owner).toEqual({userId:expect.any(String),projectId:'p'});
});
test('Project invocation rejects overrides, cross-project reads, membership removal, missing Project and expired tokens',async()=>{
 const c=await projectChat();await expect(invoke('wiki create',{...input,projectId:'q'},'cross')).rejects.toMatchObject({status:403});
 const base=await invoke('wiki create',{...input,reception:{enabled:false}},'host-project') as any;expect(base.projectId).toBe('p');
 const saved=await readConfig(home);await writeConfig(home,{...saved.config,projects:saved.config.projects.filter(p=>p.id!=='p')},saved.revision);
 await expect(invoke('wiki get',{baseId:base.id})).rejects.toMatchObject({status:403});await expect(invoke('wiki list',{})).rejects.toMatchObject({status:403});await expect(invoke('wiki create',input,'removed')).rejects.toMatchObject({status:403});
 expect(store.getConversation(c.id)?.agentId).toBe('');
});

test('no Project requests guide selection and never create legacy ownership',async()=>{await expect(invoke('wiki create',input,'no-project')).rejects.toMatchObject({code:'wiki_project_required',status:422});expect(store.database.prepare('SELECT COUNT(*) AS n FROM wiki_bases').get()!.n).toBe(0);});
test('cross-Project base IDs, revoked Agent membership and expired Project tokens are denied',async()=>{
 await projectChat('a');const own=await invoke('wiki create',{...input,reception:{enabled:false}},'own') as any;
 const other=await manager.knowledgeBase.create((await import('../server/workspace-identity')).workspacePrincipal(store),{...input,projectId:'q',reception:{enabled:false}});
 await expect(invoke('wiki get',{baseId:other.id})).rejects.toMatchObject({status:403});expect((await invoke('wiki list',{}) as any[]).map(b=>b.id)).toEqual([own.id]);
 const saved=await readConfig(home);saved.config.projects[0].agentIds=[];await writeConfig(home,saved.config,saved.revision);await expect(invoke('wiki get',{baseId:own.id})).rejects.toMatchObject({status:403});
 await expect(invoke('wiki create',{...input,reception:{enabled:false}},'own')).rejects.toMatchObject({status:403});
 native.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});await expect(invoke('wiki get',{baseId:own.id})).rejects.toMatchObject({status:403});
});

test('W05 original token cannot follow a changed Chat Project or Agent',async()=>{const c=await projectChat();store.database.prepare("UPDATE conversations SET data=json_set(data,'$.projectId',?) WHERE id=?").run('q',c.id);await expect(invoke('wiki create',{...input,reception:{enabled:false}},'moved')).rejects.toMatchObject({status:403});expect(store.database.prepare('SELECT COUNT(*) AS n FROM wiki_bases').get()!.n).toBe(0);});
