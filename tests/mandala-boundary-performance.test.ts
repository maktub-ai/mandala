import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {mandalaContextBoundary,mandalaContinuity} from '../server/mandala';

it('finds the latest native reset through a selective index instead of scanning the chat history',()=>{
 const home=mkdtempSync(join(tmpdir(),'mandala-boundary-')),store=openStore(home);
 try{
  const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,purpose:'mandala-main'});
  store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
  store.appendEvent(chat.id,'text',{text:'History remains readable'});
  const latest=store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
  store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'other'}});
  const prepare=vi.spyOn(store.database,'prepare');
  expect(mandalaContextBoundary(store,chat.id)).toBe(latest.id);
  const sql=prepare.mock.calls.find(([sql])=>sql.startsWith('SELECT id FROM events'))![0];
  prepare.mockRestore();
  const plan=store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(chat.id);
  expect(plan.map(row=>row.detail).join(' ')).toContain('events_native_context_reset');
  store.database.prepare('DELETE FROM events WHERE id=?').run(latest.id);
  expect(mandalaContextBoundary(store,chat.id)).toBeLessThan(latest.id);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});

it('reads a versioned execution-only boundary without retiring visible messages or changing other chats',()=>{
 const home=mkdtempSync(join(tmpdir(),'mandala-boundary-')),store=openStore(home);
 try{
  const create=(purpose?:'mandala-main')=>store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,...(purpose?{purpose}:{})});
  const chat=create('mandala-main'),ordinary=create();
  const old=store.appendEvent(chat.id,'user',{text:'Visible before execution reset'});
  store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
  const previous=store.appendEvent(chat.id,'user',{text:'Prior native session request'});
  const boundary=store.appendEvent(chat.id,'metadata',{nativeExecutionBoundary:{version:1}});
  const message=store.appendEvent(chat.id,'user',{text:'Current native session request'});
  store.appendEvent(chat.id,'metadata',{nativeExecutionBoundary:{version:2}});
  store.appendEvent(chat.id,'metadata',{nativeExecutionBoundary:{version:'1'}});
  store.appendEvent(ordinary.id,'metadata',{nativeExecutionBoundary:{version:1}});
  const prepare=vi.spyOn(store.database,'prepare');
  expect(mandalaContextBoundary(store,chat.id)).toBe(boundary.id);
  const sql=prepare.mock.calls.find(([sql])=>sql.startsWith('SELECT id FROM events')&&sql.includes('nativeExecutionBoundary'))![0];
  prepare.mockRestore();
  const plan=store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(chat.id);
  expect(plan.map(row=>row.detail).join(' ')).toContain('events_native_execution_boundary');
  expect(mandalaContextBoundary(store,ordinary.id)).toBe(0);
  expect(mandalaContinuity(store,chat.id)).toContain('Current native session request');
  expect(mandalaContinuity(store,chat.id)).not.toMatch(/Visible before execution reset|Prior native session request/);
  expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user')).toEqual([old,previous,message]);
  const later=store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
  expect(mandalaContextBoundary(store,chat.id)).toBe(later.id);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
