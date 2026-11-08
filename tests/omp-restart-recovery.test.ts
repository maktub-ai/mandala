import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createSessionManager} from '../server/sessions';
import type {CodexClient} from '../server/codex';
import type {Config} from '../shared/types';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function setup(closeNative:()=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),'mandala-omp-restart-')),store=openStore(home),starts:string[]=[];
 const config:Config={version:2,runtimes:['omp'],projects:[{id:'p',name:'P',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'A',defaultCli:'omp',models:{},instructions:'',mcp:[],skills:[]}]};
 const factory=async():Promise<CodexClient>=>({getStatus:async()=>({status:'ready',version:null}),listModels:async()=>[],startThread:async()=> 'native-session',resumeThread:async()=>{},startTurn:async(_,text)=>{starts.push(text);return 'native-turn';},interrupt:async()=>{},replyApproval(){},close:closeNative});
 let manager=createSessionManager(store,async()=>config,undefined,factory,home);
 const conversation=store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null,cwd:home});
 cleanup.push(async()=>{await manager.close().catch(()=>{});store.close();rmSync(home,{recursive:true,force:true});});
 return {store,conversation,starts,get manager(){return manager;},restart(){manager=createSessionManager(store,async()=>config,undefined,factory,home);return manager;}};
}

test('confirmed OMP shutdown releases ordinary input occupancy for explicit continuation without replay',async()=>{
 let stopped!:()=>void;
 const f=setup(()=>new Promise<void>(resolve=>{stopped=resolve;}));
 const first=f.manager.enqueueUserInput(f.conversation.id,'original request','first');
 await vi.waitFor(()=>expect(f.store.database.prepare('SELECT native_turn_id FROM task_input_invocations WHERE input_id=?').get(first.id)?.native_turn_id).toBe('native-turn'));
 const next=f.manager.enqueueUserInput(f.conversation.id,'queued request','next');
 const closing=f.manager.close();
 expect(f.manager.listUserInputs(f.conversation.id)[0].state).toBe('unknown');
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims').all()).toHaveLength(1);
 stopped();await closing;
 expect(f.manager.listUserInputs(f.conversation.id)).toMatchObject([{id:first.id,state:'cancelled'},{id:next.id,state:'queued'}]);
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims').all()).toEqual([]);
 expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toEqual([]);
 expect(f.store.getConversation(f.conversation.id)).toMatchObject({status:'interrupted',nativeId:'native-session',turnId:null});
 expect(f.store.listEvents(f.conversation.id,0).some(e=>e.kind==='error'&&(e.data as {code?:string}).code==='service_closed')).toBe(true);
 const manager=f.restart();await manager.reconcileRuns('local');
 expect(f.starts).toEqual(['original request']);
 await manager.continue(f.conversation.id,'explicit continuation',[],[],'continue');
 expect(f.starts).toEqual(['original request','explicit continuation']);
 expect(f.store.getConversation(f.conversation.id)?.nativeId).toBe('native-session');
 const close=manager.close();stopped();await close;
});

test('failed OMP shutdown retains uncertain input and directory occupancy',async()=>{
 const f=setup(async()=>{throw new Error('native shutdown failed');});
 const input=f.manager.enqueueUserInput(f.conversation.id,'original request','first');
 await vi.waitFor(()=>expect(f.store.database.prepare('SELECT native_turn_id FROM task_input_invocations WHERE input_id=?').get(input.id)?.native_turn_id).toBe('native-turn'));
 await expect(f.manager.close()).rejects.toThrow('native shutdown failed');
 expect(f.manager.listUserInputs(f.conversation.id)[0].state).toBe('unknown');
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims').all()).toHaveLength(1);
 expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toHaveLength(1);
});
