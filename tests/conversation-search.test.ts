import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { DomainError } from '../shared/workspace-contracts';
let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>,url:string;
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'conversation-search-'));store=openStore(home);
 const {config,revision}=await readConfig(home);
 await writeConfig(home,{...config,agents:[{id:'a',name:'Finance Agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}],projects:[{id:'p',name:'Cloud Billing',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}]},revision);
 manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
 server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
const chat=(title:string)=>{const c=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});store.updateConversation(c.id,{title});return store.getConversation(c.id)!;};
const find=async(query:string)=>{const r=await fetch(url+'/api/conversations?query='+encodeURIComponent(query));expect(r.status).toBe(200);return r.json() as Promise<{id:string}[]>};
test('conversation search requires every keyword across title, Agent and Project, with Unicode and case normalization',async()=>{
 const target=chat('Azure 对账'),other=chat('AWS inventory');
 expect((await find('  ＡＺＵＲＥ　finance BILLING 对账  ')).map(c=>c.id)).toEqual([target.id]);
 expect(await find('Azure inventory')).toEqual([]);
 expect(new Set((await find('billing')).map(c=>c.id))).toEqual(new Set([target.id,other.id]));
});
test('conversation search matches visible user and native final text without returning transcripts',async()=>{
 const target=chat('Monthly notes');chat('Unrelated notes');
 store.appendEvent(target.id,'user',{text:'Review the invoice'});
 store.appendEvent(target.id,'text',{text:'partial phrase',itemId:'reply'});
 store.appendEvent(target.id,'tool',{method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:'账单核对已完成'}}});
 const result=await find('invoice 核对');expect(result.map(c=>c.id)).toEqual([target.id]);
 expect(await find('partial phrase')).toEqual([]);expect(result[0]).not.toHaveProperty('events');
});
test('conversation search excludes tool output, reasoning, metadata and replaced history',async()=>{
 const target=chat('Ordinary notes');
 store.appendEvent(target.id,'tool',{method:'item/completed',params:{item:{id:'tool',type:'commandExecution',text:'hidden-tool-word'}}});
 store.appendEvent(target.id,'tool',{method:'item/completed',params:{item:{id:'reason',type:'reasoning',text:'hidden-reason-word'}}});
 store.appendEvent(target.id,'metadata',{text:'hidden-metadata-word'});
 const replaced=store.appendEvent(target.id,'user',{text:'hidden-replaced-word'});store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(replaced.id);
 for(const word of ['hidden-tool-word','hidden-reason-word','hidden-metadata-word','hidden-replaced-word'])expect(await find(word)).toEqual([]);
});
test('conversation search never uses inaccessible conversation content or names to produce a match',async()=>{
 const target=chat('Private invoice');store.appendEvent(target.id,'user',{text:'confidential-search-word'});
 vi.spyOn(manager,'authorizeConversationRead').mockImplementation(()=>{throw new DomainError('forbidden',403,'Read denied')});
 expect(await find('confidential-search-word')).toEqual([]);expect(await find('Private invoice')).toEqual([]);
});
