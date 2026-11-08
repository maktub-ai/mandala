import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sshArgs, shellQuote} from '../server/ssh-transport';
import {SshService} from '../server/ssh-service';
import {runtimeIds} from '../shared/runtimes';
import type {CodexOptions} from '../server/codex';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(factory?:any){const home=await mkdtemp(join(tmpdir(),'mandala-ssh-'));roots.push(home);return {home,service:new SshService(home,join(home,'mandala.mjs'),factory)};}
const request=(service:SshService,id:string,method:string,params:any={})=>service.request({id,method,params});

describe('SSH execution',()=>{
 it('uses noninteractive strict OpenSSH and rejects option/shell injection',()=>{
  expect(sshArgs('user@build-host', 'node test')).toEqual(['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','--','user@build-host','node test']);
  for(const host of ['-oProxyCommand=id','host;id','host\nwhoami','a b','host/path'])expect(()=>sshArgs(host,'x')).toThrow();
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
 });
 it('deduplicates uncertain concurrent starts and dispatches every registered adapter',async()=>{
  const clients:any[]=[];const factory=vi.fn(async(cli:string,options:CodexOptions)=>{const client={close:vi.fn(),getStatus:async()=>({status:'ready'})};clients.push(client);return client;});
  const {service}=await fixture(factory);
  for(const cli of runtimeIds){const id='start-'+cli;const params={runtimeId:cli,cli,options:{cwd:'/tmp'}};await Promise.all([request(service,id,'runtime.start',params),request(service,id,'runtime.start',params)]);}
  expect(factory.mock.calls.map(call=>call[0])).toEqual([...runtimeIds]);
  expect(clients).toHaveLength(14);
  await expect(request(service,'start-codex','runtime.start',{runtimeId:'different',cli:'codex',options:{cwd:'/tmp'}})).rejects.toThrow(/reused/);
  await service.shutdown();
 });
 it('retains event identity and pending approvals while the transport is absent',async()=>{
  let options:CodexOptions;const close=vi.fn();const {service}=await fixture(async(_:string,value:CodexOptions)=>{options=value;return {close,replyApproval:vi.fn()};});
  await request(service,'start','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp'}});
  options!.onEvent({method:'turn/started',params:{turnId:'turn-1'}});options!.onApproval({id:7,method:'approval',params:{}});
  const first=service.eventsAfter(0);expect(first.map(event=>event.kind)).toEqual(['event','approval']);expect(service.eventsAfter(0)).toEqual(first);
  expect(close).not.toHaveBeenCalled();
  await request(service,'approve','runtime.call',{runtimeId:'r',method:'replyApproval',args:[7,{approved:true}]});
  expect(service.pendingApprovals()).toEqual([]);
  await service.shutdown();
 });
 it('rejects traversal, symlinks and oversized transfer payloads',async()=>{
  const {service,home}=await fixture();await mkdir(join(home,'outputs','inv'),{recursive:true});await writeFile(join(home,'secret'),'private');await symlink(join(home,'secret'),join(home,'outputs','inv','link'));
  await expect(request(service,'bad','output.read',{invocationId:'inv',path:'../secret'})).rejects.toThrow();
  await expect(request(service,'link','output.read',{invocationId:'inv',path:'link'})).rejects.toThrow();
  await expect(request(service,'large','attachment.write',{id:'a',name:'file',data:'a'.repeat(32*1024*1024)})).rejects.toThrow(/large/i);
  const path=await request(service,'good','attachment.write',{id:'a',name:'hello.txt',data:Buffer.from('hello').toString('base64')});expect(await readFile(path as string,'utf8')).toBe('hello');
  await service.shutdown();
 });
 it('bridges business mailbox calls and does not dispose on transport detach',async()=>{
  const {service}=await fixture();const runtime:any=await request(service,'business','business.prepare',{invocationId:'inv'});
  const mailbox=runtime.mailboxPath;const call='12345678-1234-1234-1234-123456789abc';await writeFile(join(mailbox,call+'.request'),JSON.stringify({command:'memory search',args:{query:'x'},commandKey:'key'}),{mode:0o600});
  await vi.waitFor(()=>expect(service.eventsAfter(0).some(event=>event.kind==='business')).toBe(true));
  const event=service.eventsAfter(0).find(event=>event.kind==='business')!;
  await request(service,'result','business.reply',{callId:(event.payload as any).callId,result:{records:[]}});
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(mailbox,call+'.response'),'utf8'))).toEqual({ok:true,data:{records:[]}}));
  await service.shutdown();
 });
});

import {createSshExecution} from '../server/ssh-execution';
import {skillResources} from '../shared/skills';
import * as codexAdapter from '../server/codex';
import * as ompAdapter from '../server/omp';
import * as nativeAdapter from '../server/native-runtime';
import {startSshRuntime} from '../server/ssh-service';

it('routes actual adapter factory across every runtime',async()=>{
 const fake={} as any;const codex=vi.spyOn(codexAdapter,'startCodex').mockResolvedValue(fake),omp=vi.spyOn(ompAdapter,'startOmp').mockResolvedValue(fake),native=vi.spyOn(nativeAdapter,'startNativeRuntime').mockResolvedValue(fake);
 try{for(const id of runtimeIds)await startSshRuntime(id,{} as any);expect(codex).toHaveBeenCalledTimes(1);expect(omp).toHaveBeenCalledTimes(1);expect(native.mock.calls.map(call=>call[0])).toEqual(runtimeIds.filter(id=>id!=='codex'&&id!=='omp'));}finally{codex.mockRestore();omp.mockRestore();native.mockRestore();}
});
it('serializes Skill resources and leaves runtime env references remote',async()=>{
 const {home}=await fixture();await writeFile(join(home,'resource'),'data');const request=vi.fn(async()=>'/remote/runtime');const connection={request,close:vi.fn()};const execution=createSshExecution(connection as any,'conversation');
 await execution.prepareCapabilities('conversation',[],[{name:'example',path:'/local/path',content:'Skill content',[skillResources]:[{path:'scripts/tool.sh',blobPath:join(home,'resource'),executable:true}]}],'instructions');
 const payload=request.mock.calls[0] as any;expect(JSON.stringify(payload)).not.toContain(home);expect(payload[1].skills[0].resources).toEqual([{path:'scripts/tool.sh',data:Buffer.from('data').toString('base64'),executable:true}]);
 const callbacks={cwd:'/remote/work',onEvent:vi.fn(),onApproval:vi.fn(),onExit:vi.fn()};
 await expect(execution.start('codex',{...callbacks,env:{SECRET:'do-not-send'}})).rejects.toThrow(/Local runtime environment/);expect(JSON.stringify(request.mock.calls)).not.toContain('do-not-send');
});
it('proxy close detaches and business duplicates execute the local callback once',async()=>{
 const {service}=await fixture(async()=>({getStatus:async()=>({status:'ready'}),close:vi.fn()}) as any);const connection:any={request:vi.fn((method:string,params:any)=>request(service,Math.random().toString(),method,params)),close:vi.fn()};service.on('event',event=>connection.onEvent?.(event));
 const execution=createSshExecution(connection,'conversation'),invoke=vi.fn(async()=>({records:[]}));await execution.prepareBusiness('inv',invoke);
 const event:any={sequence:1,kind:'business',payload:{callId:'test',invocationId:'inv',data:{command:'memory search',args:{},commandKey:'key'}}};connection.onEvent(event);connection.onEvent(event);await vi.waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
 const client=await execution.start('codex',{cwd:'/tmp',onEvent:vi.fn(),onApproval:vi.fn(),onExit:vi.fn()});await client.close();expect(connection.close).toHaveBeenCalledOnce();expect(connection.request.mock.calls.some((call:any)=>call[0]==='runtime.close')).toBe(false);await service.shutdown();
});
it('cannot replace a running runtime and refreshes idle runtime options',async()=>{
 let options:CodexOptions;const close=vi.fn();const factory=vi.fn(async(_:string,value:CodexOptions)=>{options=value;return {startTurn:async()=> 'turn',close};});const {service}=await fixture(factory);
 await request(service,'one','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp',model:'one'}});
 await request(service,'two','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp',model:'two'}});expect(close).toHaveBeenCalledOnce();
 await request(service,'turn','runtime.call',{runtimeId:'r',method:'startTurn',args:['thread','hello']});
 await expect(request(service,'three','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp',model:'three'}})).rejects.toThrow(/active/);
 options!.onEvent({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
 await request(service,'four','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp',model:'three'}});expect(factory).toHaveBeenCalledTimes(3);await service.shutdown();
});
it('uploads the same attachment idempotently and rejects a changed payload',async()=>{
 const {service}=await fixture(),params={id:'a',name:'file.txt',data:Buffer.from('same').toString('base64')};const first=await request(service,'one','attachment.write',params);expect(await request(service,'two','attachment.write',params)).toBe(first);await expect(request(service,'three','attachment.write',{...params,data:Buffer.from('different').toString('base64')})).rejects.toThrow();await service.shutdown();
});
it('rejects symlinks replacing the invocation output root or its parent',async()=>{
 const {service,home}=await fixture();await mkdir(join(home,'outputs'));await mkdir(join(home,'private'));await writeFile(join(home,'private','secret'),'private-content');await symlink(join(home,'private'),join(home,'outputs','inv'));
 await expect(request(service,'root-link','output.read',{invocationId:'inv',path:'secret'})).rejects.toThrow(/Symlink/);await rm(join(home,'outputs'),{recursive:true});await mkdir(join(home,'private','inv'));await writeFile(join(home,'private','inv','secret'),'private-content');await symlink(join(home,'private'),join(home,'outputs'));
 await expect(request(service,'parent-link','output.read',{invocationId:'inv',path:'secret'})).rejects.toThrow(/Symlink/);await service.shutdown();
});
it('attaches for recovery without changing active settings or spawning absent runtimes',async()=>{
 const factory=vi.fn(async()=>({startTurn:async()=> 'turn',close:vi.fn(),inspectInvocation:async()=> 'running'}));const {service}=await fixture(factory);
 await expect(request(service,'missing','runtime.start',{runtimeId:'absent',cli:'omp',options:{},attachOnly:true})).rejects.toThrow(/unknown/);expect(factory).not.toHaveBeenCalled();
 await request(service,'start','runtime.start',{runtimeId:'r',cli:'omp',options:{cwd:'/tmp',pluginDir:'/remote/plugin'}});await request(service,'turn','runtime.call',{runtimeId:'r',method:'startTurn',args:[]});await request(service,'attach','runtime.start',{runtimeId:'r',cli:'omp',options:{cwd:'/tmp'},attachOnly:true});expect(factory).toHaveBeenCalledOnce();await service.shutdown();
});
it('admits fresh subscriptions after the history ring fills and preserves pending approvals',async()=>{
 let options:CodexOptions;const {service}=await fixture(async(_:string,value:CodexOptions)=>{options=value;return {close(){}};});await request(service,'start','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp'}});options!.onApproval({id:11,method:'approval',params:{}});for(let i=0;i<20005;i++)options!.onEvent({method:'item/agentMessage/delta',params:{delta:'x'}});
 expect(()=>service.eventsAfter(0)).toThrow(/expired/);expect(service.eventsAfter(undefined,'new-conversation')).toEqual([]);const replay=service.eventsAfter(undefined,'r');expect(replay.some(event=>event.kind==='approval'&&event.payload.id===11)).toBe(true);expect(replay.at(-1)?.sequence).toBe(service.currentSequence());await service.shutdown();
});
it('fresh subscription does not replay a retired native process exit into a new invocation',async()=>{
 let options:CodexOptions;const {service}=await fixture(async(_:string,value:CodexOptions)=>{options=value;return {close(){}};});await request(service,'old','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp'}});options!.onExit('old failure');expect(service.eventsAfter(undefined,'r')).toEqual([]);await request(service,'new','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp'}});expect(service.eventsAfter(undefined,'r')).toEqual([]);await service.shutdown();
});
it('releases metadata-only clients on proxy close but cannot release an active turn',async()=>{
 const close=vi.fn(),{service}=await fixture(async()=>({getStatus:async()=>({status:'ready'}),startTurn:async()=> 'turn',close}));const connection:any={request:(method:string,params:any)=>request(service,Math.random().toString(),method,params),close:vi.fn()};const execution=createSshExecution(connection,'catalog-one');const client=await execution.start('codex',{cwd:'/tmp',onEvent(){},onApproval(){},onExit(){}});await client.close();expect(close).toHaveBeenCalledOnce();await request(service,'start','runtime.start',{runtimeId:'r',cli:'codex',options:{cwd:'/tmp'}});await request(service,'turn','runtime.call',{runtimeId:'r',method:'startTurn',args:[]});expect(await request(service,'release','runtime.release',{runtimeId:'r'})).toBe(false);expect(close).toHaveBeenCalledOnce();await service.shutdown();
});
it('expires detached idle clients while preserving attached clients and active execution',async()=>{
 const closes=new Map<string,ReturnType<typeof vi.fn>>(),{service}=await fixture(async(_:string,options:CodexOptions)=>{const close=vi.fn();closes.set(options.cwd,close);return {close,startTurn:async()=> 'turn'};});
 for(const id of ['idle','attached','busy'])await request(service,id,'runtime.start',{runtimeId:id,cli:'codex',options:{cwd:id}});const detach=service.subscribe('attached');await request(service,'turn','runtime.call',{runtimeId:'busy',method:'startTurn',args:[]});await service.sweepIdle(Date.now()+1000000);expect(closes.get('idle')).toHaveBeenCalledOnce();expect(closes.get('attached')).not.toHaveBeenCalled();expect(closes.get('busy')).not.toHaveBeenCalled();detach();await service.shutdown();
});
