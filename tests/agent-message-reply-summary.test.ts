import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {createTasks} from '../server/tasks';
import {createAgentMessages,REPLY_BATCH_WAIT_MS} from '../server/agent-messages';
import type {QueuedInput} from '../shared/tasks';

let home:string,store:Store;
afterEach(()=>{store?.close();rmSync(home,{recursive:true,force:true});});

function fixture(purpose?:'mandala-main'){
 home=mkdtempSync(join(tmpdir(),'mana-reply-summary-'));store=openStore(home);createTasks(store);
 store.database.exec('CREATE TABLE IF NOT EXISTS task_user_inputs(id TEXT PRIMARY KEY,state TEXT);CREATE TABLE IF NOT EXISTS task_directory_claims(kind TEXT,owner_id TEXT,submitted INTEGER)');
 const chat=(p?:'mandala-main')=>store.createConversation({projectId:'',agentId:'agent',cli:'codex',model:null,...(p?{purpose:p}:{})});
 const source=chat(purpose),first=chat(),second=chat(),queued:QueuedInput[]=[],woken:string[]=[];
 let clock=Date.parse('2026-11-25T00:00:00Z');
 const messages=createAgentMessages(store,(conversationId,text)=>{const input:QueuedInput={id:'input-'+queued.length,conversationId,text,state:'queued',createdAt:'2026-11-25T00:00:00Z'};queued.push(input);return input;},()=>true,id=>woken.push(id),()=>clock);
 const request=store.appendEvent(source.id,'user',{text:'长对话滚动很卡，能这周修掉吗？'});
 const a=messages.create(source.id,first.id,{targetAgentId:'researcher',text:'Diagnose the rendering'},{eventId:request.id,invocationId:'inv'},'ask-a');
 const b=messages.create(source.id,second.id,{targetAgentId:'tester',text:'Add a benchmark'},{eventId:request.id,invocationId:'inv'},'ask-b');
 return {source,queued,woken,messages,a,b,advance:(ms:number)=>{clock+=ms;}};
}

test('main chat asks for a contextual summary of all sibling replies in one continuation',()=>{
 const {source,queued,messages,a,b}=fixture('mandala-main');
 messages.finish(queued[0].id,'succeeded','Long diagnostic report');messages.queueReplies(source.id);
 expect(queued).toHaveLength(2);
 expect(messages.get(a.id).replyState).toBe('pending');
 messages.finish(queued[1].id,'succeeded','Benchmark added');messages.queueReplies(source.id);
 expect(queued).toHaveLength(3);
 const continuation=queued[2];
 expect(continuation.text).toContain('short summary in the context of their original request');
 expect(continuation.text).toContain('Long diagnostic report');
 expect(continuation.text).toContain('Benchmark added');
 expect(messages.metadata(continuation.id)).toMatchObject({id:a.id,direction:'reply',batchIds:[a.id,b.id]});
 expect(messages.eligible(continuation)).toBe(true);
 messages.finish(continuation.id,'succeeded','Summary');
 expect([messages.get(a.id).replyState,messages.get(b.id).replyState]).toEqual(['consumed','consumed']);
});

test('main chat summarizes the replies that arrived once a sibling exceeds the wait',()=>{
 const {source,queued,woken,messages,a,b,advance}=fixture('mandala-main');
 messages.finish(queued[0].id,'succeeded','Report');messages.queueReplies(source.id);
 expect(queued).toHaveLength(2);
 advance(REPLY_BATCH_WAIT_MS+1);messages.queueReplies(source.id);
 expect(queued).toHaveLength(3);
 expect(messages.metadata(queued[2].id)).toEqual({id:a.id,direction:'reply',sourceRequestEventId:expect.any(Number)});
 expect(messages.get(b.id).replyState).toBe('pending');
 expect(woken).toEqual([]);
});

test('cancelling a batched continuation parks every reply it carried',()=>{
 const {source,queued,messages,a,b}=fixture('mandala-main');
 messages.finish(queued[0].id,'succeeded','One');messages.finish(queued[1].id,'succeeded','Two');messages.queueReplies(source.id);
 messages.cancel(queued[2].id);
 expect([messages.get(a.id).replyState,messages.get(b.id).replyState]).toEqual(['parked','parked']);
});

test('task and side chats keep one continuation per reply with the original wording',()=>{
 const {source,queued,messages}=fixture();
 messages.finish(queued[0].id,'succeeded','First');messages.queueReplies(source.id);
 expect(queued).toHaveLength(3);
 expect(queued[2].text).toMatch(/^Continue the original request using this reply/);
});
