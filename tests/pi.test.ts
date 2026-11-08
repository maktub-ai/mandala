import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startPi } from '../server/pi';
import type { CodexClient } from '../server/codex';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode = 'normal', safeSystem = false) {
  const dir = await mkdtemp(join(tmpdir(), 'mandala-pi-'));
  const capture = join(dir, 'requests.jsonl');
  const launch = join(dir, 'launch.json');
  await writeFile(join(dir, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
fs.writeFileSync(${JSON.stringify(launch)}, JSON.stringify({args:process.argv.slice(2),home:process.env.HOME}));
let path = ${JSON.stringify(join(dir, 'native.jsonl'))};
const model = {provider:'test',id:'model',name:'Test model',reasoning:true,input:['text','image']};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 fs.appendFileSync(${JSON.stringify(capture)}, line+'\\n');
 const r = JSON.parse(line);
 if(r.type==='extension_ui_response') { send({type:'agent_end',messages:[]}); return; }
 if(r.type==='switch_session' && ${JSON.stringify(mode)}!=='wrong-resume') path=r.sessionPath;
 if(r.type==='prompt' && ${JSON.stringify(mode)}==='reject') {send({type:'response',id:r.id,success:false,error:'prompt rejected'});return;}
 let data = r.type==='get_state'?{sessionFile:path,sessionId:'native-id',model,thinkingLevel:'medium',isStreaming:false,isCompacting:false,pendingMessageCount:0}:r.type==='get_commands'?{commands:[{name:'mandala-permission-gate',source:'extension',sourceInfo:{path:process.argv[process.argv.indexOf('-e')+1]}}]}:r.type==='get_available_models'?{models:[model]}:r.type==='get_available_thinking_levels'?{levels:['off','low','high']}:{cancelled:false};
 send({type:'response',id:r.id,success:true,data});
 if(r.type==='abort'){send({type:'agent_end',messages:[]});return;}
 if(r.type!=='prompt')return;
 send({type:'agent_start'});
 if(${JSON.stringify(mode)}==='descendant'){
  const grandchild=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(join(dir,'descendant.pid'))},String(grandchild.pid));return;
 }
 if(${JSON.stringify(mode)}==='hang')return;
 if(${JSON.stringify(mode)}==='approval'){
  send({type:'extension_ui_request',id:'permission',method:'select',title:'Mandala tool approval: '+JSON.stringify({toolName:r.message.includes('read-tool')?'read':'bash',toolCallId:'tool',input:r.message.includes('read-tool')?{path:${JSON.stringify(join(dir, 'file.txt'))}}:{command:'touch marker'}}),options:['Approve','Deny']});return;
 }
 if(${JSON.stringify(mode)}==='exit'){process.exit(2);return;}
 send({type:'message_start',message:{role:'assistant',model:'model'}});
 send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Hello'}});
 send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:1,delta:'Thinking'}});
 send({type:'message_end',message:{role:'assistant',model:'model',content:[{type:'text',text:'Hello'},{type:'thinking',thinking:'Thinking'}],usage:{input:4,output:2},stopReason:${JSON.stringify(mode)}==='error'?'error':'stop',errorMessage:'provider failure'}});
 send({type:'tool_execution_start',toolCallId:'tool',toolName:'read',args:{path:'file'}});
 send({type:'tool_execution_update',toolCallId:'tool',partialResult:{content:[{type:'text',text:'abc'}]}});
 send({type:'tool_execution_update',toolCallId:'tool',partialResult:{content:[{type:'text',text:'abcdef'}]}});
 send({type:'tool_execution_end',toolCallId:'tool',toolName:'read',result:{content:[]},isError:false});
 send({type:'agent_end',messages:[]});send({type:'agent_end',messages:[]});
});
`);
  await chmod(join(dir, 'pi'), 0o700);
  await writeFile(join(dir, 'file.txt'), 'sample');
  const events: {method?: string; params?: any}[] = [], approvals: any[] = [], exits: string[] = [];
  const client = await startPi({cwd:dir,safeSystem,env:{PATH:dir+':'+process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:join(dir,'profile')},onEvent:e=>events.push(e),onApproval:r=>approvals.push(r),onExit:r=>exits.push(r)});
  cleanups.push(async () => { await client.close(); await rm(dir,{recursive:true,force:true}); });
  return {dir,client,events,approvals,exits,requests:async ()=>(await readFile(capture,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),launch:async()=>JSON.parse(await readFile(launch,'utf8'))};
}
async function until(check: () => boolean) {
  for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(check()).toBe(true);
}
async function thread(client: CodexClient, cwd: string) { return client.startThread({cwd,instructions:'Current Mandala context'}); }

it('negotiates without a ready event and returns the exact durable session path', async () => {
 const f=await fixture();
 expect(await thread(f.client,f.dir)).toBe(join(f.dir,'native.jsonl'));
 expect((await f.requests())[0].type).toBe('get_state');
 const args=(await f.launch()).args;
 expect(args).toEqual(expect.arrayContaining(['--mode','rpc','--no-extensions','-e']));
 expect(args[args.indexOf('-e')+1]).toMatch(/pi-permission-extension\.mjs$/);
});
it('resumes the requested native file and replaces invocation context',async()=>{
 const f=await fixture(),native=join(f.dir,'restored.jsonl');
 await f.client.resumeThread(native,[],'Fresh invocation','test/model');
 await f.client.startTurn(native,'hello');await until(()=>f.events.some(e=>e.method==='turn/completed'));
 const requests=await f.requests();
 expect(requests.find(r=>r.type==='switch_session')).toMatchObject({sessionPath:native});
 expect(requests.find(r=>r.type==='set_model')).toMatchObject({provider:'test',modelId:'model'});
 expect(requests.find(r=>r.type==='prompt').message).toContain('Fresh invocation');
 expect((await f.launch()).args).not.toContain('--continue');
});
it('rejects a resume that silently selects a different native session',async()=>{
 const f=await fixture('wrong-resume');await expect(f.client.resumeThread(join(f.dir,'restored.jsonl'))).rejects.toThrow('session');
});
it('streams text, thought and tool deltas and completes exactly once with a stable turn ID',async()=>{
 const f=await fixture(),id=await thread(f.client,f.dir),turn=await f.client.startTurn(id,'hello');
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect(f.events.filter(e=>e.method==='turn/completed')).toHaveLength(1);
 expect(f.events.find(e=>e.method==='turn/completed')?.params.turn).toEqual({id:turn,status:'completed'});
 expect(f.events.find(e=>e.method==='item/agentMessage/delta')?.params.delta).toBe('Hello');
 expect(f.events.find(e=>e.method==='item/reasoning/textDelta')?.params.delta).toBe('Thinking');
 expect(f.events.filter(e=>e.method==='item/commandExecution/outputDelta').map(e=>e.params.delta)).toEqual(['abc','def']);
 expect(f.events.find(e=>e.method==='mandala/usageMessage')?.params.usage).toEqual({input:4,output:2});
});
it.each(['reject','error','exit'])('finishes a failed %s turn',async mode=>{
 const f=await fixture(mode),id=await thread(f.client,f.dir);await f.client.startTurn(id,'hello');
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect(f.events.filter(e=>e.method==='turn/completed')).toHaveLength(1);
 expect(f.events.find(e=>e.method==='turn/completed')?.params.turn.status).toBe('failed');
});
it('returns a turn ID without waiting for the prompt to finish and interrupts once',async()=>{
 const f=await fixture('hang'),id=await thread(f.client,f.dir);
 const turn=await f.client.startTurn(id,'hello');expect(turn).toBeTruthy();
 await f.client.interrupt(id,turn);await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect(f.events.filter(e=>e.method==='turn/completed')).toHaveLength(1);
 expect(f.events.find(e=>e.method==='turn/completed')?.params.turn.status).toBe('interrupted');
});
it.skipIf(process.platform==='win32')('interrupt reaps tool subprocesses in its own process group',async()=>{
 const f=await fixture('descendant'),id=await thread(f.client,f.dir),turn=await f.client.startTurn(id,'run');
 let pid=0;
 for(let i=0;i<100&&!pid;i++){try{pid=Number(await readFile(join(f.dir,'descendant.pid'),'utf8'));}catch{}if(!pid)await new Promise(resolve=>setTimeout(resolve,10));}
 expect(pid).toBeGreaterThan(0);
 try{
  await f.client.interrupt(id,turn);
  await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}});
 }finally{try{process.kill(pid,'SIGKILL');}catch{}}
});
it.each(['default','strict','auto'] as const)('mediates %s tool approval with fail-closed replies',async mode=>{
 const f=await fixture('approval'),id=await thread(f.client,f.dir);await f.client.startTurn(id,'bash-tool',mode);
 await until(()=>mode==='auto'?f.events.some(e=>e.method==='turn/completed'):f.approvals.length===1);
 if(mode!=='auto'){expect(f.approvals[0]).toMatchObject({method:'omp/confirm',params:{toolApproval:true}});f.client.replyApproval('permission',{});}
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect((await f.requests()).find(r=>r.type==='extension_ui_response')).toMatchObject({value:mode==='auto'?'Approve':'Deny'});
});
it('locally approves only known workspace reads under default mode',async()=>{
 const f=await fixture('approval'),id=await thread(f.client,f.dir);await f.client.startTurn(id,'read-tool','default');
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect(f.approvals).toHaveLength(0);expect((await f.requests()).find(r=>r.type==='extension_ui_response').value).toBe('Approve');
});
it('runs safe system tasks with tools and discovery disabled and declines UI requests',async()=>{
 const f=await fixture('approval',true),id=await thread(f.client,f.dir);await f.client.startTurn(id,'bash-tool','auto');
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect((await f.launch()).args).toEqual(expect.arrayContaining(['--no-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files']));
 expect((await f.launch()).args).not.toContain('-e');expect(f.approvals).toHaveLength(0);
 expect((await f.requests()).find(r=>r.type==='extension_ui_response').cancelled).toBe(true);
});
it('uses native model and effort capabilities and sends image bytes',async()=>{
 const f=await fixture(),id=await thread(f.client,f.dir),image=join(f.dir,'image.png');await writeFile(image,'bytes');
 expect((await f.client.listModels())[0]).toMatchObject({id:'test/model',isDefault:true,supportedReasoningEfforts:['none','low','high']});
 await f.client.startTurn(id,'look','default',undefined,{model:'test/model',effort:'high',images:[{path:image,mimeType:'image/png'}]});
 await until(()=>f.events.some(e=>e.method==='turn/completed'));
 expect((await f.requests()).find(r=>r.type==='set_thinking_level')).toMatchObject({level:'high'});
 expect((await f.requests()).find(r=>r.type==='prompt').images).toEqual([{type:'image',data:Buffer.from('bytes').toString('base64'),mimeType:'image/png'}]);
 await expect(f.client.startTurn(id,'x','default',undefined,{effort:'ultra'})).rejects.toThrow('thinking');
});
it('rejects requested MCP and unmanaged extension arguments explicitly',async()=>{
 const f=await fixture();await expect(f.client.startThread({cwd:f.dir,instructions:'',mcp:[{name:'server',transport:'stdio',command:'server'}]})).rejects.toThrow('MCP');
 await expect(startPi({cwd:f.dir,extraArgs:['-e','unsafe.mjs'],onEvent(){},onApproval(){},onExit(){}})).rejects.toThrow('arguments');
});
