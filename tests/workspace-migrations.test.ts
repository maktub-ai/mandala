import { expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateWorkspace, rollbackWorkspaceMigration } from '../server/workspace-migrations';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
const fixture=()=>{const home=mkdtempSync(join(tmpdir(),'workspace-migrate-'));const entries=[
 {id:'doc-1',kind:'document',title:'original',content:'Original bytes\n中文',scope:'agent',agentId:'a',projectId:'p',status:'candidate',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'},
 {id:'memory-1',kind:'memory',title:'memory',content:'unmigrated',scope:'global',level:'L4',status:'active',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}];writeFileSync(join(home,'knowledge.json'),JSON.stringify(entries));writeFileSync(join(home,'config.json'),'{}');return {home,entries};};
test('preview is read only; apply preserves hashes, IDs, candidate ACL and memory boundary; reopen and replay',async()=>{
 const {home,entries}=fixture(), before=readdirSync(home), original=readFileSync(join(home,'knowledge.json'));
 const preview=await migrateWorkspace(home,'preview');expect(readdirSync(home)).toEqual(before);expect(preview.read).toBe(2);expect(preview.retainedCandidates).toEqual(['doc-1']);
 const report=await migrateWorkspace(home,'apply');expect(report.imported).toBe(1);expect(report.hashes.knowledge).toBe(createHash('sha256').update(original).digest('hex'));
 expect(readFileSync(join(home,'knowledge.json'))).toEqual(original);
 const store=openStore(home), assets=createAssets(store,createAssetFiles(home));const mapping=store.database.prepare('SELECT * FROM legacy_asset_entries WHERE legacy_id=?').get('doc-1')!;
 expect(JSON.parse(mapping.data as string)).toEqual(entries[0]);const asset=assets.getAuthorizedAsset({userId:'local'},mapping.asset_id as string);
 expect(readFileSync(assets.readAssetFile({userId:'local'},{assetId:asset.id,versionId:asset.headVersionId!},'0').blobPath,'utf8')).toBe(entries[0].content);
 expect(assets.listAssets({userId:'local'})).toHaveLength(1);store.close();expect((await migrateWorkspace(home,'apply')).alreadyApplied).toBe(true);
 await rollbackWorkspaceMigration(home);expect(readFileSync(join(home,'knowledge.json'))).toEqual(original);
});
test('apply refuses open service, running executions, and rollback refuses new writes',async()=>{
 const {home}=fixture();let store=openStore(home);await expect(migrateWorkspace(home,'apply')).rejects.toThrow('workspace_in_use');store.close();
 await migrateWorkspace(home,'apply');store=openStore(home);const assets=createAssets(store,createAssetFiles(home));assets.createAsset({userId:'local'},{kind:'document',title:'new',owner:{userId:'local'}});store.close();
 await expect(rollbackWorkspaceMigration(home)).rejects.toThrow('rollback_requires_export');
});

test('legacy owner policy keeps Agent AND project, candidate remains ineligible, selected project uses trusted resolver only',async()=>{
 const {home,entries}=fixture();entries[0].status='active';writeFileSync(join(home,'knowledge.json'),JSON.stringify(entries));await migrateWorkspace(home,'apply');
 const store=openStore(home), files=createAssetFiles(home), p={userId:'local',agentId:'a'}, service=createAssets(store,files);
 expect(()=>service.getAuthorizedAsset(p,'doc-1')).toThrow();
 expect(createAssets(store,files,()=> 'p').getAuthorizedAsset(p,'doc-1').id).toBe('doc-1');
 expect(()=>createAssets(store,files,()=> 'wrong').getAuthorizedAsset(p,'doc-1')).toThrow();
 expect(()=>createAssets(store,files,()=> 'p').getAuthorizedAsset({...p,agentId:'b'},'doc-1')).toThrow();
 const changed=service.setAccess({userId:'local'},'doc-1',{mode:'selected',projectIds:['p']},1);
 expect(()=>service.getAuthorizedAsset({...p,projectId:'p'} as typeof p,'doc-1')).toThrow();
 expect(createAssets(store,files,()=> 'p').getAuthorizedAsset({...p,agentId:'b'},'doc-1').revision).toBe(changed.revision);
 const original=JSON.parse(store.database.prepare('SELECT data FROM legacy_asset_entries').get()!.data as string);original.status='candidate';store.database.prepare('UPDATE legacy_asset_entries SET data=?').run(JSON.stringify(original));
 expect(()=>createAssets(store,files,()=> 'p').getAuthorizedAsset(p,'doc-1')).toThrow();store.close();
});
test.each(['running','approval'] as const)('%s conversations refuse offline apply and safe pre-cutover rollback preserves old store',async(status)=>{
 const {home}=fixture();let store=openStore(home);const chat=store.createConversation({agentId:'a',projectId:'p',cli:'codex',model:'m'});store.updateConversation(chat.id,{status});store.close();
 await expect(migrateWorkspace(home,'apply')).rejects.toThrow('running_execution');
 store=openStore(home);store.updateConversation(chat.id,{status:'idle'});createAssets(store,createAssetFiles(home));store.database.exec("CREATE TRIGGER reject_asset AFTER INSERT ON assets BEGIN SELECT RAISE(ABORT,'failure'); END");store.close();
 await expect(migrateWorkspace(home,'apply')).rejects.toThrow();await rollbackWorkspaceMigration(home);store=openStore(home);expect(store.getConversation(chat.id)?.status).toBe('idle');expect(store.database.prepare('SELECT count(*) AS n FROM assets').get()!.n).toBe(0);store.close();
});

test('failed pre-cutover import rollback also refuses subsequent writes',async()=>{
 const {home}=fixture();let store=openStore(home);createAssets(store,createAssetFiles(home));store.database.exec("CREATE TRIGGER reject_asset AFTER INSERT ON assets BEGIN SELECT RAISE(ABORT,'failure'); END");store.close();
 await expect(migrateWorkspace(home,'apply')).rejects.toThrow();store=openStore(home);store.database.exec('DROP TRIGGER reject_asset');createAssets(store,createAssetFiles(home)).createAsset({userId:'local'},{kind:'document',title:'new work',owner:{userId:'local'}});store.close();
 writeFileSync(join(home,'config.json'),'{"new":"work"}');await expect(rollbackWorkspaceMigration(home)).rejects.toThrow('rollback_requires_export');
});

test('apply acquires maintenance before capturing bytes from a service finishing its final write',async()=>{
 const {home,entries}=fixture();const store=openStore(home), knowledge=await import('../server/knowledge');
 const original=knowledge.readKnowledge;let closed=false;
 const read=vi.spyOn(knowledge,'readKnowledge').mockImplementation(async(path)=>{
  const captured=await original(path);entries[0].content='new saved text';writeFileSync(join(home,'knowledge.json'),JSON.stringify(entries));store.close();closed=true;return captured;
 });
 try {await expect(migrateWorkspace(home,'apply')).rejects.toThrow('workspace_in_use');}
 finally {read.mockRestore();if(!closed)store.close();}
});
test('preview of a stopped WAL database leaves every source entry and byte unchanged',async()=>{
 const {home}=fixture();openStore(home).close();const names=readdirSync(home).sort();
 const hash=()=>Object.fromEntries(readdirSync(home).filter(name=>name!=='.store-leases').map(name=>[name,createHash('sha256').update(readFileSync(join(home,name))).digest('hex')]));
 const before=hash();await migrateWorkspace(home,'preview');expect(readdirSync(home).sort()).toEqual(names);expect(hash()).toEqual(before);
});
test('preview sees committed migration status in live WAL without changing source bytes',async()=>{
 const {home}=fixture();await migrateWorkspace(home,'apply');const store=openStore(home);
 try {
  const row=store.database.prepare('SELECT key,data FROM workspace_migrations').get()!;
  const changed={...JSON.parse(row.data as string),read:999};store.database.prepare('UPDATE workspace_migrations SET data=? WHERE key=?').run(JSON.stringify(changed),row.key as string);
  const names=['state.sqlite','state.sqlite-wal','state.sqlite-shm','knowledge.json','config.json'];
  const before=names.map(name=>readFileSync(join(home,name)));const entries=readdirSync(home).sort();
  expect((await migrateWorkspace(home,'preview')).read).toBe(999);
  expect(readdirSync(home).sort()).toEqual(entries);for(let i=0;i<names.length;i++)expect(readFileSync(join(home,names[i]))).toEqual(before[i]);
 }finally{store.close();}
});
