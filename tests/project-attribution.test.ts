import {afterEach, beforeEach, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Config, Project} from '../shared/types';
import {backfillConversationProjects, conversationProjectResolver} from '../server/project-attribution';
import {createSessionManager} from '../server/sessions';
import {openStore} from '../server/store';

let root:string;
beforeEach(()=>{ root=mkdtempSync(join(tmpdir(),'attribution-')); });
afterEach(()=>{ rmSync(root,{recursive:true,force:true}); });
function project(id:string,...directories:string[]):Project {
  return {id,name:id,cwd:directories[0],agentIds:[],resources:[],mcp:[],skills:[],
    workspaces:directories.map((cwd,index)=>({id:String(index),name:cwd,cwd,resources:[]}))};
}
const config=(...projects:Project[]):Config=>({version:2,projects,agents:[],runtimes:['codex']});

it('resolves the most specific workspace across an external linked worktree and preserves the unbound execution scope',async()=>{
  const repo=join(root,'code'), nested=join(repo,'module'), linked=join(root,'linked');
  mkdirSync(nested,{recursive:true});
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','base');
  git('worktree','add','--detach',linked,'HEAD'); mkdirSync(join(linked,'module'));
  const c=config(project('whole',join(root,'other'),repo),project('nested',nested));
  const store=openStore(join(root,'home')), manager=createSessionManager(store,async()=>c);
  try {
    const chat=await manager.create('','',undefined,'codex',{cwd:join(linked,'module')});
    expect(store.getConversation(chat.id)).toMatchObject({projectId:'',attributedProjectId:'nested'});
    const bare=join(root,'shared.git'), first=join(root,'primary'), other=join(root,'external');
    git('clone','--bare','.',bare);
    for (const path of [first,other]) execFileSync('git',['--git-dir',bare,'worktree','add','--detach',path,'HEAD'],{stdio:'pipe'});
    expect(await conversationProjectResolver(config(project('bare',first)))({projectId:'',cwd:other})).toBe('bare');
    expect(await conversationProjectResolver(c)({projectId:'whole',cwd:nested})).toBe('whole');
    expect(await conversationProjectResolver(config(...c.projects,project('tie',nested)))({projectId:'',cwd:nested})).toBeUndefined();
    expect(await conversationProjectResolver(c)({projectId:'',cwd:join(nested,'deleted')})).toBeUndefined();
  } finally {await manager.close();store.close();}
});

it('uses remote host and workspace identity without treating the path as local',async()=>{
  mkdirSync(join(root,'code'));
  const remote=project('remote',join(root,'code'));
  remote.workspaces![0].machineId='host-id';
  const c={...config(remote,project('local',join(root,'code'))),executionMachines:[{id:'host-id',name:'Remote',host:'user@host'}]};
  const location={machineId:'host-id',machineName:'Remote',host:'user@host',cwd:join(root,'code')};
  const lookup=conversationProjectResolver(c);
  expect(await lookup({projectId:'',cwd:location.cwd,executionLocation:location})).toBe('remote');
  expect(await lookup({projectId:'',cwd:location.cwd,executionLocation:{...location,host:'old-host'}})).toBeUndefined();
  expect(await lookup({projectId:'',cwd:location.cwd})).toBe('local');
});

it('backfills persisted legacy records idempotently, including archived chats, without changing scope or activity',async()=>{
  const cwd=join(root,'source');mkdirSync(cwd);
  const c=config(project('found',cwd));const store=openStore(join(root,'store'));
  try {
    const chat=store.createConversation({projectId:'',agentId:'',cwd,cli:'codex',model:null});
    const missing=store.createConversation({projectId:'',agentId:'',cwd:join(cwd,'missing'),cli:'codex',model:null});
    store.archiveConversation(chat.id,true);
    const old=store.getConversation(chat.id);
    const explicit=store.createConversation({projectId:'found',attributedProjectId:'stale',agentId:'',cwd,cli:'codex',model:null});
    expect(explicit.attributedProjectId).toBe('found');
    const orphan=store.createConversation({projectId:'removed',agentId:'',cwd,cli:'codex',model:null});
    store.database.prepare("UPDATE conversations SET data=json_remove(data,'$.attributedProjectId') WHERE id=?").run(orphan.id);
    await backfillConversationProjects(store,c);
    expect(store.getConversation(orphan.id)).toMatchObject({projectId:'removed',attributedProjectId:'found'});
    expect(store.getConversation(chat.id)).toEqual({...old,attributedProjectId:'found'});
    const snapshot=store.database.prepare('SELECT data,updated_at FROM conversations ORDER BY id').all();
    await backfillConversationProjects(store,c);
    expect(store.database.prepare('SELECT data,updated_at FROM conversations ORDER BY id').all()).toEqual(snapshot);
    expect(store.getConversation(missing.id)?.attributedProjectId).toBeUndefined();
  } finally {store.close();}
});

it('retries an interrupted migration after the last committed batch',async()=>{
  const cwd=join(root,'source');mkdirSync(cwd);
  const store=openStore(join(root,'store')), c=config(project('known',cwd));
  try {
    const chats=Array.from({length:129},()=>store.createConversation({projectId:'',agentId:'',cwd,cli:'codex',model:null}));
    store.database.exec("CREATE TRIGGER interrupt_backfill BEFORE UPDATE ON conversations WHEN OLD.rowid=129 BEGIN SELECT RAISE(ABORT,'fixture interruption'); END");
    await expect(backfillConversationProjects(store,c)).rejects.toThrow();
    expect(store.getConversation(chats[0].id)?.attributedProjectId).toBe('known');
    expect(store.getConversation(chats[128].id)?.attributedProjectId).toBeUndefined();
    store.database.exec('DROP TRIGGER interrupt_backfill');
    await backfillConversationProjects(store,c);
    expect(store.getConversation(chats[128].id)?.attributedProjectId).toBe('known');
  } finally {store.close();}
});
