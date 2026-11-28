import {expect,it,onTestFinished,vi} from 'vitest';
import {tmpdir} from 'node:os';
import {createAcpAgentFixture} from './helpers/acp-agent';
import type {Cli} from '../shared/types';
import {connectAcp} from '../server/acp';

type Frame={sessionId:string;update:Record<string,unknown>};
const root='root';
const frame=(update:Frame['update'],sessionId=root):Frame=>({update,sessionId});
const text=(value:string,meta?:Record<string,unknown>)=>({sessionUpdate:'agent_message_chunk',content:{type:'text',text:value},_meta:meta});
const team=(teamName:string,members:unknown[])=>frame({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/teamUpdate':{type:'member_status_change',teamName,members}}});
async function replay(cli:Cli,frames:Frame[],permissionSessions:(string|{id:string;meta:Record<string,unknown>})[]=[]) {
 const events:any[]=[],approvals:any[]=[],decisions:any[]=[];
 let capabilities:any;
 const agent=await createAcpAgentFixture(peer=>({
  initialize:async r=>{capabilities=r.clientCapabilities;return {protocolVersion:1,agentInfo:{name:cli,version:'1.0.0'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}};},
  authenticate:async()=>({}),newSession:async()=>({sessionId:root}),loadSession:async()=>({}),unstable_resumeSession:async()=>({}),cancel:async()=>{},
  prompt:async()=>{
   for(const f of frames)await peer.sessionUpdate(f as any);
   for(const target of permissionSessions)decisions.push(await peer.requestPermission({sessionId:typeof target==='string'?target:target.id,...(typeof target==='string'?{}:{_meta:target.meta}),toolCall:{toolCallId:'read',title:'inspect',kind:'read'},options:[{kind:'allow_once',name:'Allow',optionId:'once'}]}));
   return {stopReason:'end_turn'};
  },
 }));
 const client=await connectAcp({
  cwd:tmpdir(),runtimeCli:cli,onEvent:e=>events.push(e),onApproval:a=>{approvals.push(a);queueMicrotask(()=>client.replyApproval(a.id!,{outcome:{outcome:'selected',optionId:'once'}}));},onExit(){},
 },agent.command);
 try{
  await client.startThread({cwd:tmpdir(),instructions:''});await client.startTurn(root,'fixture','auto');
  await expect.poll(()=>events.some(e=>e.method==='turn/completed'),{timeout:5000}).toBe(true);
  const rows=events.map(e=>e.params.item).filter(i=>i?.type==='nativeSubagent');
  return {events,rows,capabilities,approvals,decisions,answer:events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('')};
 }finally{await client.close();await agent.close();}
}

it('separates CodeBuddy roster members and unknown tagged output from the main answer',async()=>{
 const {answer,rows}=await replay('codebuddy',[
  team('qa',[{name:'Reviewer',sessionId:'c1',description:'Review',status:'running'}]),
  frame(text('A')),frame(text('isolated',{'codebuddy.ai/memberEvent':'Reviewer'})),
  frame(text('ambiguous',{'codebuddy.ai/memberEvent':'Not advertised'})), frame(text('B')),
  team('qa',[{name:'Reviewer',sessionId:'c1',status:'completed'}]),
 ]);
 expect(answer).toBe('AB');
 expect(rows.at(-1)).toMatchObject({agentId:'c1',name:'Reviewer',task:'Review',status:'completed',text:'isolated'});
 expect(new Set(rows.map(r=>r.id)).size).toBe(1);
});
it('routes CodeBuddy versioned snapshots and isolates tagged tools, thoughts, and incomplete references',async()=>{
 const ref={'codebuddy.ai/subagent':{version:1,sessionId:'c1'}};
 const snapshot=frame({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/subagent':{version:1,sessionId:'c1',rootSessionId:root,parentSessionId:root,parentToolCallId:'task',status:'running',role:'reviewer',description:'Audit'}}});
 const {events,answer,rows}=await replay('codebuddy',[snapshot,frame(text('own',ref)),frame({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private'},_meta:ref}),frame({sessionUpdate:'tool_call',toolCallId:'local',title:'read file',kind:'read',_meta:ref}),frame(text('wrong',{'codebuddy.ai/subagent':{version:1,sessionId:'foreign'}})),frame(text('root'))]);
 expect(answer).toBe('root');expect(JSON.stringify(events)).not.toContain('private');expect(JSON.stringify(events)).not.toContain('wrong');
 expect(events.some(e=>e.params.item?.type==='mcpToolCall'&&e.params.item.id==='local')).toBe(false);expect(rows.some(r=>r.agentId==='c1'&&r.text?.includes('own'))).toBe(true);
});
it('accepts announced ACP child and grandchild sessions, never grants an unknown child permission',async()=>{
 const diagnostics=vi.spyOn(console,'error');onTestFinished(()=>diagnostics.mockRestore());
 const {rows,answer,decisions,approvals,capabilities}=await replay('claude',[
  frame({sessionUpdate:'subagent_spawned',subagentSessionId:'c1',name:'Reviewer',task:'Review'}),
  frame({sessionUpdate:'subagent_update',sessionId:'c2',description:'Nested',state:{state:'running'}},'c1'),
  frame(text('nested'), 'c2'),frame(text('foreign'),'other'),frame(text('root')),
  frame({sessionUpdate:'subagent_state_update',subagentSessionId:'c2',state:'completed'},'c1')
 ],['c1','other']);
 expect(diagnostics.mock.calls).toEqual([]);
 expect(capabilities.subagents).toEqual({});expect(answer).toBe('root');
 expect(rows.at(-1)).toMatchObject({agentId:'c2',status:'completed',text:'nested'});
 expect(approvals).toHaveLength(1);expect(approvals[0].params).toMatchObject({threadId:root,nativeSubagentId:'c1'});
 expect(decisions.map(d=>d.outcome.outcome)).toEqual(['selected','cancelled']);
});
it.each([['opencode','task',{description:'Audit',subagent_type:'reviewer'},{metadata:{parentSessionId:root,sessionId:'c1',background:true}},'c1'],['kimi','Agent',{description:'Audit',prompt:'Review'},undefined,undefined],['dsh','subagent',{description:'Audit',prompt:'Review'},undefined,undefined]] as const)('shows %s delegation without equating a tool return with child completion',async(cli,title,rawInput,rawOutput,agentId)=>{
 const {rows}=await replay(cli,[frame({sessionUpdate:'tool_call',toolCallId:'t',title,rawInput}),frame({sessionUpdate:'tool_call_update',toolCallId:'t',status:'completed',rawOutput})]);
 expect(rows.at(-1)).toMatchObject({task:'Audit',status:'dispatched'});expect(rows.at(-1)?.agentId).toBe(agentId);expect(new Set(rows.map(r=>r.id)).size).toBe(1);
});
it.each(['gemini','grok','hermes','openclaw'] as const)('preserves ordinary %s tools with a suggestive title',async cli=>{
 const {rows,events}=await replay(cli,[frame({sessionUpdate:'tool_call',toolCallId:'t',title:'Agent',kind:'think'})]);
 expect(rows).toEqual([]);expect(events.some(e=>e.params.item?.type==='mcpToolCall'&&e.params.item.id==='t')).toBe(true);
});

it('uses team-scoped identities for roster-only members and isolates ambiguous names',async()=>{
 const {rows,answer,decisions}=await replay('codebuddy',[
  team('one',[{name:'Reviewer',status:'running'}]),frame(text('first',{'codebuddy.ai/memberEvent':'Reviewer'})),
  team('two',[{name:'Reviewer',status:'running'}]),frame(text('ambiguous',{'codebuddy.ai/memberEvent':'Reviewer'})),
  frame(text('root')),
 ],['Reviewer']);
 const [first,second]=[...new Set(rows.map(r=>r.agentId))];
 expect(first).toBeTruthy();expect(second).toBeTruthy();expect(first).not.toBe(second);
 expect(answer).toBe('root');expect(JSON.stringify(rows)).not.toContain('ambiguous');
 expect(rows.some(r=>r.text==='first')).toBe(true);expect(decisions[0].outcome.outcome).toBe('cancelled');
});
it('reuses a CodeBuddy dispatch item when a snapshot names its parent call',async()=>{
 const {rows}=await replay('codebuddy',[
  frame({sessionUpdate:'tool_call',toolCallId:'call',title:'Run',rawInput:{description:'Review'},_meta:{'codebuddy.ai/isSubagent':true}}),
  frame({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/subagent':{version:1,sessionId:'c',rootSessionId:root,parentSessionId:root,parentToolCallId:'call',role:'Reviewer',status:'running'}}}),
  frame({sessionUpdate:'tool_call_update',toolCallId:'call',status:'completed'}),
 ]);
 expect(new Set(rows.map(r=>r.id)).size).toBe(1);expect(rows.at(-1)).toMatchObject({agentId:'c',status:'running'});
});
it('keeps Claude child activity on a confirmed parent call in legacy metadata',async()=>{
 const {rows,answer}=await replay('claude',[
  frame({sessionUpdate:'tool_call',toolCallId:'task',title:'Run',rawInput:{description:'Audit'},_meta:{claudeCode:{toolName:'Task'}}}),
  frame(text('child',{claudeCode:{parentToolUseId:'task'}})),frame(text('foreign',{claudeCode:{parentToolUseId:'none'}})),frame(text('root')),
 ]);
 expect(answer).toBe('root');expect(rows.at(-1)).toMatchObject({task:'Audit',text:'child'});expect(rows.at(-1).agentId).toBeUndefined();
});

it('keeps native Claude child approval separate from an auto-approved root turn',async()=>{
 const {rows,approvals,decisions}=await replay('claude',[
  frame({sessionUpdate:'tool_call',toolCallId:'delegate',title:'Agent',rawInput:{description:'Audit'},_meta:{claudeCode:{toolName:'Agent'}}}),
  frame({sessionUpdate:'subagent_update',sessionId:'known-child',state:{state:'running'},_meta:{claudeCode:{parentToolUseId:'delegate'}}}),
 ],[
  {id:root,meta:{claudeCode:{agentId:'unknown-child'}}},
  {id:root,meta:{claudeCode:{agentId:'known-child'}}},
 ]);
 expect(new Set(rows.map(row=>row.id)).size).toBe(1);
 expect(approvals).toHaveLength(1);
 expect(approvals[0].params.nativeSubagentId).toBe('known-child');
 expect(decisions.map(decision=>decision.outcome.outcome)).toEqual(['cancelled','selected']);
});

it('extracts DSH identity only from the native activation acknowledgement',async()=>{
 const {rows}=await replay('dsh',[frame({sessionUpdate:'tool_call',toolCallId:'call',title:'subagent_fork',rawInput:{description:'Audit',prompt:'Read'}}),frame({sessionUpdate:'tool_call_update',toolCallId:'call',status:'completed',content:[{type:'content',content:{type:'text',text:'started subagent c-dsh'}}]})]);
 expect(rows.at(-1)).toMatchObject({agentId:'c-dsh',status:'dispatched'});
});
it('uses only the fixed Kimi Agent output header for child identity and status',async()=>{
 const output='agent_id: c-kimi\nactual_subagent_type: reviewer\nstatus: completed\nstop_reason: completed\n\n[summary]\nChecked\n\nresume_hint: Continue with Agent';
 const {rows,decisions}=await replay('kimi',[frame({sessionUpdate:'tool_call',toolCallId:'call',title:'Agent',rawInput:{description:'Audit',prompt:'Read'}}),frame({sessionUpdate:'tool_call_update',toolCallId:'call',status:'completed',rawOutput:output})],['c-kimi']);
 expect(rows.at(-1)).toMatchObject({agentId:'c-kimi',name:'reviewer',status:'completed',text:'Checked'});
 expect(decisions[0].outcome.outcome).toBe('cancelled');
});
it('upserts inter-session message snapshots without promoting a child report into the main answer',async()=>{
 const {rows,answer}=await replay('gemini',[
  frame({sessionUpdate:'subagent_update',sessionId:'c',title:'Review'}),
  frame({sessionUpdate:'session_message_chunk',messageId:'m',senderSessionId:'c',recipientSessionId:root,content:{type:'text',text:'Checking'}}),
  frame({sessionUpdate:'session_message',messageId:'m',content:[{type:'text',text:'Checked'}]}),
 ]);
 expect(answer).toBe('');expect(rows.at(-1)).toMatchObject({agentId:'c',text:'Checked'});
});

it('keeps unchanged historical roster snapshots out of a later turn',async()=>{
 const {AcpSubagents}=await import('../server/acp-subagents');
 const rows:any[]=[],tracker=new AcpSubagents('codebuddy',row=>rows.push(row),()=>{});
 tracker.bind(root);
 const members=[{name:'Old',sessionId:'previous',status:'completed'}];
 tracker.handle(root,team('qa',members).update as any);
 tracker.begin('next');
 tracker.handle(root,team('qa',[...members,{name:'New',sessionId:'current',status:'running'}]).update as any);
 expect(rows.map(row=>row.agentId)).toEqual(['current']);
});
it('retains the most recent timestamped CodeBuddy lifecycle state during replay',async()=>{
 const snap=(status:string,updatedAt:number)=>frame({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/subagent':{
  version:1,sessionId:'c',rootSessionId:root,parentSessionId:root,parentToolCallId:'tool',status,updatedAt}}});
 const {rows}=await replay('codebuddy',[snap('running',1),snap('completed',10),snap('running',2)]);
 expect(rows.at(-1)?.status).toBe('completed');
});

it('isolates late child traffic until its parent explicitly addresses it in a new turn',async()=>{
 const {AcpSubagents}=await import('../server/acp-subagents');
 const rows:any[]=[],tracker=new AcpSubagents('claude',row=>rows.push(row),()=>{});
 tracker.bind(root);tracker.begin('t1');
 tracker.handle(root,{sessionUpdate:'subagent_update',sessionId:'child',title:'Review'});
 tracker.begin('');tracker.begin('t2');
 tracker.handle('child',text('late') as any);
 expect(tracker.owner('child',{})).toBeNull();
 expect(rows).toHaveLength(1);
 tracker.handle(root,{sessionUpdate:'session_message',senderSessionId:root,recipientSessionId:'child',messageId:'new',content:[{type:'text',text:'Review the next revision'}]});
 tracker.handle('child',text('current') as any);tracker.flush();
 expect(rows.at(-1)).toMatchObject({agentId:'child',text:'current'});
 expect(rows.at(-1).id).toContain('t2');expect(JSON.stringify(rows)).not.toContain('late');
});
it('preserves explicit clears of ACP metadata, message content and reported activity',async()=>{
 const {rows}=await replay('claude',[
  frame({sessionUpdate:'subagent_update',sessionId:'c',title:'Reviewer',description:'Audit',state:{state:'running'}}),
  frame({sessionUpdate:'session_message',senderSessionId:'c',messageId:'m',content:[{type:'text',text:'Preliminary'}]}),
  frame({sessionUpdate:'subagent_update',sessionId:'c',title:null,description:null,state:{state:'unknown'}}),
  frame({sessionUpdate:'session_message',messageId:'m',content:[]}),
 ]);
 expect(rows.at(-1)).toMatchObject({agentId:'c',name:null,task:null,status:'unknown',text:''});
});
it('links a CodeBuddy team roster back to the dispatch before its later child snapshot',async()=>{
 const {rows}=await replay('codebuddy',[
  frame({sessionUpdate:'tool_call',toolCallId:'dispatch',title:'Run',_meta:{'codebuddy.ai/isSubagent':true}}),
  team('qa',[{name:'Reviewer',sessionId:'c',parentToolCallId:'dispatch',status:'running'}]),
  frame({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/subagent':{version:1,sessionId:'c',rootSessionId:root,parentSessionId:root,parentToolCallId:'dispatch',status:'completed'}}}),
 ]);
 expect(new Set(rows.map(r=>r.id)).size).toBe(1);expect(rows.at(-1)).toMatchObject({agentId:'c',name:'Reviewer',status:'completed'});
});
it('scopes CodeBuddy legacy parent-tool streaming and native team member permission metadata',async()=>{
 const {rows,answer,approvals,decisions}=await replay('codebuddy',[
  frame({sessionUpdate:'tool_call',toolCallId:'dispatch',title:'Run',_meta:{'codebuddy.ai/isSubagent':true}}),
  team('qa',[{name:'Reviewer',sessionId:'c',parentToolCallId:'dispatch',status:'running'}]),
  frame(text('child',{'codebuddy.ai/parentToolCallId':'dispatch'})),
  frame(text('untrusted',{'codebuddy.ai/parentToolCallId':'foreign'})),
  frame(text('root')),
 ],[{id:root,meta:{'codebuddy.ai/isTeamMember':true,'codebuddy.ai/memberName':'Reviewer'}},
  {id:root,meta:{'codebuddy.ai/isTeamMember':true,'codebuddy.ai/memberName':'unknown'}}]);
 expect(answer).toBe('root');expect(rows.at(-1)).toMatchObject({agentId:'c',text:'child'});
 expect(approvals.map(a=>a.params.nativeSubagentId)).toEqual(['c']);
 expect(decisions.map(d=>d.outcome.outcome)).toEqual(['selected','cancelled']);
});
