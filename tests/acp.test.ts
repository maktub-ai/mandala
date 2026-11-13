import { afterEach, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAgentFixture } from './helpers/acp-agent';
import { connectAcp } from '../server/acp';
import { approvalChoices, nativeApprovalResponse } from '../shared/approvals';

const fixtureCwd=tmpdir();
const agentFixtures: Awaited<ReturnType<typeof createAcpAgentFixture>>[] = [];
afterEach(async()=>{await Promise.all(agentFixtures.splice(0).map(agent=>agent.close()));});

async function fixture(loadSession = true,safeSystem=false,shutdownDelayMs?:number,permissionTool?:{kind?:'read'|'edit';rawInput?:unknown;locations?:{path:string}[]},resumeSession=false,legacyModels=false,codebuddySandbox=false,runtimeCli?:'dsh'|'hermes'|'openclaw',newSessionFailure=false) {
 const events: any[] = [], approvals: any[] = [], exits:string[]=[];
 let release: (()=>void)|undefined;
 const sessions:any[]=[],decisions:any[]=[],prompts:any[]=[];
 const agent = await createAcpAgentFixture(client=>({
  authenticate: async()=>({}),
  initialize: async()=>({protocolVersion:1,agentInfo:{name:codebuddySandbox?'codebuddy':runtimeCli==='openclaw'?'openclaw-acp':'fixture',version:'1.0'},agentCapabilities:{loadSession,...(resumeSession?{sessionCapabilities:{resume:{}}}:{})}}),
  newSession: async request=>{if(newSessionFailure)throw new Error('native Gateway unavailable');sessions.push(request);return {sessionId:'session-1',...(legacyModels?{models:{currentModelId:'native-default',availableModels:[{modelId:'native-default',name:'Default'},{modelId:'flash',name:'Flash'}]}}:{})};},
  extMethod:async(method,request)=>{sessions.push({method,request});return {};},
  loadSession: async()=>({}),
  resumeSession: async request=>{sessions.push({resumed:request});return {};},
  async prompt({sessionId,prompt}) {
   prompts.push(prompt);
   if(prompt.some(p=>p.type==='text'&&p.text==='empty-native-error'))return {stopReason:'end_turn' as const};
   if(prompt.some(p=>p.type==='text'&&p.text==='gateway-interruption')){await client.sessionUpdate({sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'[OpenClaw interruption] Gateway connection lost; outcome unknown'}}});return {stopReason:'end_turn' as const};}
   if(prompt.some(p=>p.type==='text'&&p.text==='structured-tool')){
    await client.sessionUpdate({sessionId,update:{sessionUpdate:'plan',entries:[{content:'Read source',priority:'high',status:'completed'},{content:'Validate result',priority:'medium',status:'in_progress'}]}});
    await client.sessionUpdate({sessionId,update:{sessionUpdate:'tool_call',toolCallId:'read-1',title:'Inspect source',kind:'read',status:'in_progress',rawInput:{path:join(fixtureCwd,'a.ts')},locations:[{path:join(fixtureCwd,'a.ts'),line:8}]}});
    await client.sessionUpdate({sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed',rawOutput:'contents'}});
    return {stopReason:'end_turn' as const};
   }
   await client.sessionUpdate({sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Answer'}}});
   if (prompt.some(p=>p.type==='text'&&p.text==='wait')) await new Promise<void>(resolve=>{release=resolve;});
   else decisions.push(await client.requestPermission({sessionId,toolCall:{toolCallId:'tool-1',title:'Edit file',status:'pending',rawInput:{path:join(fixtureCwd,'file.txt')},locations:[{path:join(fixtureCwd,'file.txt')}],...permissionTool},options:(codebuddySandbox?[{optionId:'allow_once',name:'Once',kind:'allow'},{optionId:'allow_session',name:'Session',kind:'allow'},{optionId:'deny',name:'Deny',kind:'reject'}]:[{optionId:'yes',name:'Once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]) as any}));
   return {stopReason:release?'cancelled' as const:'end_turn' as const};
  },
  async cancel(){release?.();},
 }),{shutdownDelayMs});
 agentFixtures.push(agent);
 const client = await connectAcp({cwd:fixtureCwd,safeSystem,runtimeCli:codebuddySandbox?'codebuddy':runtimeCli??'claude',onEvent:e=>events.push(e),onApproval:a=>approvals.push(a),onExit:reason=>exits.push(reason)},agent.command);
 return {client,events,approvals,agent,sessions,decisions,prompts,exits};
}
it('preserves legacy ACP model catalogs and selects models using their native method',async()=>{
 const {client,sessions}=await fixture(true,false,undefined,undefined,false,true);
 try{
  expect(await client.listModels()).toEqual([{id:'native-default',label:'Default',isDefault:true},{id:'flash',label:'Flash',isDefault:false}]);
  await client.prepareTurn!('session-1',{model:'flash'});
  expect(sessions.at(-1)).toEqual({method:'session/set_model',request:{sessionId:'session-1',modelId:'flash'}});
 }finally{await client.close();}
});
it('uses session/resume for agents such as DSH without the legacy loadSession capability',async()=>{
 const {client,sessions}=await fixture(false,false,undefined,undefined,true);
 try{
  await client.startThread({cwd:fixtureCwd,instructions:'Current instructions'});
  await client.resumeThread('persisted-dsh-session',[],'Updated instructions');
  expect(sessions.at(-1)).toEqual({resumed:{sessionId:'persisted-dsh-session',cwd:fixtureCwd,mcpServers:[]}});
 }finally{await client.close();}
});
it('retains structured tool kind and locations across partial ACP tool updates',async()=>{
 const {client,events}=await fixture();
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  await client.startTurn(id,'structured-tool');
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
  const item=events.find(e=>e.method==='item/completed'&&e.params.item?.id==='read-1').params.item;
  expect(item).toMatchObject({kind:'read',locations:[{path:join(fixtureCwd,'a.ts'),line:8}],result:'contents'});
 }finally{await client.close();}
});
it('forwards an ACP native plan as a plan snapshot without inventing a public progress report',async()=>{
 const {client,events}=await fixture();
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  await client.startTurn(id,'structured-tool');
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
  expect(events.find(e=>e.method==='turn/plan/updated')?.params.plan).toEqual([{step:'Read source',status:'completed'},{step:'Validate result',status:'in_progress'}]);
 }finally{await client.close();}
});
it('scopes streaming, exact once permissions and completion to the native session',async()=>{
 const {client,events,approvals}=await fixture();
 try {
  expect(await client.getStatus()).toEqual({status:'ready',version:'1.0'});
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  const turn=await client.startTurn(id,'hello');
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);
  expect(approvalChoices(approvals[0])).toEqual(['reject','approve']);
  expect(approvals[0].params).toMatchObject({itemId:'tool-1',toolCall:{rawInput:{path:join(fixtureCwd,'file.txt')},locations:[{path:join(fixtureCwd,'file.txt')}]}});
  client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'approve'));
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
  expect(events.find(e=>e.method==='item/agentMessage/delta').params).toMatchObject({threadId:id,turnId:turn,delta:'Answer'});
  expect(events.at(-1).params.turn.status).toBe('completed');
 } finally {await client.close();}
});
it('cancels a prompt without claiming success and rejects unsupported resume/input',async()=>{
 const {client,events}=await fixture();
 try {

  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  await expect(client.startTurn(id,'x','default',[],{effort:'high'})).rejects.toThrow(/effort/);
  await expect(client.startTurn(id,'x','default',[],{model:'unsupported'})).rejects.toThrow(/model/);
  await expect(client.startTurn(id,'x','default',[],{images:[{path:join(fixtureCwd,'mandala-missing-image'),mimeType:'image/png'}]})).rejects.toThrow(/images/);
  const turn=await client.startTurn(id,'wait');
  await expect.poll(()=>events.some(e=>e.method==='item/agentMessage/delta'),{timeout:5000}).toBe(true);
  await client.interrupt(id,turn);
  await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('interrupted');
 } finally {await client.close();}
});

it('rejects agents without durable session loading before starting a chat',async()=>{
 const {client}=await fixture(false);
 try {
  await expect(client.resumeThread('old')).rejects.toThrow(/resume/);
  await expect(client.startThread({cwd:fixtureCwd,instructions:''})).rejects.toThrow(/resume/);
 } finally {await client.close();}
});
it('auto approval selects only the offered once option',async()=>{
 const {client,events,approvals}=await fixture();
 try {
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  await client.startTurn(id,'auto','auto');
  await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('completed');
  expect(approvals).toEqual([]);
 } finally {await client.close();}
});
it('reports a missing ACP executable without leaving a pending child',async()=>{
 const {startAcp}=await import('../server/acp');
 await expect(startAcp('gemini',{cwd:fixtureCwd,env:{PATH:join(fixtureCwd,'mandala-nonexistent-bin')},onEvent(){},onApproval(){},onExit(){}})).rejects.toThrow();
},20000);

it('starts restricted ephemeral sessions without requiring durable resume and cancels permissions even in auto mode',async()=>{
 const {client,events,approvals,sessions,decisions}=await fixture(false,true);
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:'Transform only',ephemeral:true,safeSystem:true});
  expect(sessions[0]).toMatchObject({mcpServers:[],_meta:{claudeCode:{options:{tools:[],settingSources:[],persistSession:false}}}});
  await client.startTurn(id,'source','auto');
  await expect.poll(()=>decisions.length,{timeout:5000}).toBe(1);
  expect(decisions[0]).toEqual({outcome:{outcome:'cancelled'}});
  expect(approvals).toHaveLength(1);
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
 }finally{await client.close();}
});

it('writes native Gemini restrictions that disable global MCP, extensions, hooks and custom tool discovery before launch',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const cwd=await mkdtemp(join(tmpdir(),'mandala-restricted-gemini-'));
 try{
  const {startAcp}=await import('../server/acp');
  await expect(startAcp('gemini',{cwd,safeSystem:true,env:{PATH:join(fixtureCwd,'mandala-nonexistent-bin')},onEvent(){},onApproval(){},onExit(){}})).rejects.toThrow();
  const settings=JSON.parse(await readFile(join(cwd,'mandala-system-settings.json'),'utf8'));
  expect(settings).toMatchObject({tools:{core:[],discoveryCommand:'',callCommand:''},admin:{mcp:{enabled:false},extensions:{enabled:false},skills:{enabled:false}},hooksConfig:{enabled:false}});
 }finally{await rm(cwd,{recursive:true,force:true});}
},20000);

it('all close callers wait for the actual native child to exit and shutdown is idempotent',async()=>{
 const {client,agent}=await fixture(true,false,150);
 try{
  await client.startThread({cwd:fixtureCwd,instructions:''});
  const active=(await agent.pids()).filter(agent.isRunning);expect(active.length).toBeGreaterThan(0);
  let complete=false;const first=client.close();const second=Promise.resolve(client.close()).then(()=>{complete=true;});
  // Windows terminates children forcefully, so only POSIX can exercise the delayed SIGTERM handler.
  if(process.platform!=='win32'){await new Promise(resolve=>setTimeout(resolve,10));expect(complete).toBe(false);}
  await first;await second;expect(complete).toBe(true);
  expect(active.some(agent.isRunning)).toBe(false);
  await client.close();expect(active.some(agent.isRunning)).toBe(false);
 }finally{await client.close();}
});

it.each(['default','strict'] as const)('uses %s policy for structured local ACP edits',async mode=>{
 const {client,approvals,events,decisions}=await fixture(true,false,undefined,{kind:'edit'});
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'hello',mode);
  if(mode==='strict'){
   await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(decisions).toHaveLength(0);
   client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'approve'));
  }
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
  expect(approvals).toHaveLength(mode==='strict'?1:0);expect(decisions).toEqual([{outcome:{outcome:'selected',optionId:'yes'}}]);
 }finally{await client.close();}
});

it('delivers current host instructions in the actual ACP prompt on initial and resumed turns',async()=>{
 const {client,events,prompts}=await fixture(true,true);
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:'Current coordinator context A',safeSystem:true});
  await client.startTurn(id,'你好');
  await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(1);
  expect(prompts[0][0].text).toContain('<mandala-context>\nCurrent coordinator context A\n</mandala-context>\n\n你好');
  await client.resumeThread(id,[],'Current coordinator context B');
  await client.startTurn(id,'现在团队有哪些成员？');
  await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(2);
  expect(prompts[1][0].text).toContain('Current coordinator context B');
  expect(prompts[1][0].text).not.toContain('context A');
 }finally{await client.close();}
});

it('normalizes only CodeBuddy native sandbox permission kinds while retaining exact choice IDs',async()=>{
 const {client,approvals,decisions,events}=await fixture(true,false,undefined,undefined,false,false,true);
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'sandbox request','strict');
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(approvals[0].params.options.map((o:any)=>[o.optionId,o.kind])).toEqual([['allow_once','allow_once'],['allow_session','allow_always'],['deny','reject_once']]);
  client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'reject'));await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('completed');
  expect(decisions.at(-1)).toEqual({outcome:{outcome:'selected',optionId:'deny'}});
 }finally{await client.close();}
});

it.each(['default','strict'] as const)('requires a DSH whole-turn grant before %s prompts and rejects without effect',async mode=>{
 const {client,approvals,events,prompts}=await fixture(true,false,undefined,undefined,false,false,false,'dsh');
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'structured-tool',mode);
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(prompts).toEqual([]);
  expect(approvals[0].params).toMatchObject({wholeTurnApproval:true});
  expect(approvalChoices(approvals[0])).toEqual(['reject','approve']);
  client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'reject'));
  await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('interrupted');expect(prompts).toEqual([]);
 }finally{await client.close();}
});
it('allows DSH prompts only after an exact whole-turn grant, and auto mode is explicit',async()=>{
 const {client,approvals,events,prompts}=await fixture(true,false,undefined,undefined,false,false,false,'dsh');
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'structured-tool','strict');
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(prompts).toEqual([]);
  client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'approve'));
  await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(1);expect(prompts).toHaveLength(1);
  await client.startTurn(id,'structured-tool','auto');await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(2);
  expect(prompts).toHaveLength(2);expect(approvals).toHaveLength(1);
 }finally{await client.close();}
});
it('interrupts a pending DSH whole-turn grant without sending its prompt',async()=>{
 const {client,approvals,events,prompts}=await fixture(true,false,undefined,undefined,false,false,false,'dsh');
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''}),turn=await client.startTurn(id,'structured-tool','strict');
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);await client.interrupt(id,turn);
  await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('interrupted');expect(prompts).toEqual([]);
 }finally{await client.close();}
});

for(const cli of ['hermes','openclaw'] as const){
 it.each(['default','strict'] as const)(`${cli} refuses %s turns before dispatch when the whole-turn grant is denied`,async mode=>{
  const {client,approvals,events,prompts}=await fixture(true,false,undefined,undefined,false,false,false,cli);
  try{const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'structured-tool',mode);
   await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(prompts).toEqual([]);expect(approvals[0].params.wholeTurnApproval).toBe(true);
   client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'reject'));
   await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('interrupted');expect(prompts).toEqual([]);
  }finally{await client.close();}
 });
 it(`${cli} dispatches once after whole-turn approval and stop prevents a pending dispatch`,async()=>{
  const {client,approvals,events,prompts}=await fixture(true,false,undefined,undefined,false,false,false,cli);
  try{const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,'structured-tool','strict');
   await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(prompts).toEqual([]);
   client.replyApproval(approvals[0].id,nativeApprovalResponse(approvals[0],'approve'));
   await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(1);expect(prompts).toHaveLength(1);
   const turn=await client.startTurn(id,'structured-tool','strict');await expect.poll(()=>approvals.length,{timeout:5000}).toBe(2);
   await client.interrupt(id,turn);await expect.poll(()=>events.filter(e=>e.method==='turn/completed').length,{timeout:5000}).toBe(2);expect(prompts).toHaveLength(1);
  }finally{await client.close();}
 });
}
it.each(['hermes','openclaw'] as const)('rejects %s session MCP before any grant can survive removal and adapter restart',async cli=>{
 const {client,sessions}=await fixture(true,false,undefined,undefined,false,false,false,cli);
 const mcp=[{name:'bound',transport:'stdio' as const,command:'node',args:[]}];
 try{
  await expect(client.startThread({cwd:fixtureCwd,instructions:'',mcp})).rejects.toThrow(/session.*MCP/);expect(sessions).toEqual([]);
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  await expect(client.resumeThread(id,mcp)).rejects.toThrow(/session.*MCP/);
  await expect(client.resumeThread('persisted',mcp)).rejects.toThrow(/session.*MCP/);expect(sessions).toHaveLength(1);
 }finally{await client.close();}
});
it('restores OpenClaw using an existing Gateway key, never the permissive load fallback',async()=>{
 const {client,sessions}=await fixture(true,false,undefined,undefined,true,false,false,'openclaw');
 try{await client.resumeThread('550e8400-e29b-41d4-a716-446655440000',[],'current');
 expect(sessions).toEqual([{resumed:{sessionId:'550e8400-e29b-41d4-a716-446655440000',cwd:fixtureCwd,mcpServers:[],_meta:{sessionKey:'acp-bridge:550e8400-e29b-41d4-a716-446655440000',requireExisting:true}}}]);
 }finally{await client.close();}
});

it.each(['empty-native-error','gateway-interruption'])('does not report OpenClaw %s as a successful turn or replay it',async prompt=>{
 const {client,events,prompts}=await fixture(true,false,undefined,undefined,true,false,false,'openclaw');
 try{const id=await client.startThread({cwd:fixtureCwd,instructions:''});await client.startTurn(id,prompt,'auto');
 await expect.poll(()=>events.at(-1)?.params?.turn?.status,{timeout:5000}).toBe('failed');expect(events.at(-1).params.turn.error.message).toMatch(/Gateway/);expect(prompts).toHaveLength(1);
 }finally{await client.close();}
});

it.each(['hermes','openclaw'] as const)('%s exposes Gateway setup failures in model discovery',async cli=>{
 const {client}=await fixture(true,false,undefined,undefined,false,false,false,cli,true);
 try{await expect(client.listModels()).rejects.toThrow(/Gateway.*native.*login/);}finally{await client.close();}
});


it('does not replace a fresh native session when its first turn cannot reconnect',async()=>{
 let created=0,loaded=0,prompted=0;const events:any[]=[];
 const agent=await createAcpAgentFixture(()=>({
  authenticate:async()=>({}),
  initialize:async()=>({protocolVersion:1,agentCapabilities:{loadSession:true}}),
  newSession:async()=>({sessionId:`native-${++created}`}),
  loadSession:async()=>{loaded+=1;throw new RequestError(-32603,'native load unavailable');},
  prompt:async()=>{prompted+=1;return {stopReason:'end_turn' as const};},
  cancel:async()=>{},
 }));
 agentFixtures.push(agent);
 const client=await connectAcp({cwd:fixtureCwd,runtimeCli:'claude',onEvent:event=>events.push(event),onApproval(){},onExit(){}},agent.command);
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});expect(id).toBe('native-1');
  const active=(await agent.pids()).filter(agent.isRunning);expect(active.length).toBeGreaterThan(0);
  await agent.disconnect(agent.agents.at(-1)!);
  await expect.poll(()=>active.some(agent.isRunning),{timeout:5000}).toBe(false);
  await client.startTurn(id,'first prompt after disconnect');
  await expect.poll(()=>events.find(event=>event.method==='turn/completed')?.params.turn.status,{timeout:5000}).toBe('failed');
  expect(loaded).toBeGreaterThan(0);expect(created).toBe(1);expect(prompted).toBe(0);
  expect(events.find(event=>event.method==='turn/completed').params.threadId).toBe(id);
 }finally{await client.close();}
});


it('reports an unexpected idle native session exit to the host',async()=>{
 const {client,agent,exits}=await fixture();
 try{
  await client.startThread({cwd:fixtureCwd,instructions:''});expect(exits).toEqual([]);
  await agent.disconnect(agent.agents.at(-1)!);
  await expect.poll(()=>exits.length,{timeout:5000}).toBe(1);
  expect(exits[0]).toMatch(/connection closed/);
 }finally{await client.close();}
 expect(exits).toHaveLength(1);
});

it('expires a pending whole-turn grant when its native session exits without dispatching a late answer',async()=>{
 const {client,agent,approvals,events,prompts,exits}=await fixture(true,false,undefined,undefined,false,false,false,'dsh');
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  const turn=await client.startTurn(id,'structured-tool','strict');
  await expect.poll(()=>approvals.length,{timeout:5000}).toBe(1);expect(prompts).toEqual([]);
  const approval=approvals[0];expect(approval.params.wholeTurnApproval).toBe(true);
  await agent.disconnect(agent.agents.at(-1)!);
  await expect.poll(()=>exits.length,{timeout:5000}).toBe(1);
  await expect.poll(()=>events.find(event=>event.method==='turn/completed'&&event.params.turn.id===turn)?.params.turn.status,{timeout:5000}).toBe('interrupted');
  expect(events.filter(event=>event.method==='serverRequest/resolved'&&event.params.requestId===approval.id)).toHaveLength(1);
  client.replyApproval(approval.id,nativeApprovalResponse(approval,'approve'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(prompts).toEqual([]);expect(approvals).toHaveLength(1);
 }finally{await client.close();}
});

it('does not report normal doctor shutdown or an explicit client close as a native exit',async()=>{
 const {client,agent,exits}=await fixture();
 try{
  const doctorPids=await agent.pids();expect(doctorPids.length).toBeGreaterThan(0);
  expect(doctorPids.some(agent.isRunning)).toBe(false);expect(exits).toEqual([]);
  await client.startThread({cwd:fixtureCwd,instructions:''});
  const active=(await agent.pids()).filter(agent.isRunning);expect(active.length).toBeGreaterThan(0);
  await client.close();expect(active.some(agent.isRunning)).toBe(false);expect(exits).toEqual([]);
 }finally{await client.close();}
});


it.skipIf(process.platform==='win32')('does not report a successful Gemini version probe as a session exit during reconnect',async()=>{
 const events:any[]=[],exits:string[]=[],prompts:string[]=[];let created=0;
 const agent=await createAcpAgentFixture(connection=>({
  authenticate:async()=>({}),
  initialize:async()=>({protocolVersion:1,agentCapabilities:{loadSession:true}}),
  newSession:async()=>{created+=1;return {sessionId:'gemini-session'};},
  loadSession:async()=>({}),
  async prompt({sessionId,prompt}){
   prompts.push(prompt.filter(block=>block.type==='text').map(block=>block.text).join(''));
   await connection.sessionUpdate({sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Recovered answer'}}});
   return {stopReason:'end_turn' as const};
  },
  cancel:async()=>{},
 }),{nativeLauncher:'gemini'});
 agentFixtures.push(agent);
 const client=await connectAcp({cwd:fixtureCwd,runtimeCli:'gemini',onEvent:event=>events.push(event),onApproval(){},onExit:reason=>exits.push(reason)},agent.command);
 try{
  const id=await client.startThread({cwd:fixtureCwd,instructions:''});
  const probes=await agent.probeCount();expect(probes).toBeGreaterThan(0);
  await agent.disconnect(agent.agents.at(-1)!);
  await expect.poll(()=>exits.length,{timeout:5000}).toBe(1);
  await client.startTurn(id,'Continue after disconnect','auto');
  await expect.poll(()=>events.find(event=>event.method==='turn/completed')?.params.turn.status,{timeout:5000}).toBe('completed');
  expect(await agent.probeCount()).toBeGreaterThan(probes);
  expect(exits).toHaveLength(1);expect(created).toBe(1);expect(prompts).toEqual(['Continue after disconnect']);
 }finally{await client.close();}
});
