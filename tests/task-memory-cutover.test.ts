import {expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {memoryServices} from '../server/memory-runtime';
import {memoryStageSummary} from '../server/memory-store';

test('task reset preserves readable fixed memories and event integrity without widening Agent access',()=>{
 const home=mkdtempSync(join(tmpdir(),'task-memory-reset-')),store=openStore(home),owner={userId:store.ownerUserId};
 try{
  const {tasks,memory}=memoryServices(home,store),collection=memory.ensureCollection(owner,{projectId:'p',agentId:'a'});
  const chat=store.createConversation({agentId:'a',projectId:'p',cli:'codex',model:null});
  let task=tasks.createTask(owner,{goal:'Retain this verified history',projectId:'p',assigneeAgentId:'a',originConversationId:chat.id},'task');
  task=tasks.moveTask(owner,task.id,task.revision,'completed',null,'complete');
  const event=store.appendEvent(chat.id,'user',{text:'Keep the conversation evidence',taskId:task.id});
  store.appendEvent(chat.id,'text',{text:'Historical response'});store.appendEvent(chat.id,'status',{status:'idle'});
  const sources=[...memory.captureTask(owner,{collectionId:collection.id,taskId:task.id,trigger:'completed'}).sources,...memory.captureConversation(owner,{collectionId:collection.id,conversationId:chat.id,trigger:'completed'}).sources];
  expect(sources).toHaveLength(2);
  const records=sources.map(source=>memory.applyProposal(owner,{collectionId:collection.id,layer:'L2',contentType:'fact',text:memoryStageSummary(source),operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:null,certainty:'inferred'},collection.generation,'stage_summary')!);
  expect(records.map(record=>memory.read(owner,record.recordId).text)).toEqual(records.map(record=>record.text));
  store.database.exec('ALTER TABLE work_tasks RENAME COLUMN origin_conversation_id TO parent_task_id');
  createTasks(store);
  const retained=memoryServices(home,store).memory;
  expect(retained.list(owner,{projectId:'p'}).map(record=>record.recordId).sort()).toEqual(records.map(record=>record.recordId).sort());
  expect(retained.read({...owner,agentId:'a'},records[0].recordId,'p').text).toBe(records[0].text);
  expect(()=>retained.read({...owner,agentId:'b'},records[0].recordId,'p')).toThrow();
  const recaptured=retained.captureConversation(owner,{collectionId:collection.id,conversationId:chat.id,trigger:'completed'});
  expect(recaptured.sources[0].revision).toBe(sources[1].revision);
  expect(retained.read(owner,records[1].recordId).text).toBe(records[1].text);
  const activeJobs=store.database.prepare("SELECT data FROM memory_jobs WHERE json_extract(data,'$.state') IN ('queued','running','pending')").all().map(row=>JSON.parse(row.data as string));
  expect(activeJobs.some(job=>job.sourceRefs.some((ref:{sourceId:string})=>ref.sourceId===sources[0].id))).toBe(false);
  store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Edited after migration'}),event.id);
  expect(()=>retained.read(owner,records[1].recordId)).toThrow('source_changed');
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
