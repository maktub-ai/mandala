import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { spawn } from '../server/native-spawn';
import { startLocalCli } from '../server/local-cli';
import {supportsConversationApproval} from '../shared/approvals';
vi.mock('../server/native-spawn',()=>({spawn:vi.fn()}));
const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
const launches:{command:string;args:string[];child:any}[]=[];
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const line=(child:any,event:unknown)=>child.stdout.write(JSON.stringify(event)+'\n');
const end=(child:any,code=0)=>{child.exitCode=code;child.emit('close',code,null);};
beforeEach(()=>{launches.length=0;vi.mocked(spawn).mockImplementation((command,args)=>{
 const child:any=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});
 child.kill=vi.fn((signal:string)=>{if(signal==='SIGKILL'){child.signalCode=signal;child.emit('close',null,signal);}return true;});launches.push({command,args,child});
 const output=args.includes('create-chat')?'cursor-native-1':args.includes('--version')?'1.2.3':args.includes('--list-models')||args[0]==='models'?'auto - Auto (current)\nflash - Flash':undefined;
 if(output)queueMicrotask(()=>{child.stdout.write(output+'\n');end(child);});return child;
});});
async function setup(cli:'cursor'|'antigravity'='cursor'){
 const home=await mkdtemp(join(tmpdir(),'mandala-local-cli-'));directories.push(home);
 const events:any[]=[],approvals:any[]=[];const client=await startLocalCli(cli,{cwd:'/tmp',env:{MANDALA_HOME:home},onEvent:e=>events.push(e),onApproval:a=>approvals.push(a),onExit(){}});
 const id=await client.startThread({cwd:'/tmp',instructions:'Current host instructions',model:'selected-model'});return {client,id,events,approvals,home};
}
it('rejects tools-disabled execution and unmanaged arguments without spawning',async()=>{
 const options={cwd:'/tmp',onEvent(){},onApproval(){},onExit(){}};
 await expect(startLocalCli('cursor',{...options,safeSystem:true})).rejects.toThrow(/tools.*disabled|disable.*tools/i);
 await expect(startLocalCli('antigravity',{...options,extraArgs:['--remote-control']})).rejects.toThrow(/arguments/i);expect(launches).toHaveLength(0);
});
it('does not turn an entire-turn execution grant into a conversation-wide permission',()=>{
 expect(supportsConversationApproval({method:'acp/permission',params:{wholeTurnApproval:true,options:[{kind:'allow_once',optionId:'allow'}]}} as any)).toBe(false);
});
it('can retry an Antigravity first turn after denial and client retirement',async()=>{
 const {client,id,approvals,home}=await setup('antigravity');await client.startTurn(id,'first');await tick();client.replyApproval(approvals[0].id,{outcome:{outcome:'cancelled'}});await client.close();
 const restored=await startLocalCli('antigravity',{cwd:'/tmp',env:{MANDALA_HOME:home},onEvent(){},onApproval(){},onExit(){}});
 try{await restored.resumeThread(id);await restored.startTurn(id,'retry','auto');await expect.poll(()=>launches.at(-1)?.command).toBe('agy');expect(launches.at(-1)!.args).not.toContain('--conversation');}finally{await restored.close();}
});
it('decodes a Chinese character split across native stdout chunks',async()=>{
 const {client,id,events}=await setup();await client.startTurn(id,'hi','auto');await tick();const child=launches.at(-1)!.child;
 const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'你好'}]}})+'\n');const index=bytes.indexOf(Buffer.from('你'))+1;
 child.stdout.write(bytes.subarray(0,index));child.stdout.write(bytes.subarray(index));line(child,{type:'result',is_error:false,result:'你好',session_id:id});end(child);await tick();
 expect(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('')).toBe('你好');await client.close();
});
it('rejects unsupported MCP and turn inputs before mutation',async()=>{
 const client=await startLocalCli('cursor',{cwd:'/tmp',onEvent(){},onApproval(){},onExit(){}});
 await expect(client.startThread({cwd:'/tmp',instructions:'',mcp:[{name:'custom',transport:'stdio',command:'node'}]})).rejects.toThrow(/MCP/);expect(launches).toHaveLength(0);
 const id=await client.startThread({cwd:'/tmp',instructions:''});
 for(const input of [{effort:'high' as const},{images:[{path:'/missing',mimeType:'image/png'}]}])await expect(client.startTurn(id,'hi','auto',[],input)).rejects.toThrow(/effort|images/);
 expect(launches).toHaveLength(1);await client.close();
});
it.each(['default','strict'] as const)('requires a whole-turn %s grant before native tools',async mode=>{
 const {client,id,events,approvals}=await setup();const turn=await client.startTurn(id,'hi',mode);expect(events).toEqual([]);expect(approvals).toEqual([]);
 await tick();expect(events[0]).toMatchObject({method:'turn/started',params:{threadId:id,turn:{id:turn}}});expect(approvals[0]).toMatchObject({method:'acp/permission',params:{threadId:id,turnId:turn}});
 expect(approvals[0].params.title).toMatch(/entire turn/i);expect(JSON.stringify(approvals[0].params)).toMatch(/commands.*files/i);expect(launches).toHaveLength(1);
 client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'reject'}});await tick();expect(launches).toHaveLength(1);expect(events.at(-1).params.turn.status).toBe('interrupted');await client.close();
});
it('streams Cursor text once, maps tools, fails exit-zero errors and resumes exact IDs',async()=>{
 const {client,id,events,approvals}=await setup();await client.startTurn(id,'first');await tick();client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'allow'}});await tick();
 const first=launches.at(-1)!;expect(first.command).toBe('agent');expect(first.args).toContain('--force');expect(first.args).toContain(id);expect(first.args.join(' ')).toContain('Current host instructions');
 line(first.child,{type:'system',subtype:'init',session_id:id});line(first.child,{type:'thinking',subtype:'delta',text:'Thinking'});
 for(let i=0;i<2;i++)line(first.child,{type:'assistant',message:{id:'answer-1',content:[{type:'text',text:'Hello'}]}});
 line(first.child,{type:'tool_call',subtype:'started',call_id:'tool-1',tool_call:{readToolCall:{args:{path:'/tmp/a'}}}});
 line(first.child,{type:'tool_call',subtype:'completed',call_id:'tool-1',tool_call:{readToolCall:{result:{content:'contents'}}}});
 line(first.child,{type:'result',is_error:false,result:'Hello',session_id:id});end(first.child);await expect.poll(()=>events.at(-1)?.method).toBe('turn/completed');
 expect(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('')).toBe('Hello');
 expect(events.find(e=>e.method==='item/completed'&&e.params.item.type==='agentMessage').params.item.text).toBe('Hello');
 expect(events.find(e=>e.method==='item/completed'&&e.params.item.id==='tool-1').params.item).toMatchObject({tool:'readToolCall',status:'completed'});expect(events.at(-1).params.turn.status).toBe('completed');
 await client.startTurn(id,'second','auto');await expect.poll(()=>launches.length).toBe(3);const second=launches.at(-1)!;expect(second.args.slice(second.args.indexOf('--resume'),second.args.indexOf('--resume')+2)).toEqual(['--resume',id]);
 line(second.child,{type:'result',is_error:true,result:'native rejected',session_id:id});end(second.child);await expect.poll(()=>events.at(-1)?.params?.turn?.status).toBe('failed');expect(events.at(-1).params.turn).toMatchObject({status:'failed',error:{message:'native rejected'}});await client.close();
});
it('adopts the Antigravity native ID and resumes it on following prompts',async()=>{
 const {client,id,events,home}=await setup('antigravity');await client.startTurn(id,'first','auto');await expect.poll(()=>launches.length).toBe(1);const first=launches.at(-1)!;
 expect(first.command).toBe('agy');expect(first.args).toContain('--dangerously-skip-permissions');line(first.child,{event:'init',conversation_id:'agy-real-1'});
 line(first.child,{event:'step_update',step_update:{step_index:2,state:'ACTIVE',step_type:'agent_response',text_delta:'Ans'}});
 line(first.child,{event:'step_update',step_update:{step_index:2,state:'DONE',step_type:'agent_response',text_delta:'wer'}});
 line(first.child,{event:'step_update',step_update:{step_index:4,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{command:'pwd'},output:'/tmp'}}});
 line(first.child,{event:'result',result:{conversation_id:'agy-real-1',status:'SUCCESS',response:'Answer',usage:{input_tokens:8,output_tokens:2}}});end(first.child);await expect.poll(()=>events.at(-1)?.method).toBe('turn/completed');
 expect(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('')).toBe('Answer');
 expect(events.find(e=>e.method==='item/completed'&&e.params.item.tool==='run_command').params.item).toMatchObject({status:'completed',arguments:{command:'pwd'},result:'/tmp'});
 const mapping=join(home,'native','antigravity-sessions',id.slice('mandala-agy:'.length)+'.json');expect(JSON.parse(await readFile(mapping,'utf8'))).toEqual({nativeId:'agy-real-1'});expect((await stat(mapping)).mode&0o777).toBe(0o600);
 expect(id).toMatch(/^mandala-agy:/);expect(events.at(-1).params).toMatchObject({threadId:id,turn:{status:'completed'}});
 await client.startTurn(id,'second','auto');await expect.poll(()=>launches.length).toBe(2);expect(launches.at(-1)!.args).toContain('--conversation');expect(launches.at(-1)!.args).toContain('agy-real-1');
 const child=launches.at(-1)!.child;child.kill.mockImplementation((signal:string)=>{child.emit('close',null,signal);return true;});await client.close();
});
it('escalates cancellation, settles once and closes idempotently',async()=>{
 const {client,id,events}=await setup();const turn=await client.startTurn(id,'wait','auto');await tick();const child=launches.at(-1)!.child;
 vi.useFakeTimers();try{const stopped=client.interrupt(id,turn);await vi.advanceTimersByTimeAsync(2001);await stopped;
 expect(child.kill.mock.calls.map((call:any)=>call[0])).toEqual(['SIGTERM','SIGKILL']);expect(events.filter(e=>e.method==='turn/completed')).toHaveLength(1);expect(events.at(-1).params.turn.status).toBe('interrupted');
 end(child,1);await client.close();await client.close();expect(events.filter(e=>e.method==='turn/completed')).toHaveLength(1);}finally{vi.useRealTimers();}
});
it('cancels pending approvals on close and rejects invalid grants',async()=>{
 const {client,id,events,approvals}=await setup();await client.startTurn(id,'wait');await tick();expect(()=>client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'always'}})).toThrow(/permission/);
 await client.close();client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'allow'}});expect(launches).toHaveLength(1);expect(events.at(-1).params.turn.status).toBe('interrupted');
});
it('reads version and models without running a coding prompt',async()=>{
 const {client}=await setup();expect(await client.getStatus()).toEqual({status:'ready',version:'1.2.3'});expect(await client.listModels()).toEqual([{id:'auto',label:'Auto',isDefault:true},{id:'flash',label:'Flash'}]);expect(launches.some(p=>p.args.includes('--print'))).toBe(false);await client.close();
});
it('accepts the native Cursor ID when create-chat prints it but its writer stays open',async()=>{
 const child:any=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});
 child.kill=vi.fn((signal:string)=>{child.signalCode=signal;child.emit('close',null,signal);return true;});
 vi.mocked(spawn).mockImplementationOnce(()=>{queueMicrotask(()=>child.stdout.write('11111111-2222-4333-8444-555555555555\n'));return child;});
 const client=await startLocalCli('cursor',{cwd:'/tmp',onEvent(){},onApproval(){},onExit(){}});
 try{expect(await client.startThread({cwd:'/tmp',instructions:''})).toBe('11111111-2222-4333-8444-555555555555');expect(child.kill).toHaveBeenCalledWith('SIGTERM');}finally{await client.close();}
});

it('restores Antigravity exact native IDs after restart and refuses missing mappings',async()=>{
 const {client,id,home,events}=await setup('antigravity');await client.startTurn(id,'first','auto');await expect.poll(()=>launches.length).toBe(1);const child=launches.at(-1)!.child;
 line(child,{event:'init',conversation_id:'persisted-native'});line(child,{event:'result',result:{conversation_id:'persisted-native',status:'SUCCESS',response:'done'}});end(child);await expect.poll(()=>events.at(-1)?.method).toBe('turn/completed');await client.close();
 const restored=await startLocalCli('antigravity',{cwd:'/tmp',env:{MANDALA_HOME:home},onEvent(){},onApproval(){},onExit(){}});
 await expect(restored.resumeThread('mandala-agy:00000000-0000-0000-0000-000000000000')).rejects.toThrow(/mapping/);
 await restored.resumeThread(id,[],'Updated instructions');await restored.startTurn(id,'next','auto');await expect.poll(()=>launches.length).toBe(2);const next=launches.at(-1)!;expect(next.args).toContain('persisted-native');expect(next.args.join(' ')).toContain('Updated instructions');
 next.child.kill.mockImplementation((signal:string)=>{next.child.emit('close',null,signal);return true;});await restored.close();
});
it('fails a process without a terminal result rather than claiming success',async()=>{
 const {client,id,events}=await setup();await client.startTurn(id,'wait','auto');await tick();end(launches.at(-1)!.child);await tick();expect(events.at(-1).params.turn).toMatchObject({status:'failed',error:{message:expect.stringContaining('terminal result')}});await client.close();
});
it('treats Antigravity ERROR status as failed even with exit zero',async()=>{
 const {client,id,events}=await setup('antigravity');await client.startTurn(id,'wait','auto');await expect.poll(()=>launches.length).toBe(1);const child=launches.at(-1)!.child;line(child,{event:'result',result:{conversation_id:'native-error',status:'ERROR',error:'provider unavailable'}});end(child);await expect.poll(()=>events.at(-1)?.params?.turn?.status).toBe('failed');expect(events.at(-1).params.turn).toMatchObject({status:'failed',error:{message:'provider unavailable'}});await client.close();
});

it('passes Antigravity inline settings only after an entire-turn grant',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-agy-settings-'));directories.push(home);
 const approvals:any[]=[],settings=JSON.stringify({modelProvider:'gemini'});
 const client=await startLocalCli('antigravity',{cwd:'/tmp',env:{MANDALA_HOME:home,MANDALA_AGY_MODEL:'flash',MANDALA_AGY_SETTINGS:settings},onEvent(){},onApproval:a=>approvals.push(a),onExit(){}});
 try{
  await client.getStatus();expect(launches.at(-1)!.args).toEqual(['--version']);
  const id=await client.startThread({cwd:'/tmp',instructions:''});await client.startTurn(id,'tool request');await tick();expect(launches).toHaveLength(1);
  client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'allow'}});
  await expect.poll(()=>launches.length).toBe(2);
  const args=launches.at(-1)!.args;expect(args.slice(args.indexOf('--settings'),args.indexOf('--settings')+2)).toEqual(['--settings',settings]);expect(args.slice(args.indexOf('--model'),args.indexOf('--model')+2)).toEqual(['--model','flash']);
  line(launches.at(-1)!.child,{event:'result',result:{conversation_id:'native-settings',status:'SUCCESS',response:'done'}});end(launches.at(-1)!.child);await tick();
 }finally{await client.close();}
});
it('rejects Antigravity model changes before launch or session mutation',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-agy-model-'));directories.push(home);
 const client=await startLocalCli('antigravity',{cwd:'/tmp',env:{MANDALA_HOME:home,MANDALA_AGY_MODEL:'flash'},onEvent(){},onApproval(){},onExit(){}});
 try{
  await expect(client.startThread({cwd:'/tmp',instructions:'',model:'other'})).rejects.toThrow(/model/i);
  const id=await client.startThread({cwd:'/tmp',instructions:'',model:'flash'});
  await expect(client.resumeThread(id,[],'','other')).rejects.toThrow(/model/i);
  await expect(client.prepareTurn!(id,{model:'other'})).rejects.toThrow(/model/i);
  await expect(client.startTurn(id,'request','auto',[],{model:'other'})).rejects.toThrow(/model/i);
  expect(launches).toHaveLength(0);
  await client.resumeThread(id,[],'','flash');await client.prepareTurn!(id,{model:'flash'});
 }finally{await client.close();}
});
it('awaits pending Antigravity mapping writes before its home can be removed',async()=>{
 const {client,id,home,approvals}=await setup('antigravity');await client.startTurn(id,'write');await expect.poll(()=>approvals.length).toBe(1);
 client.replyApproval(approvals[0].id,{outcome:{outcome:'selected',optionId:'allow'}});
 await client.close();await rm(home,{recursive:true,force:true});
 await expect(readFile(join(home,'native','antigravity-sessions',id.slice('mandala-agy:'.length)+'.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
});
it('settles only once when the host closes again from a terminal callback',async()=>{
 const events:any[]=[],approvals:any[]=[];let requested=false;let client:any;
 client=await startLocalCli('cursor',{cwd:'/tmp',onApproval:a=>approvals.push(a),onExit(){},onEvent:e=>{events.push(e);if(e.method==='turn/completed'&&!requested){requested=true;void client.close();}}});
 const id=await client.startThread({cwd:'/tmp',instructions:''});await client.startTurn(id,'wait');await expect.poll(()=>approvals.length).toBe(1);await client.close();
 expect(events.filter(e=>e.method==='turn/completed')).toHaveLength(1);
});
