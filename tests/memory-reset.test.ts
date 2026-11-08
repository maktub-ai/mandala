import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { memoryServices } from '../server/memory-runtime';
import { resetMemory } from '../server/memory-reset';
const cleanups:(()=>void)[]=[];afterEach(()=>cleanups.splice(0).forEach(fn=>fn()));
test('authorized reset removes only derived memory and prevents old test history being automatically rebuilt',()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-reset-')),store=openStore(home),s=memoryServices(home,store),p={userId:'local'};
 cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const c=s.memory.ensureCollection(p,{projectId:null,agentId:null}),chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 store.appendEvent(chat.id,'user',{text:'old test fact'});store.appendEvent(chat.id,'status',{status:'idle'});
 s.memory.captureConversation(p,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});
 const events=store.listEvents(chat.id,0),assetCount=store.database.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n;
 const result=resetMemory(store);expect(result.sources).toBe(1);expect(s.jobs.list(p)).toEqual([]);expect(s.memory.listAll(p)).toEqual([]);
 expect(store.listEvents(chat.id,0)).toEqual(events);expect(store.database.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n).toBe(assetCount);
 expect(s.memory.captureConversation(p,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources).toEqual([]);
 store.appendEvent(chat.id,'user',{text:'new ordinary fact'});store.appendEvent(chat.id,'status',{status:'idle'});
 const next=s.memory.captureConversation(p,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});expect(next.sources).toHaveLength(1);expect(next.sources[0].text).not.toContain('old test fact');
});
test('reset removes cached semantic vectors as derived memory',()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-reset-vectors-')),store=openStore(home);memoryServices(home,store);
 cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 store.database.prepare('INSERT INTO memory_vectors VALUES(?,?,?)').run('synthetic','hash','[1,0]');resetMemory(store);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()!.n).toBe(0);
});
