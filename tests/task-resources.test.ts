import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createTaskResources } from '../server/task-resources';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function setup(){const home=mkdtempSync(join(tmpdir(),'mana-resources-')),store=openStore(home);mkdirSync(join(home,'parent','child'),{recursive:true});mkdirSync(join(home,'other'));symlinkSync(join(home,'parent'),join(home,'alias'));cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return{home,store,resources:createTaskResources(store)};}
test('realpath aliases and ancestors conflict for writes while separate roots remain independent',()=>{
 const {home,resources}=setup();expect(resources.claimDirectory('one',join(home,'parent'),'write')).toBe('granted');
 for(const path of ['parent','parent/child','alias'])expect(resources.claimDirectory(path,join(home,path),'write')).toBe('queued');
 expect(resources.claimDirectory('other',join(home,'other'),'write')).toBe('granted');
});
test('shared reads coexist, writes wait and none consumes no project directory',()=>{
 const {home,resources}=setup();expect(resources.claimDirectory('read1',home,'read')).toBe('granted');expect(resources.claimDirectory('read2',home,'read')).toBe('granted');
 expect(resources.claimDirectory('write',home,'write')).toBe('queued');expect(resources.claimDirectory('none',home,'none')).toBe('granted');
});
test('submitted claims survive recreation and release only their exact confirmed native turn',()=>{
 const {home,resources,store}=setup();resources.claimDirectory('one',home,'write');resources.submitted('run','one','invocation','session');resources.bindTurn('run','one','invocation','session','turn1');
 const recreated=createTaskResources(store);expect(recreated.releaseUnsubmitted('run','one')).toBe(false);expect(recreated.claimDirectory('two',home,'write')).toBe('queued');
 expect(recreated.confirmTerminal('run','one',{invocationId:'invocation',nativeSessionId:'session',nativeTurnId:'old'})).toBe(false);
 expect(recreated.confirmTerminal('run','one',{invocationId:'invocation',nativeSessionId:'session',nativeTurnId:'turn1'})).toBe(true);
 expect(recreated.claimDirectory('two',home,'write')).toBe('granted');
});
test('direct conversation claims coexist but delegated writes still wait for their directory',()=>{
 const {home,resources}=setup();
 expect(resources.claim({kind:'invocation',id:'first',conversationId:'one'},[home],'write')).toBe('granted');
 expect(resources.claim({kind:'input',id:'second',conversationId:'two'},[home],'write')).toBe('granted');
 expect(resources.claim({kind:'invocation',id:'same-chat',conversationId:'one'},[home],'write')).toBe('queued');
 expect(resources.claimDirectory('delegated',home,'write')).toBe('queued');
});
test('same owner cannot expand a claimed path set or bypass a competing writer',()=>{
 const {home,resources}=setup(),owner={kind:'input' as const,id:'input',conversationId:'chat'};
 expect(resources.claim(owner,[join(home,'parent')],'write')).toBe('granted');
 expect(()=>resources.claim(owner,[join(home,'parent'),join(home,'other')],'write')).toThrow('directory_claim_conflict');
 expect(resources.claimDirectory('run',join(home,'parent','child'),'write')).toBe('queued');
});

test('explicitly exclusive input claims retain directory exclusion across recreation',()=>{
 const {home,resources,store}=setup();
 resources.claim({kind:'invocation',id:'a',conversationId:'a'},[home],'write');
 expect(resources.claim({kind:'input',id:'message',conversationId:'b',delegated:true},[home],'write')).toBe('queued');
 resources.releaseUnsubmitted('invocation','a');
 expect(resources.claim({kind:'input',id:'message',conversationId:'b',delegated:true},[home],'write')).toBe('granted');
 expect(createTaskResources(store).claim({kind:'invocation',id:'later',conversationId:'a'},[home],'write')).toBe('queued');
});

test('remote claims normalize absent POSIX directories and isolate the same path by host',()=>{
 const {home,store}=setup(),path=realpathSync(home);
 const hostForConversation=(id:string)=>id==='local'?undefined:id==='other'?'other-host':'build-host';
 const resources=createTaskResources(store,hostForConversation);
 expect(resources.claim({kind:'run',id:'remote',conversationId:'remote'},[path],'write')).toBe('granted');
 expect(resources.claim({kind:'run',id:'local',conversationId:'local'},[path],'write')).toBe('granted');
 expect(resources.claim({kind:'run',id:'other',conversationId:'other'},[path],'write')).toBe('granted');
 expect(resources.claim({kind:'run',id:'same-host',conversationId:'same'},[path+'/child'],'write')).toBe('queued');
 expect(resources.claim({kind:'run',id:'absent',conversationId:'remote'},['/srv/work/../project'],'write')).toBe('granted');
 expect(resources.claim({kind:'run',id:'normalized',conversationId:'remote'},['/srv/project/child'],'write')).toBe('queued');
 expect(()=>resources.claim({kind:'run',id:'relative',conversationId:'remote'},['relative/work'],'write')).toThrow('invalid_directory_claim');
});

test('an SSH alias named local stays distinct from local directory claims',()=>{
 const {home,store}=setup(),path=realpathSync(home);
 const resources=createTaskResources(store,id=>id==='remote'?'local':undefined);
 expect(resources.claim({kind:'run',id:'remote',conversationId:'remote'},[path],'write')).toBe('granted');
 expect(resources.claim({kind:'run',id:'local',conversationId:'chat'},[path],'write')).toBe('granted');
});

test('remote claim host identity survives recreation and existing owners cannot move hosts',()=>{
 const {store}=setup();let host:string|undefined='first-host';const resolveHost=()=>host;
 const owner={kind:'run' as const,id:'remote',conversationId:'remote'};
 const resources=createTaskResources(store,resolveHost);
 expect(resources.claim(owner,['/srv/project'],'write')).toBe('granted');
 const recreated=createTaskResources(store,resolveHost);
 expect(recreated.claim({kind:'run',id:'same-host',conversationId:'other'},['/srv/project'],'write')).toBe('queued');
 host='second-host';
 expect(()=>recreated.claim(owner,['/srv/project'],'write')).toThrow('directory_claim_conflict');
 expect(recreated.claim({kind:'run',id:'other-host',conversationId:'other'},['/srv/project'],'write')).toBe('granted');
 host=undefined;
 expect(()=>recreated.claim(owner,['/srv/project'],'write')).toThrow('directory_claim_conflict');
});

test('existing directory claims migrate as local while the same remote path stays independent',()=>{
 const {home,store}=setup(),path=realpathSync(home);
 store.database.exec(`DROP TABLE task_directory_claims;
  CREATE TABLE task_directory_claims(kind TEXT NOT NULL,owner_id TEXT NOT NULL,conversation_id TEXT,paths TEXT NOT NULL,mode TEXT NOT NULL,submitted INTEGER NOT NULL DEFAULT 0,invocation_id TEXT,native_session_id TEXT,native_turn_id TEXT,delegated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,owner_id));`);
 store.database.prepare('INSERT INTO task_directory_claims(kind,owner_id,paths,mode) VALUES (?,?,?,?)').run('run','existing',JSON.stringify([path]),'write');
 const resources=createTaskResources(store,()=> 'build-host');
 expect(resources.claimDirectory('local',path,'write')).toBe('queued');
 expect(resources.claim({kind:'run',id:'remote',conversationId:'remote'},[path],'write')).toBe('granted');
});
