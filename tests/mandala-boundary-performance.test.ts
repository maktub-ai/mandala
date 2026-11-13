import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {mandalaContextBoundary} from '../server/mandala';

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
