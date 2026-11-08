import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {discoverWorkDirectories,type WorkDiscoveryInput} from '../server/work-directory-discovery';
import {runtimeIds} from '../shared/runtimes';

const homes:string[]=[],now=new Date('2026-10-30T00:00:00.000Z'),recent=now.getTime()/1000-100;
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
async function fixture(){const home=await realpath(await mkdtemp(join(tmpdir(),'work-discovery-test-')));homes.push(home);return {home,host:{userHome:home,now:()=>now}};}
async function database(home:string,optional=true){
 const root=join(home,'.codex');await mkdir(root,{recursive:true});const path=join(root,'state_5.sqlite'),db=new DatabaseSync(path);
 db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,title TEXT,first_user_message TEXT${optional?',tokens_used INTEGER,is_pinned INTEGER':''})`);
 return {db,path,add:(id:string,cwd:string,options:{time?:number;archived?:number;source?:string;tokens?:number;pin?:number}={})=>db.prepare(`INSERT INTO threads VALUES(${Array(optional?10:8).fill('?').join(',')})`).run(id,cwd,options.time??recent,options.time??recent,options.archived??0,options.source??'cli','PRIVATE TITLE','PRIVATE MESSAGE',...(optional?[options.tokens??42,options.pin??0]:[]))};
}
async function session(home:string,name:string,cwd:string,options:{first?:boolean;time?:string;prefix?:string}={}){
 const root=join(home,'.omp/agent/sessions/bucket');await mkdir(root,{recursive:true});const path=join(root,name+'.jsonl');
 const header=JSON.stringify({type:'session',id:name,cwd,timestamp:options.time??new Date(recent*1000).toISOString()});
 await writeFile(path,(options.prefix??(options.first?'':JSON.stringify({type:'title',title:'PRIVATE TITLE',updatedAt:options.time??new Date(recent*1000).toISOString()})+'\n'))+header+'\n'+JSON.stringify({type:'message',content:'PRIVATE MESSAGE',tokens:999})+'\n');return path;
}

it('uses explicit runtimes exclusively, otherwise only registered runtimes',async()=>{
 const {host}=await fixture();
 expect((await discoverWorkDirectories({runtimes:['omp']},{runtimes:['codex']},host)).selection).toEqual({basis:'user_selected',runtimes:['codex']});
 expect((await discoverWorkDirectories({runtimes:['omp']},{},host)).selection).toEqual({basis:'registered_runtimes',runtimes:['omp']});
 const empty=await discoverWorkDirectories({}, {},host);
 expect(empty.selection.runtimes).toEqual([]);expect(empty.sources).toEqual([]);
 expect(JSON.stringify(empty)).not.toMatch(/\b(?:codex|omp)\b/i);
});
it.each([null,[],{runtimes:['unknown']},{runtimes:'codex'},{limit:0},{limit:101},{limit:1.5},{limit:'2'},{includePaths:['relative']},{excludePaths:['/bad\npath']},{includePaths:Array(101).fill('/a')},{includePaths:['/'+ 'a'.repeat(4096)]},{codexHome:'/x'},{unexpected:true}])('rejects invalid input before host IO: %j',async input=>{
 const host={get userHome():string{throw new Error('unexpected host access');}};
 await expect(discoverWorkDirectories({},input as WorkDiscoveryInput,host)).rejects.toThrow('invalid_work_discovery_input');
});
it('accepts the full runtime catalog in registered and explicit selections',async()=>{
 const {host}=await fixture(),runtimes=[...runtimeIds];
 for(const input of [{},{runtimes}]){
  const result=await discoverWorkDirectories({runtimes},input,host);
  expect(result.selection.runtimes).toEqual(runtimes);
  expect(result.sources.map(source=>source.runtime)).toEqual(runtimes);
 }
});
it('allows manual paths without native registration or history access',async()=>{
 const {home,host}=await fixture(),project=join(home,'project');await mkdir(project);
 const db=await database(home);db.add('unselected',join(home,'private'));db.db.close();
 for(const input of [{includePaths:[project]},{runtimes:[],includePaths:[project]}]){
  const result=await discoverWorkDirectories({runtimes:[]},input,host);
  expect(result.sources).toEqual([]);expect(result.candidates.map(c=>c.directory)).toEqual([project]);
 }
});
it('reports unsupported adapters and missing sources without making native files',async()=>{
 const {home,host}=await fixture();const result=await discoverWorkDirectories({runtimes:['codex','omp','claude','gemini','opencode']},{},host);
 expect(result.sources.map(s=>s.status)).toEqual(['missing','missing','unsupported','unsupported','unsupported']);expect(await readdir(home)).toEqual([]);
});
it('deduplicates normalized paths, ignores home/root/internal directories, and marks missing directories',async()=>{
 const {home,host}=await fixture(),project=join(home,'project');await mkdir(project);await symlink(project,join(home,'alias'));
 const result=await discoverWorkDirectories({runtimes:['claude']},{includePaths:[project+'/',join(home,'alias'),join(home,'absent'),home,'/',join(home,'.mandala/workspaces/mandala'),join(tmpdir(),'mana-system-internal')]},host);
 expect(result.candidates).toHaveLength(2);expect(result.candidates.find(c=>c.directory===project)).toMatchObject({exists:true,provenance:['manual'],runtimes:[]});expect(result.candidates.find(c=>c.directory.endsWith('/absent'))?.exists).toBe(false);
});
it('combines Codex and OMP metadata with exact metric provenance and never leaks content',async()=>{
 const {home,host}=await fixture(),cwd=join(home,'project');await mkdir(cwd);const db=await database(home);db.add('one',cwd,{pin:1});db.add('two',cwd,{tokens:8});db.add('archived',cwd,{archived:1});db.add('child',cwd,{source:'{"subagent":{"thread_spawn":{}}}'});db.add('old',cwd,{time:recent-91*86400});db.db.close();
 const path=await session(home,'omp',cwd),before=await readFile(path),dbBefore=await readFile(db.path),names=await readdir(join(home,'.codex'));
 const result=await discoverWorkDirectories({runtimes:['codex','omp']}, {},host);expect(result.candidates).toHaveLength(1);
 expect(result.candidates[0]).toMatchObject({directory:cwd,repositoryRoot:null,exists:true,provenance:['codex_sqlite','omp_session_header'],runtimes:[{runtime:'codex',sessionCount:2,tokenCount:50,pinned:true,activitySource:'thread_updated_at'},{runtime:'omp',sessionCount:1,tokenCount:null,pinned:null,activitySource:'session_header'}]});
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|first_user_message|rollout_path/);expect(await readFile(path)).toEqual(before);expect(await readFile(db.path)).toEqual(dbBefore);expect(await readdir(join(home,'.codex'))).toEqual(names);
});
it('handles missing optional columns and incompatible/corrupt SQLite schemas explicitly',async()=>{
 const {home,host}=await fixture(),db=await database(home,false);db.add('one',join(home,'project'));db.db.close();
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).candidates[0].runtimes[0]).toMatchObject({tokenCount:null,pinned:null});
 const wrong=new DatabaseSync(join(home,'.codex/state_6.sqlite'));wrong.exec('CREATE TABLE unrelated(secret TEXT)');wrong.close();
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0].status).toBe('unsupported');
 await writeFile(join(home,'.codex/state_7.sqlite'),'not sqlite PRIVATE');expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0]).toMatchObject({status:'unavailable'});
});
it('uses trusted custom roots, isolates fixture HOME from actual env overrides and rejects relative layouts',async()=>{
 const {home,host}=await fixture(),other=await fixture();vi.stubEnv('CODEX_HOME',join(other.home,'.codex'));const db=await database(other.home);db.add('one',join(home,'project'));db.db.close();
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0].status).toBe('missing');
 expect((await discoverWorkDirectories({runtimes:['codex']},{},{...host,codexHome:join(other.home,'.codex')})).candidates).toHaveLength(1);
 expect((await discoverWorkDirectories({runtimes:['codex']},{},{...host,codexHome:'relative'})).sources[0].status).toBe('unsupported');
});
it('honors trusted native environment roots and reports unsupported profile selection',async()=>{
 const {home}=await fixture(),native=await fixture(),db=await database(native.home);db.add('one',join(home,'project'));db.db.close();await session(native.home,'one',join(home,'project'));
 vi.stubEnv('HOME',home);vi.stubEnv('CODEX_HOME',join(native.home,'.codex'));vi.stubEnv('PI_CODING_AGENT_DIR',join(native.home,'.omp/agent'));
 expect((await discoverWorkDirectories({runtimes:['codex','omp']}, {},{now:()=>now})).candidates[0].runtimes.map(metric=>metric.runtime)).toEqual(['codex','omp']);
 vi.stubEnv('PI_CODING_AGENT_DIR','');vi.stubEnv('OMP_PROFILE','custom-profile');
 expect((await discoverWorkDirectories({runtimes:['omp']},{},{now:()=>now})).sources[0]).toMatchObject({status:'unsupported',reason:'omp_profile_layout_unsupported'});
});
it('skips malformed/oversized OMP headers and symlink traversal without losing valid siblings',async()=>{
 const {home,host}=await fixture(),cwd=join(home,'project');await session(home,'good',cwd,{first:true});await session(home,'bad',cwd,{prefix:'bad json\n'});await session(home,'huge',cwd,{prefix:JSON.stringify({type:'title',title:'x'.repeat(65536)})+'\n'});
 const outside=join(home,'outside');await mkdir(outside);await writeFile(join(outside,'secret.jsonl'),JSON.stringify({type:'session',id:'secret',cwd:join(home,'outside-project'),timestamp:now.toISOString()})+'\n');await symlink(outside,join(home,'.omp/agent/sessions/linked'));await symlink(join(outside,'secret.jsonl'),join(home,'.omp/agent/sessions/bucket/linked.jsonl'));
 const result=await discoverWorkDirectories({runtimes:['omp']},{},host);expect(result.candidates).toHaveLength(1);expect(result.sources[0].skipped).toBeGreaterThanOrEqual(3);expect(result.sources[0].truncated).toBe(true);
});
it('uses OMP header activity, never file mtime, and does not count messages',async()=>{
 const {home,host}=await fixture(),cwd=join(home,'project');await session(home,'old',cwd,{time:'2020-01-01T00:00:00.000Z'});await session(home,'current',cwd);const result=await discoverWorkDirectories({runtimes:['omp']},{},host);expect(result.candidates[0].runtimes[0].sessionCount).toBe(1);expect(result.candidates[0].lastActivity).toBe(new Date(recent*1000).toISOString());
});
it('reports unsupported OMP header layouts and unexpected flat session files',async()=>{
 const {home,host}=await fixture(),bucket=join(home,'.omp/agent/sessions/bucket');await mkdir(bucket,{recursive:true});await writeFile(join(bucket,'unknown.jsonl'),'{"type":"unknown","secret":"PRIVATE"}\n');
 expect((await discoverWorkDirectories({runtimes:['omp']},{},host)).sources[0]).toMatchObject({status:'unsupported',reason:'omp_header_layout_unsupported'});
 await rm(bucket,{recursive:true});await writeFile(join(home,'.omp/agent/sessions/flat.jsonl'),'{}\n');
 expect((await discoverWorkDirectories({runtimes:['omp']},{},host)).sources[0]).toMatchObject({status:'unsupported',reason:'omp_session_layout_unsupported'});
});
it('treats empty OMP files as malformed without falsely claiming limit truncation',async()=>{
 const {home,host}=await fixture(),bucket=join(home,'.omp/agent/sessions/bucket');await mkdir(bucket,{recursive:true});await writeFile(join(bucket,'empty.jsonl'),'');
 expect((await discoverWorkDirectories({runtimes:['omp']},{},host)).sources[0]).toMatchObject({status:'unsupported',scanned:1,skipped:1,truncated:false});
});
it('ignores identifiable parent/subagent Codex rows and handles millisecond timestamps',async()=>{
 const {home,host}=await fixture(),db=await database(home),cwd=join(home,'project');db.db.exec('ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER; ALTER TABLE threads ADD COLUMN attached_thread_parent_id TEXT');
 db.db.prepare('INSERT INTO threads(id,cwd,updated_at_ms,source) VALUES(?,?,?,?)').run('one',cwd,recent*1000,'cli');
 db.db.prepare('INSERT INTO threads(id,cwd,updated_at_ms,attached_thread_parent_id) VALUES(?,?,?,?)').run('child',cwd,recent*1000,'one');db.db.close();
 const result=await discoverWorkDirectories({runtimes:['codex']},{},host);expect(result.candidates[0].runtimes[0]).toMatchObject({sessionCount:1,lastActivity:new Date(recent*1000).toISOString()});
});
it('leaves SQLite WAL metadata unchanged while including committed live WAL rows',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.db.exec('PRAGMA journal_mode=WAL');db.add('wal-row',join(home,'project'));
 const root=join(home,'.codex'),names=await readdir(root),before=await Promise.all(names.map(name=>readFile(join(root,name))));
 try{expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).candidates[0].runtimes[0].sessionCount).toBe(1);expect(await readdir(root)).toEqual(names);expect(await Promise.all(names.map(name=>readFile(join(root,name))))).toEqual(before);}finally{db.db.close();}
});
it('does not create sidecars when reading a closed WAL-mode SQLite database',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.db.exec('PRAGMA journal_mode=WAL');db.add('one',join(home,'project'));db.db.close();
 const before=await readdir(join(home,'.codex'));expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).candidates).toHaveLength(1);expect(await readdir(join(home,'.codex'))).toEqual(before);
});
it('rejects a live rollback journal after uncommitted pages spill without changing native files',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=10; BEGIN');
 for(let i=0;i<4000;i++)db.add(String(i),join(home,'project'),{tokens:1});db.db.exec('COMMIT');
 const committed=await readFile(db.path);db.db.exec('BEGIN; UPDATE threads SET tokens_used=99999');
 try {
  const root=join(home,'.codex'),names=await readdir(root),before=await Promise.all(names.map(name=>readFile(join(root,name))));
  expect(names).toContain('state_5.sqlite-journal');expect(await readFile(db.path)).not.toEqual(committed);
  const result=await discoverWorkDirectories({runtimes:['codex']},{},host);
  expect(result.sources[0]).toMatchObject({status:'unavailable',reason:'native_rollback_journal_present',scanned:0});expect(result.candidates).toEqual([]);
  expect(await readdir(root)).toEqual(names);expect(await Promise.all(names.map(name=>readFile(join(root,name))))).toEqual(before);
 }finally{db.db.exec('ROLLBACK');expect(db.db.prepare('SELECT COUNT(*) AS count FROM threads WHERE tokens_used=1').get()?.count).toBe(4000);db.db.close();}
});
it('conservatively rejects an existing persistent rollback journal',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.add('one',join(home,'project'));db.db.close();await writeFile(db.path+'-journal','');
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0]).toMatchObject({status:'unavailable',reason:'native_rollback_journal_present'});
});
it('bounds SQLite snapshot bytes and refuses linked native database/WAL files',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.db.close();const handle=await open(db.path,'r+');await handle.truncate(128*1024*1024+1);await handle.close();
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0]).toMatchObject({status:'unavailable',reason:'native_snapshot_size_limit'});
 await rm(db.path);await symlink(join(home,'outside'),db.path);expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0]).toMatchObject({status:'unsupported',reason:'codex_database_link_or_layout'});
 await rm(db.path);const second=await database(home);second.db.close();await symlink(join(home,'outside'),db.path+'-wal');
 expect((await discoverWorkDirectories({runtimes:['codex']},{},host)).sources[0].status).toBe('unavailable');
});
it('removes private SQLite snapshots after successful and failed queries',async()=>{
 const snapshots=async()=>(await readdir(tmpdir())).filter(name=>name.startsWith('mandala-work-discovery-')).sort(),before=await snapshots(),{home,host}=await fixture(),db=await database(home);db.add('one',join(home,'project'));db.db.close();
 await discoverWorkDirectories({runtimes:['codex']},{},host);expect(await snapshots()).toEqual(before);
 await writeFile(db.path,'corrupt database');await discoverWorkDirectories({runtimes:['codex']},{},host);expect(await snapshots()).toEqual(before);
});
it('groups actual linked git worktrees and preserves observed workspace paths',async()=>{
 const {home,host}=await fixture(),repo=join(home,'repo'),linked=join(home,'linked');await mkdir(repo);execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial']);execFileSync('git',['-C',repo,'worktree','add','-qb','linked',linked]);await mkdir(join(linked,'subdir'));
 const result=await discoverWorkDirectories({runtimes:['claude']},{includePaths:[repo,linked,join(linked,'subdir')]},host);
 expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({directory:repo,repositoryRoot:repo,workspacePaths:[linked,join(linked,'subdir'),repo]});
});
it('applies canonical subtree exclusions before grouping without substring matches',async()=>{
 const {home,host}=await fixture(),excluded=join(home,'project'),kept=join(home,'project-other');await mkdir(excluded);await symlink(excluded,join(home,'alias'));
 const result=await discoverWorkDirectories({runtimes:['claude']},{includePaths:[join(home,'alias/sub'),excluded,kept],excludePaths:[excluded]},host);expect(result.candidates.map(c=>c.directory)).toEqual([kept]);
});
it('bounds result candidates and discloses truncation deterministically',async()=>{
 const {home,host}=await fixture();const input={includePaths:Array.from({length:60},(_,i)=>join(home,`p${String(i).padStart(2,'0')}`))};const result=await discoverWorkDirectories({runtimes:['claude']},input,host);
 expect(result.candidates).toHaveLength(50);expect(result.notices.join(' ')).toContain('candidate_limit');expect((await discoverWorkDirectories({runtimes:['claude']},input,host))).toEqual(result);
});
it('bounds Codex rows and OMP files and reports partial inventories',async()=>{
 const {home,host}=await fixture(),db=await database(home);db.db.exec('BEGIN');for(let i=0;i<10002;i++)db.add(String(i),join(home,'project'));db.db.exec('COMMIT');db.db.close();
 const bucket=join(home,'.omp/agent/sessions/bucket');await mkdir(bucket,{recursive:true});const header=JSON.stringify({type:'session',id:'fixture',cwd:join(home,'project'),timestamp:now.toISOString()})+'\n';
 for(let i=0;i<2002;i++)await writeFile(join(bucket,`${i}.jsonl`),header);
 const result=await discoverWorkDirectories({runtimes:['codex','omp']}, {},host);expect(result.sources).toMatchObject([{scanned:10000,truncated:true},{scanned:2000,truncated:true}]);expect(result.notices.join(' ')).toContain('source_limit');
});
