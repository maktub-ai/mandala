import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {MEMORY_CUTOVER,memoryServices} from '../server/memory-runtime';
import {updateKnowledge} from '../server/knowledge';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'legacy-retirement-')),store=openStore(home),s=memoryServices(home,store),root={userId:'local'};
 store.database.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(MEMORY_CUTOVER,new Date().toISOString());
 s.memory.importLegacy(root,[{id:'legacy',kind:'memory',level:'L3',title:'Historical rule',content:'Synthetic retained rule',scope:'global',status:'candidate',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'}]);
 const record=s.memory.listAll(root)[0];
 const snapshot=()=>JSON.stringify(['memory_records','memory_revisions','memory_collections','memory_jobs','memory_suppressions'].map(t=>store.database.prepare('SELECT * FROM '+t).all()));
 cleanup.push(async()=>{await s.recall.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {home,store,...s,root,record,snapshot};
}
test.each(['confirm','correct'] as const)('retired legacy %s cannot adopt or rewrite a candidate',action=>{
 const s=setup(),before=s.snapshot();
 expect(()=>s.memory[action](s.root,{recordId:s.record.recordId,expectedRevision:1,text:'Changed synthetic rule'})).toThrow('legacy_memory_confirmation_retired');
 expect(s.snapshot()).toBe(before);
 expect(s.memory.read(s.root,s.record.recordId)).toEqual(s.record);
 expect(s.recall.search(s.root,{projectId:null,query:'Synthetic retained rule'}).items).toEqual([]);
});
test.each([{status:'active'},{content:'Changed synthetic rule'},{content:'Changed synthetic rule',status:'candidate'}])('legacy knowledge patch cannot revive old candidates: %j',async patch=>{
 const s=setup(),before=s.snapshot();
 await expect(updateKnowledge(s.home,'legacy',patch,{version:2,agents:[],projects:[]},s.store)).rejects.toMatchObject({code:'legacy_memory_confirmation_retired',status:410});
 expect(s.snapshot()).toBe(before);
});
test('existing active legacy memory remains readable and correctable',()=>{
 const s=setup();s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'active',content:'Active retained rule',status:'active'}]);
 const active=s.memory.listAll(s.root).find(r=>r.legacyId==='active')!;
 expect(s.memory.correct(s.root,{recordId:active.recordId,expectedRevision:1,text:'Corrected active rule'})).toMatchObject({status:'active',verification:'user_correction',revision:2});
 expect(s.memory.read(s.root,s.record.recordId)).toEqual(s.record);
});
test.each(['correct','restore','knowledge'] as const)('withdrawal cannot bypass retirement via %s',async action=>{
 const s=setup();s.memory.retract(s.root,{recordId:s.record.recordId,expectedRevision:1});const before=s.snapshot();
 if(action==='knowledge')await expect(updateKnowledge(s.home,'legacy',{content:'Changed rule'},{version:2,agents:[],projects:[]},s.store)).rejects.toMatchObject({code:'legacy_memory_confirmation_retired',status:410});
 else expect(()=>action==='correct'?s.memory.correct(s.root,{recordId:s.record.recordId,expectedRevision:2,text:'Changed rule'}):s.memory.restore(s.root,{recordId:s.record.recordId,expectedRevision:2})).toThrow('legacy_memory_confirmation_retired');
 expect(s.snapshot()).toBe(before);
});
test('withdrawal and restoration of originally active legacy memory retain existing behavior',()=>{
 const s=setup();s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'active-restorable',content:'Previously active rule',status:'active'}]);
 const active=s.memory.listAll(s.root).find(r=>r.legacyId==='active-restorable')!;
 s.memory.retract(s.root,{recordId:active.recordId,expectedRevision:1});
 expect(s.memory.restore(s.root,{recordId:active.recordId,expectedRevision:2})).toMatchObject({status:'active',revision:3,verification:'legacy_user_managed'});
});
