import { expect, it } from "vitest";
import type { DisplayEvent } from "../shared/types";
import { groupChatTurns } from "../src/chatTurns";
import { presentRun } from "../src/runView";

const event = (id: number, kind: DisplayEvent["kind"], data: unknown, seconds = id): DisplayEvent => ({
  id, kind, data, conversationId: "c", createdAt: new Date(seconds * 1000).toISOString(),
});

it('keeps an active turn running when a different input is queued behind it',()=>{
 const turn=groupChatTurns([
  event(1,'user',{text:'Current request',runId:'current',queuedInputId:'current-input'}),
  event(2,'status',{status:'running',runId:'current'}),
  event(3,'metadata',{queuedInputId:'next-input',state:'queued'}),
  event(4,'text',{text:'Still working',runId:'current'}),
  event(5,'metadata',{execution:'queued',queuedInputId:'next-input',reason:'directory'}),
  event(6,'metadata',{execution:'queued',runId:'another-run',reason:'directory'}),
 ])[0];
 expect(presentRun(turn).status).toBe('running');
});

it("separates progress from all final answer blocks using native message phases", () => {
  const run = presentRun(groupChatTurns([
    event(1, "user", { text: "Inspect" }),
    event(2, "text", { itemId: "intro", text: "Checking" }),
    event(3, "tool", { method: "item/completed", params: { item: { id: "intro", type: "agentMessage", text: "Checking", phase: "commentary" } } }),
    event(4, "text", { itemId: "answer-a", text: "Result" }),
    event(5, "tool", { method: "item/completed", params: { item: { id: "answer-a", type: "agentMessage", text: "Result", phase: "final_answer" } } }),
    event(6, "text", { itemId: "answer-b", text: "Evidence" }),
    event(7, "tool", { method: "item/completed", params: { item: { id: "answer-b", type: "agentMessage", text: "Evidence", phase: "final_answer" } } }),
    event(8, "status", { status: "idle" }),
  ])[0]);
  expect(run.answers.map(m => m.text)).toEqual(["Result", "Evidence"]);
  expect(run.progress.map(m => m.text)).toEqual(["Checking"]);
});

it("measures the user wait without summing parallel tools or background task time", () => {
  const run = presentRun(groupChatTurns([
    event(1, "metadata", { execution: "started", runId: "r" }, 0),
    event(2, "user", { text: "Inspect", runId: "r" }, 1),
    event(3, "tool", { method: "item/started", params: { item: { id: "a", type: "commandExecution" } } }, 2),
    event(4, "tool", { method: "item/started", params: { item: { id: "b", type: "commandExecution" } } }, 3),
    event(5, "tool", { method: "item/completed", params: { item: { id: "a", type: "commandExecution", status: "completed", durationMs: 5000 } } }, 7),
    event(6, "tool", { method: "item/completed", params: { item: { id: "b", type: "commandExecution", status: "completed", durationMs: 5000 } } }, 8),
    event(7, "text", { text: "Done" }, 9),
    event(8, "status", { status: "idle" }, 10),
    event(9, "metadata", { systemTask: "title", status: "running" }, 11),
    event(10, "metadata", { systemTask: "title", status: "completed" }, 20),
  ]).find(t => t.messages.some(m => m.kind === "user"))!);
  expect(run.durationMs).toBe(10000);
  expect(run.operations).toHaveLength(2);
  expect(run.background).toHaveLength(1);
  expect(run.maxParallel).toBe(2);
});

it("does not label interrupted or truncated output a final answer", () => {
  for (const status of ["interrupted", "idle"]) {
    const run = presentRun(groupChatTurns([
      event(1, "user", { text: "Inspect" }),
      event(2, "text", { itemId: "reply", text: "Partial" }),
      event(3, "tool", { method: "item/completed", params: { item: { id: "reply", type: "agentMessage", text: "Partial", stopReason: status === "idle" ? "length" : "aborted" } } }),
      event(4, "status", { status }),
    ])[0]);
    expect(run.answers).toEqual([]);
    expect(run.progress.map(m => m.text)).toEqual(["Partial"]);
    expect(run.incomplete).toBe(true);
  }
});

it("recovers authoritative message snapshots without duplicating streamed text or reasoning", () => {
  const run = presentRun(groupChatTurns([
    event(1, "user", { text: "Inspect" }),
    event(2, "tool", { method: "item/reasoning/textDelta", params: { itemId: "reason", delta: "Inspecting" } }),
    event(3, "tool", { method: "item/completed", params: { item: { id: "reason", type: "reasoning", content: ["Inspecting"], summary: [] } } }),
    event(4, "text", { itemId: "reply", text: "Do" }),
    event(5, "tool", { method: "item/completed", params: { item: { id: "reply", type: "agentMessage", text: "Done", phase: "final_answer" } } }),
    event(6, "tool", { method: "item/completed", params: { item: { id: "evidence", type: "agentMessage", text: "Evidence", phase: "final_answer" } } }),
    event(7, "status", { status: "idle" }),
  ])[0]);
  expect(run.answers.map(m => m.text)).toEqual(["Done", "Evidence"]);
  expect(run.reasoning.map(([, text]) => text)).toEqual(["Inspecting"]);
});

it("keeps late background tasks on their source turn after another user message", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "First", runId: "first" }),
    event(2, "text", { text: "One", runId: "first" }),
    event(3, "status", { status: "idle", runId: "first" }),
    event(4, "user", { text: "Second", runId: "second" }),
    event(5, "metadata", { systemTask: "title", status: "running", sourceEventId: 2 }),
    event(6, "metadata", { systemTask: "title", status: "completed", sourceEventId: 2 }),
    event(7, "status", { status: "running", runId: "second" }),
  ]);
  expect(presentRun(turns[0]).background).toHaveLength(1);
  expect(presentRun(turns[1]).background).toHaveLength(0);
  expect(presentRun(turns[0]).status).toBe("idle");
});

it("keeps failed startup separate from a previously completed turn and measures approval pauses", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "First", runId: "first" }, 0),
    event(2, "status", { status: "approval", runId: "first" }, 1),
    event(3, "status", { status: "running", runId: "first" }, 3),
    event(4, "text", { text: "Done", runId: "first" }, 4),
    event(5, "status", { status: "idle", runId: "first" }, 5),
    event(6, "metadata", { execution: "started", runId: "second" }, 6),
    event(7, "error", { message: "Runtime failed to start" }, 7),
    event(8, "status", { status: "error" }, 8),
  ]);
  expect(turns).toHaveLength(2);
  expect(presentRun(turns[0]).approvalMs).toBe(2000);
  expect(presentRun(turns[0]).answers.map(m => m.text)).toEqual(["Done"]);
  expect(presentRun(turns[1]).incomplete).toBe(true);
});

it("keeps an unclassified reply in recent output before and after tool work begins", () => {
  const events = [event(1, "user", { text: "Inspect" }), event(2, "status", { status: "running" }),
    event(3, "text", { itemId: "reply", text: "Checking the sample" })];
  expect(presentRun(groupChatTurns(events)[0]).answers).toEqual([]);
  expect(presentRun(groupChatTurns(events)[0]).progress.map(m => m.text)).toEqual(["Checking the sample"]);
  events.push(event(4, "tool", { method: "item/started", params: { item: { id: "tool", type: "commandExecution", status: "inProgress" } } }));
  expect(presentRun(groupChatTurns(events)[0]).answers).toEqual([]);
});

it("does not discard a recovered final reply because an earlier model response was truncated", () => {
  const run = presentRun(groupChatTurns([
    event(1, "user", { text: "Inspect" }),
    event(2, "tool", { method: "item/completed", params: { item: { id: "truncated", type: "agentMessage", text: "Partial", stopReason: "length" } } }),
    event(3, "tool", { method: "item/completed", params: { item: { id: "recovered", type: "agentMessage", text: "Recovered", stopReason: "stop", phase: "final_answer" } } }),
    event(4, "status", { status: "idle" }),
  ])[0]);
  expect(run.answers.map(m => m.text)).toEqual(["Recovered"]);
  expect(run.progress.map(m => m.text)).toEqual(["Partial"]);
});

it.each([".", "...", "…", " ⋯ \n"])("omits punctuation-only tool-call preambles %j without changing stored text or final answers", text => {
  const events = [
    event(1, "user", {text:"Inspect a synthetic setting"}),
    event(2, "text", {itemId:"placeholder",text}),
    event(3, "tool", {method:"item/completed",params:{item:{id:"placeholder",type:"agentMessage",text,stopReason:"toolUse"}}}),
    event(4, "tool", {method:"item/completed",params:{item:{id:"read",type:"commandExecution",command:"inspect",status:"completed"}}}),
    event(5, "tool", {method:"item/completed",params:{item:{id:"progress",type:"agentMessage",text:"Setting found.",stopReason:"toolUse"}}}),
    event(6, "tool", {method:"item/completed",params:{item:{id:"answer",type:"agentMessage",text:"...",stopReason:"stop"}}}),
    event(7, "status", {status:"idle"}),
  ];
  const turn = groupChatTurns(events)[0];
  const run = presentRun(turn);
  expect(run.progress.map(m=>m.text)).toEqual(["Setting found."]);
  expect(run.answers.map(m=>m.text)).toEqual(["..."]);
  expect(turn.messages.some(m=>m.text===text)).toBe(true);
  expect(run.operations[0].item.command).toBe("inspect");
});

it('interleaves reports, commentary, operations and errors at first observation without moving completed tools', () => {
  const events = [event(1,'user',{text:'检查',runId:'r'}),
    event(2,'tool',{method:'item/started',params:{item:{id:'a',type:'commandExecution',command:'inspect',status:'inProgress'}}}),
    event(3,'progress',{text:'已开始检查',runId:'r',source:'cli',steps:[{text:'检查',status:'running'}]}),
    event(4,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'公开补充'}}}),
    event(5,'error',{message:'检查失败'})];
  const before = presentRun(groupChatTurns(events)[0]);
  events.push(event(6,'tool',{method:'item/completed',params:{item:{id:'a',type:'commandExecution',command:'inspect',status:'completed',aggregatedOutput:'done'}}}));
  const after = presentRun(groupChatTurns(events)[0]);
  expect(after.timeline.map(item=>item.kind)).toEqual(['operation','progress','message','error']);
  expect(after.timeline.map(item=>item.key)).toEqual(before.timeline.map(item=>item.key));
  expect(after.timeline[0]).toMatchObject({operation:{status:'completed',output:'done'}});
});

it('links the report technical call only by its explicit returned event ID and retains identical commentary',()=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'check',runId:'r'}),
  event(2,'tool',{method:'item/started',params:{item:{id:'report',type:'commandExecution',status:'inProgress'}}}),
  event(3,'progress',{text:'Checking',runId:'r',source:'cli',commandKey:'k'}),
  event(4,'tool',{method:'item/completed',params:{item:{id:'report',type:'commandExecution',status:'completed',aggregatedOutput:JSON.stringify({ok:true,command:'progress report',commandKey:'k',data:{id:3,kind:'progress',data:{commandKey:'k'}}})}}}),
  event(5,'tool',{method:'item/completed',params:{item:{id:'native',type:'agentMessage',phase:'commentary',text:'Checking'}}}),
  event(6,'tool',{method:'item/completed',params:{item:{id:'other',type:'commandExecution',command:'progress report',status:'completed',aggregatedOutput:'Checking'}}}),
  event(7,'tool',{method:'item/completed',params:{item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Done'}}}),event(8,'status',{status:'idle'})])[0]);
 expect(run.timeline.map(item=>item.kind)).toEqual(['progress','message','operation']);
 expect(run.timeline[0]).toMatchObject({technicalOperation:{item:{id:'report'}},progress:{text:'Checking',historical:true}});
 expect(run.answers.map(item=>item.text)).toEqual(['Done']);
});

it.each(['idle','interrupted','error'])('keeps %s reports historical and does not carry them into the next run',status=>{
 const turns=groupChatTurns([event(1,'user',{text:'first',runId:'r1'}),event(2,'progress',{text:'first report',source:'cli',runId:'r1'}),event(3,'status',{status,runId:'r1'}),event(4,'user',{text:'second',runId:'r2'}),event(5,'status',{status:'running',runId:'r2'})]);
 expect(presentRun(turns[0]).timeline[0]).toMatchObject({kind:'progress',progress:{historical:true,runId:'r1'}});
 expect(presentRun(turns[1]).timeline).toEqual([]);
});

it('positions public reasoning summaries, plans and approval requests in observed order',()=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'Inspect',runId:'r'}),event(2,'tool',{method:'item/reasoning/summaryTextDelta',params:{itemId:'reason',delta:'Public summary'}}),event(3,'tool',{method:'item/started',params:{item:{id:'plan',type:'plan',text:'Actual plan',status:'inProgress'}}}),event(4,'approval',{method:'item/commandExecution/requestApproval',params:{itemId:'plan'}}),event(5,'tool',{method:'item/completed',params:{item:{id:'reason',type:'reasoning',summary:['Public summary final']}}})])[0]);
 expect(run.timeline.map(item=>item.kind)).toEqual(['reasoning','operation','approval']);
 expect(run.timeline[0]).toMatchObject({text:'Public summary final'});
});
it('keeps ordinary structured tool results without treating their content field as a progress receipt envelope',()=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'Inspect'}),event(2,'tool',{method:'item/completed',params:{item:{id:'ordinary',type:'dynamicToolCall',tool:'inspect',status:'completed',result:{content:{title:'Ordinary result'}}}}})])[0]);
 expect(run.timeline.map(item=>item.kind)).toEqual(['operation']);
});
it.each([
 {content:[{type:'text',text:'{"ok":true,"command":"progress report","commandKey":"k","data":{"id":3,"kind":"progress"}}\n\n\nWall time: 0.79 seconds'}],details:{timeoutSeconds:300,wallTimeMs:788}},
 {output:'{"ok":true,"command":"progress report","commandKey":"k","data":{"id":3,"kind":"progress"}}\n',metadata:{exit:0,truncated:false}},
])('correlates real adapter receipt envelopes by event ID even with execution metadata: %j',result=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'Inspect',runId:'r'}),event(2,'tool',{method:'item/started',params:{item:{id:'report',type:'mcpToolCall',tool:'bash',status:'inProgress'}}}),event(3,'progress',{text:'Checking',runId:'r',source:'cli'}),event(4,'tool',{method:'item/completed',params:{item:{id:'report',type:'mcpToolCall',tool:'bash',status:'completed',result}}})])[0]);
 expect(run.timeline.map(item=>item.kind)).toEqual(['progress']);
 expect(run.timeline[0]).toMatchObject({progress:{sourceEventId:3},technicalOperation:{item:{id:'report'}}});
});

it('keeps a report call anchored before intervening commentary after its receipt arrives',()=>{
 const events=[event(1,'user',{text:'Inspect',runId:'r'}),event(2,'tool',{method:'item/started',params:{item:{id:'report',type:'commandExecution',status:'inProgress'}}}),event(3,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Native observation'}}}),event(4,'progress',{text:'Explicit report',source:'cli',runId:'r'})];
 const before=presentRun(groupChatTurns(events)[0]);
 events.push(event(5,'tool',{method:'item/completed',params:{item:{id:'report',type:'commandExecution',status:'completed',aggregatedOutput:'{"ok":true,"command":"progress report","data":{"id":4,"kind":"progress"}}'}}}));
 const after=presentRun(groupChatTurns(events)[0]);
 expect(after.timeline.map(item=>item.key)).toEqual([before.timeline[0].key,before.timeline[1].key]);
 expect(after.timeline.map(item=>item.kind)).toEqual(['progress','message']);
 expect(after.timeline[0]).toMatchObject({progress:{sourceEventId:4,updatedAt:'1970-01-01T00:00:04.000Z'},technicalOperation:{status:'completed'}});
});


it.each(['running','approval'])('keeps unphased output out of final answers while %s even between tools',status=>{
 const events=[event(1,'user',{text:'Check',runId:'r'}),event(2,'status',{status}),event(3,'text',{itemId:'a',text:'I will check the source'}),event(4,'tool',{method:'item/completed',params:{item:{id:'read',type:'mcpToolCall',status:'completed'}}})];
 const run=presentRun(groupChatTurns(events)[0]);
 expect(run.answers).toEqual([]);expect(run.progress.map(m=>m.text)).toEqual(['I will check the source']);
});
it('confirms only the last unphased message after normal end while retaining earlier process output',()=>{
 const events=[event(1,'user',{text:'Check'}),event(2,'status',{status:'running'}),event(3,'text',{itemId:'intro',text:'Checking the source'}),event(4,'tool',{method:'item/completed',params:{item:{id:'read',type:'mcpToolCall',status:'completed'}}}),event(5,'text',{itemId:'answer',text:'Verified result'})];
 const before=presentRun(groupChatTurns(events)[0]);expect(before.answers).toEqual([]);expect(before.progress.map(m=>m.text)).toEqual(['Checking the source','Verified result']);
 const after=presentRun(groupChatTurns([...events,event(6,'status',{status:'idle'})])[0]);expect(after.answers.map(m=>m.text)).toEqual(['Verified result']);expect(after.progress.map(m=>m.text)).toEqual(['Checking the source']);
});
it('streams explicit native answer phases without treating stable answer text as commentary',()=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'Check'}),event(2,'status',{status:'running'}),event(3,'tool',{method:'item/started',params:{item:{id:'answer',type:'agentMessage',phase:'partial_answer',text:''}}}),event(4,'text',{itemId:'answer',text:'Stable answer'})])[0]);
 expect(run.answers.map(m=>m.text)).toEqual(['Stable answer']);expect(run.progress).toEqual([]);
});
it('assembles the latest output across interleaved tool events and uses the authoritative completion snapshot',()=>{
 const events=[event(1,'user',{text:'Check',runId:'r'}),event(2,'status',{status:'running'}),event(3,'text',{itemId:'a',text:'Checking '}),event(4,'tool',{method:'item/started',params:{item:{id:'read',type:'commandExecution',status:'inProgress'}}}),event(5,'text',{itemId:'a',text:'source'})];
 expect(presentRun(groupChatTurns(events)[0]).latestProgress?.text).toBe('Checking source');
 expect(presentRun(groupChatTurns(events)[0]).progress.map(message=>message.text)).toEqual(['Checking source']);
 events.push(event(6,'tool',{method:'item/completed',params:{item:{id:'a',type:'agentMessage',phase:'commentary',text:'Checking authoritative source'}}}));
 expect(presentRun(groupChatTurns(events)[0]).latestProgress).toMatchObject({text:'Checking authoritative source',source:'commentary',sourceEventId:6});
});
it('keeps one authoritative final answer when its deltas are interleaved with a tool',()=>{
 const run=presentRun(groupChatTurns([event(1,'user',{text:'Check'}),event(2,'tool',{method:'item/started',params:{item:{id:'a',type:'agentMessage',phase:'final_answer',text:''}}}),event(3,'text',{itemId:'a',text:'Verified '}),event(4,'tool',{method:'item/completed',params:{item:{id:'read',type:'mcpToolCall',status:'completed'}}}),event(5,'text',{itemId:'a',text:'result'}),event(6,'tool',{method:'item/completed',params:{item:{id:'a',type:'agentMessage',phase:'final_answer',text:'Verified result'}}})])[0]);
 expect(run.answers.map(message=>message.text)).toEqual(['Verified result']);expect(run.progress).toEqual([]);
});
