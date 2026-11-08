import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '../server/store';
import { asyncQuestions, initializeAsyncQuestions } from '../server/async-questions';

let home:string,store:ReturnType<typeof openStore>,id:string;
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'async-questions-'));store=openStore(home);
  id=store.createConversation({agentId:'',projectId:'',cli:'codex',model:null}).id;
  store.updateConversation(id,{nativeId:'native'});
  initializeAsyncQuestions(store);
});
afterEach(()=>{store.close();rmSync(home,{recursive:true,force:true});});
const emit=(turnId='turn-1',patch:Record<string,unknown>={})=>store.appendEvent(id,'tool',{
  runId:turnId,method:'item/completed',params:{threadId:'native',turnId,
    item:{id:'same-item',type:'agentMessage',delivery:'async',questions:[{title:'Drink?',options:['Tea','Coffee']}],...patch}},
});
it('keeps item identities distinct across turns and retires only the answered form',()=>{
  emit();emit('turn-2');
  const forms=asyncQuestions(store,id);
  expect(forms).toHaveLength(2);expect(forms[0].id).not.toBe(forms[1].id);
  store.appendEvent(id,'metadata',{answeredQuestionId:forms[0].id});
  expect(asyncQuestions(store,id).map(a=>a.id)).toEqual([forms[1].id]);
});
it('migrates legacy plain-text forms once without expiring newer independent questions',()=>{
  emit();store.appendEvent(id,'user',{text:'An ordinary human answer'});emit('turn-2');
  store.database.exec('DELETE FROM async_question_migration');initializeAsyncQuestions(store);
  expect(asyncQuestions(store,id)).toHaveLength(1);
  store.appendEvent(id,'user',{text:'Another unrelated request'});emit('turn-3');
  initializeAsyncQuestions(store);
  expect(asyncQuestions(store,id)).toHaveLength(2);
});
it.each([{questions:[]},{questions:[null]},{questions:[{title:'Changed',options:'invalid'}]},{delivery:null}])('retires replaced forms even when replacement cannot be rendered: %j',patch=>{
  emit();expect(asyncQuestions(store,id)).toHaveLength(1);
  emit('turn-1',patch);expect(asyncQuestions(store,id)).toEqual([]);
});
it('rejects interrupted runs and archived conversations',()=>{
  emit();store.appendEvent(id,'status',{runId:'turn-1',status:'interrupted'});
  expect(asyncQuestions(store,id)).toEqual([]);
  emit('turn-2');expect(asyncQuestions(store,id)).toHaveLength(1);
  store.archiveConversation(id,true);
  expect(asyncQuestions(store,id)).toEqual([]);
});
