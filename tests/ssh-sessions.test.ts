import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openStore, type Store } from '../server/store';
import { createSessionManager, type SessionManager } from '../server/sessions';
import type { Config } from '../shared/types';
import { runtimeIds } from '../shared/runtimes';
import type { CodexOptions, CodexClient } from '../server/codex';

const mocked = vi.hoisted(() => ({ connect: vi.fn(), inspect: undefined as undefined | ((identity:any,id:string)=>Promise<unknown>) }));
vi.mock('../server/ssh-execution', () => ({ connectSshExecution: mocked.connect }));
vi.mock('../server/task-monitor',async original=>{const actual=await original<typeof import('../server/task-monitor')>();return {...actual,createTaskMonitor:(options:Parameters<typeof actual.createTaskMonitor>[0])=>{mocked.inspect=options.inspect;return actual.createTaskMonitor(options);}};});

let home: string, store: Store, manager: SessionManager, config: Config;
let callbacks: CodexOptions, native: CodexClient, remote: any, localFactory: (options:CodexOptions)=>Promise<CodexClient>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ssh-sessions-'));
  store = openStore(home);
  config = { version: 2, executionMachines: [{ id: 'dev', name: 'Dev', host: 'dev-server' }], agents: [{ id: 'a', name: 'Agent', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }], projects: [{ id: 'p', name: 'Project', cwd: '/srv/mandala-ssh-fixture', agentIds: ['a'], mcp: [], skills: [], resources: [], workspaces: [{ id: 'remote', name: 'Server', cwd: '/srv/mandala-ssh-fixture', machineId: 'dev', resources: [] }] }] };
  native = { getStatus: async()=>({status:'ready',version:'fixture'}), listModels: async()=>[{id:'remote-model',label:'Remote model'}], startThread: vi.fn(async()=> 'remote-native'), resumeThread: vi.fn(async()=>{}), startTurn: vi.fn(async()=>{callbacks.onEvent({method:'turn/started',params:{threadId:'remote-native',turn:{id:'remote-turn'}}});return 'remote-turn';}), interrupt: vi.fn(async()=>{callbacks.onEvent({method:'turn/completed',params:{threadId:'remote-native',turn:{id:'remote-turn',status:'interrupted'}}});}), replyApproval: vi.fn(), close: vi.fn() };
  remote = { request: vi.fn(async(_method:string,p:any)=>({isDirectory:true,realpath:p.path})), start: vi.fn(async(_cli:string,options:CodexOptions)=>{callbacks=options;return native;}), prepareBusiness:vi.fn(async(id:string)=>({launcher:'/remote/runtime/mandala',contextFile:'/remote/runtime/context.json',command:"'/remote/runtime/mandala'",mailboxPath:'/remote/runtime/mailbox',outputRoot:'/remote/outputs/'+id,dispose:vi.fn()})), prepareCapabilities:vi.fn(async()=>'/remote/capabilities'), uploadAttachment:vi.fn(async(_path:string,id:string)=>'/remote/attachments/'+id), downloadOutput:vi.fn(), close:vi.fn() };
  mocked.connect.mockReset().mockResolvedValue(remote);
  localFactory=vi.fn(async()=>{throw new Error('A remote workspace must never launch a local CLI');});
  manager = createSessionManager(store, async () => config, localFactory, localFactory, home);
});
afterEach(async () => { await manager.close(); store.close(); rmSync(home, { recursive: true, force: true }); });

test('creating a remote conversation snapshots its target without accessing the local remote path', async () => {
  const chat = await manager.create('p', 'a', undefined, 'codex', { workspaceId: 'remote' });
  expect(chat.executionLocation).toEqual({ machineId: 'dev', machineName: 'Dev', host: 'dev-server', cwd: '/srv/mandala-ssh-fixture' });
  config.executionMachines![0].host = 'replacement';
  config.projects[0].workspaces![0].cwd = '/srv/moved';
  expect(store.getConversation(chat.id)?.executionLocation).toEqual({ machineId: 'dev', machineName: 'Dev', host: 'dev-server', cwd: '/srv/mandala-ssh-fixture' });
});

test('a local unbound conversation preserves legacy local execution', async () => {
  const chat = await manager.create('', '', undefined, 'codex', { cwd: home });
  expect(chat.executionLocation).toBeUndefined();
  expect(chat.cwd).toBe(home);
});

test.each(runtimeIds)('the shared SSH path loads %s status/models without invoking a local adapter', async cli => {
  expect(await manager.getCliStatus('p',cli,{workspaceId:'remote',agentId:'a'})).toMatchObject({status:'ready'});
  expect(await manager.listModels('p',cli,{workspaceId:'remote',agentId:'a'})).toEqual([{id:'remote-model',label:'Remote model'}]);
  expect(remote.start).toHaveBeenCalledWith(cli,expect.objectContaining({cwd:'/srv/mandala-ssh-fixture'}),expect.anything());
  expect(localFactory).not.toHaveBeenCalled();
});

test('remote execution preserves the original host, uses remote business paths, and confirms interrupt', async () => {
  const chat = await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  config.executionMachines![0].host='replacement';
  await manager.send(chat.id,'Inspect the server project');
  expect(mocked.connect).toHaveBeenCalledWith(expect.objectContaining({host:'dev-server'}),expect.objectContaining({conversationId:chat.id}));
  expect(remote.start).toHaveBeenCalled();
  expect(native.startThread).toHaveBeenCalledWith(expect.objectContaining({cwd:'/srv/mandala-ssh-fixture',instructions:expect.stringContaining('/remote/runtime/mandala')}));
  expect(store.getConversation(chat.id)?.nativeId).toBe('remote-native');
  await manager.stop(chat.id);
  expect(native.interrupt).toHaveBeenCalledWith('remote-native','remote-turn');
  expect(store.getConversation(chat.id)?.status).toBe('interrupted');
  expect(store.listEvents(chat.id,0).some(event=>(event.data as any).code==='remote_stop_unconfirmed')).toBe(false);
  expect(localFactory).not.toHaveBeenCalled();
});

test('the first remote turn reports which machine it is connecting to, and a failure is recorded', async () => {
  const chat = await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'Inspect the server project');
  const stages=()=>store.listEvents(chat.id,0).filter(event=>event.kind==='metadata'&&(event.data as any).remoteConnection).map(event=>event.data as any);
  expect(stages().map(stage=>stage.remoteConnection)).toEqual(['connecting','connected']);
  expect(stages()[0]).toMatchObject({machineName:'Dev',host:'dev-server'});
  await manager.stop(chat.id);
  const failing = await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  mocked.connect.mockRejectedValueOnce(new Error('SSH failed (255): Host key verification failed.'));
  await manager.send(failing.id,'Try again').catch(()=>{});
  await vi.waitFor(()=>expect(store.listEvents(failing.id,0).filter(event=>event.kind==='metadata'&&(event.data as any).remoteConnection).map(event=>(event.data as any).remoteConnection)).toEqual(['connecting','failed']));
});

test('the remote business bridge preserves local task scope and expires on stop',async()=>{
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'Use Mandala');
  const invoke=remote.prepareBusiness.mock.calls[0][1];
  expect(await invoke({command:'tasks context',args:{},commandKey:'context'})).toMatchObject({conversationId:chat.id,project:{id:'p'},agent:{id:'a'}});
  await expect(invoke({command:'tasks context',args:{projectId:'forged'},commandKey:'forged'})).rejects.toBeDefined();
  await manager.stop(chat.id);
  await expect(invoke({command:'tasks context',args:{},commandKey:'expired'})).rejects.toBeDefined();
});

test('remote publication transfers only declared relative outputs into the existing local asset publisher',async()=>{
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  remote.downloadOutput.mockImplementation(async(_id:string,_path:string,destination:string)=>{mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,'Remote evidence\n');});
  await manager.send(chat.id,'Publish a report');
  const invoke=remote.prepareBusiness.mock.calls[0][1],invocationId=remote.prepareBusiness.mock.calls[0][0];
  const result=await invoke({command:'assets publish',args:{title:'Remote report',files:[{path:'reports/evidence.txt'}]},commandKey:'publish'});
  expect(result).toMatchObject({asset:{title:'Remote report'},version:{provenance:{runId:invocationId}}});
  const output=join(home,'outputs','conversations',chat.id,invocationId,'reports/evidence.txt');
  expect(remote.downloadOutput).toHaveBeenCalledWith(invocationId,'reports/evidence.txt',output);
  expect(readFileSync(output,'utf8')).toBe('Remote evidence\n');
  await expect(invoke({command:'assets publish',args:{title:'Escape',files:[{path:'../escape'}]},commandKey:'escape'})).rejects.toMatchObject({code:'invalid_artifact_tool'});
  expect(remote.downloadOutput).toHaveBeenCalledTimes(1);
});

test('runtime environment references are sent for remote resolution and never read locally',async()=>{
  config.agents[0].runtime={codex:{env:{REMOTE_SECRET:'${MANDALA_SSH_ONLY_ENV_FIXTURE}'}}};
  delete process.env.MANDALA_SSH_ONLY_ENV_FIXTURE;
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'Use remote configuration');
  expect(remote.start).toHaveBeenCalledWith('codex',expect.objectContaining({cwd:'/srv/mandala-ssh-fixture'}),expect.objectContaining({codex:expect.objectContaining({env:{REMOTE_SECRET:'${MANDALA_SSH_ONLY_ENV_FIXTURE}'}})}));
  expect(callbacks.env).toBeUndefined();
});

test('forking a remote reply uses its native remote adapter and retains the pinned machine',async()=>{
  native.forkThread=vi.fn(async()=> 'remote-fork');
  const source=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(source.id,'Initial request');
  callbacks.onEvent({method:'turn/completed',params:{threadId:'remote-native',turn:{id:'remote-turn',status:'completed'}}});
  config.executionMachines![0].host='replacement';
  const branch=await manager.fork(source.id);
  expect(native.forkThread).toHaveBeenCalledWith('remote-native',expect.any(Array),1,undefined);
  expect(branch.executionLocation).toEqual(source.executionLocation);
  expect(branch.nativeId).toBe('remote-fork');
  expect(localFactory).not.toHaveBeenCalled();
});

test('delegated work and peer inquiries keep the source remote location after config changes',async()=>{
  config.agents.push({...config.agents[0],id:'b',name:'Peer'});
  config.projects[0].agentIds.push('b');
  const source=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(source.id,'Coordinate remote work');
  config.executionMachines![0].host='replacement';
  const task=await manager.createTask(source.id,'b','Investigate remotely');
  expect(store.getConversation(task.targetConversationId)?.executionLocation).toEqual(source.executionLocation);
  const message=await manager.askAgent(source.id,{targetAgentId:'b',text:'Check the server',policy:'notify'},{commandKey:'peer'});
  expect(store.getConversation(message.targetConversationId)?.executionLocation).toEqual(source.executionLocation);
});

test('reloading an idle remote runtime keeps the prepared business and Skill transport connected',async()=>{
  const nativeClose=vi.fn();native.close=nativeClose;
  config.agents[0].skills=[{name:'example',path:'',content:'Use this assigned Skill'}];
  remote.prepareCapabilities.mockImplementation(async()=>{if(nativeClose.mock.calls.length)throw new Error('SSH execution detached');return '/remote/capabilities';});
  remote.request.mockImplementation(async(method:string,p:any)=>method==='runtime.release'?true:{isDirectory:true,realpath:p.path});
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'First turn');
  callbacks.onEvent({method:'turn/completed',params:{threadId:'remote-native',turn:{id:'remote-turn',status:'completed'}}});
  config.agents[0].runtime={codex:{fullAccess:false}};
  await manager.continue(chat.id,'Use the changed permissions');
  expect(nativeClose).not.toHaveBeenCalled();
  expect(remote.request).toHaveBeenCalledWith('runtime.release',{runtimeId:chat.id});
  const invoke=remote.prepareBusiness.mock.calls.at(-1)[1];
  expect(await invoke({command:'tasks context',args:{},commandKey:'after-reload'})).toMatchObject({conversationId:chat.id});
});

test('background inspection uses an independent connection without closing the active runtime transport',async()=>{
  const nativeClose=vi.fn(),inspectionClose=vi.fn();native.close=nativeClose;
  native.inspectInvocation=vi.fn(async()=> 'running' as const);
  const inspection={...remote,start:vi.fn(async()=>({...native,close:inspectionClose})),close:vi.fn()};
  mocked.connect.mockReset().mockResolvedValueOnce(remote).mockResolvedValueOnce(inspection);
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'A long running task');
  const activeCallbacks=callbacks;
  expect(await mocked.inspect!({runId:'run',hostId:'local',nativeSessionId:'remote-native',nativeTurnId:'remote-turn'},chat.id)).toBe('running');
  expect(mocked.connect).toHaveBeenCalledTimes(2);
  expect(inspectionClose).toHaveBeenCalled();
  expect(nativeClose).not.toHaveBeenCalled();
  activeCallbacks.onEvent({method:'turn/completed',params:{threadId:'remote-native',turn:{id:'remote-turn',status:'completed'}}});
  await manager.continue(chat.id,'Next turn');
  expect(mocked.connect).toHaveBeenCalledTimes(2);
});

test('an isolated inspection failure closes its own transport without touching the active connection',async()=>{
  const inspection={...remote,start:vi.fn(async()=>{throw new Error('Remote runtime unavailable');}),close:vi.fn()};
  mocked.connect.mockReset().mockResolvedValueOnce(remote).mockResolvedValueOnce(inspection);
  const chat=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(chat.id,'Keep running');
  expect(await mocked.inspect!({runId:'run',hostId:'local',nativeSessionId:'remote-native',nativeTurnId:'remote-turn'},chat.id)).toBe('unreachable');
  expect(inspection.close).toHaveBeenCalledOnce();
  expect(remote.close).not.toHaveBeenCalled();
});

test('a remote fork releases its separate native writer before the branch resumes',async()=>{
  let held=false;
  native.forkThread=vi.fn(async()=>{held=true;return 'remote-fork';});
  native.resumeThread=vi.fn(async()=>{if(held)throw new Error('active writer');});
  remote.request.mockImplementation(async(method:string,p:any)=>{if(method==='runtime.release'){held=false;return true;}return {isDirectory:true,realpath:p.path};});
  const source=await manager.create('p','a',undefined,'codex',{workspaceId:'remote'});
  await manager.send(source.id,'First request');
  callbacks.onEvent({method:'turn/completed',params:{threadId:'remote-native',turn:{id:'remote-turn',status:'completed'}}});
  const branch=await manager.fork(source.id);
  await manager.send(branch.id,'Continue forked work');
  expect(native.resumeThread).toHaveBeenCalledWith('remote-fork',expect.any(Array),expect.any(String),undefined,expect.any(Array),expect.any(String));
  expect(mocked.connect.mock.calls.some(call=>call[1].conversationId.startsWith('fork-'))).toBe(true);
  expect(held).toBe(false);
});
