import { expect, it } from "vitest";
import { groupChatTurns, mergeChatEvents } from "../src/chatTurns";
import { summarizeOperations } from "../src/execution";
import type { DisplayEvent } from "../shared/types";

const event = (id: number, kind: DisplayEvent["kind"], data: unknown): DisplayEvent => ({
  id,
  conversationId: "personal",
  kind,
  data,
  createdAt: "2026-10-01",
});

it('shows saved Agent replies with their own source and keeps native reply prompts out of user messages',()=>{
 const messages=groupChatTurns([
  event(1,'user',{text:'Original request'}),
  event(2,'metadata',{agentMessage:{id:'m',direction:'reply',text:'Question',reply:'Confirmed',replyState:'parked',autoResumeAllowed:false,sourceConversationId:'a',targetConversationId:'b'}}),
  event(3,'user',{text:'Private native reply context',agentMessage:{id:'m',direction:'reply',sourceRequestEventId:1}}),
 ]).flatMap(t=>t.messages);
 expect(messages.filter(m=>m.kind==='user')).toHaveLength(1);
 expect(messages.find(m=>m.agentMessage?.direction==='reply')).toMatchObject({text:'Confirmed',agentMessage:{id:'m',replyState:'parked'}});
 expect(messages.some(m=>m.text==='Private native reply context')).toBe(false);
});

it('updates the original inquiry status when its reply has been consumed',()=>{
 const messages=groupChatTurns([
  event(1,'metadata',{agentMessage:{id:'m',direction:'sent',text:'Question',replyState:'pending',autoResumeAllowed:true}}),
  event(2,'metadata',{agentMessage:{id:'m',direction:'reply',text:'Question',reply:'Answer',replyState:'consumed',autoResumeAllowed:true}}),
 ]).flatMap(t=>t.messages);
 expect(messages.find(m=>m.agentMessage?.direction==='sent')?.agentMessage?.replyState).toBe('consumed');
 expect(messages.filter(m=>m.kind==='agent_message')).toHaveLength(2);
 expect(messages.find(m=>m.kind==='agent_message')?.key).toBe(1);
 expect(messages.find(m=>m.agentMessage?.direction==='reply')).toMatchObject({key:2,text:'Answer'});
});

it('updates the original delegation and presents a late reply after intervening human input',()=>{
 const turns=groupChatTurns([event(1,'user',{text:'First request'}),event(2,'metadata',{agentMessage:{id:'first',direction:'sent',text:'Question',state:'queued'}}),event(3,'user',{text:'Second request'}),event(4,'metadata',{agentMessage:{id:'first',direction:'sent',text:'Question',state:'running'}}),event(5,'metadata',{agentMessage:{id:'first',direction:'reply',reply:'Evidence',state:'succeeded',replyState:'parked'}})]);
 expect(turns[0].messages.find(m=>m.kind==='agent_message')).toMatchObject({key:2,agentMessage:{state:'succeeded',reply:'Evidence',replyState:'parked'}});
 expect(turns[1].messages.filter(m=>m.kind==='agent_message')).toHaveLength(0);
 expect(turns[2].messages).toMatchObject([{key:5,kind:'agent_message',text:'Evidence',agentMessage:{direction:'reply'}}]);
});

it('keeps native output with its run and deduplicates later status updates to a background reply',()=>{
 const reply={id:'m',direction:'reply',reply:'Evidence',state:'succeeded',replyState:'queued'};
 const turns=groupChatTurns([
  event(1,'user',{text:'First request',runId:'first'}),
  event(2,'metadata',{agentMessage:{id:'m',direction:'sent',text:'Question',state:'running'}}),
  event(3,'user',{text:'Another topic',runId:'second'}),
  event(4,'metadata',{agentMessage:reply}),
  event(5,'text',{text:'Second answer',runId:'second'}),
  event(6,'metadata',{agentMessage:{...reply,replyState:'consumed'}}),
  event(7,'status',{status:'idle',runId:'second'}),
 ]);
 expect(turns[1].messages.map(m=>m.text)).toEqual(['Another topic','Second answer']);
 expect(turns[2].messages).toMatchObject([{key:4,text:'Evidence',agentMessage:{direction:'reply',replyState:'consumed'}}]);
 expect(turns.flatMap(t=>t.messages).filter(m=>m.agentMessage?.direction==='reply')).toHaveLength(1);
});

it('places a stopped inquiry reply at its actual answer rather than an earlier empty status event',()=>{
 const message={id:'stopped',text:'Question',state:'running',reply:null,replyState:'parked'};
 const before=[event(1,'user',{text:'Ask the Agent'}),event(2,'metadata',{agentMessage:{...message,direction:'sent'}}),event(3,'metadata',{agentMessage:{...message,direction:'reply'}})];
 expect(groupChatTurns(before).flatMap(t=>t.messages).filter(m=>m.agentMessage?.direction==='reply')).toHaveLength(0);
 const turns=groupChatTurns([...before,event(4,'user',{text:'Another topic'}),event(5,'metadata',{agentMessage:{...message,direction:'reply',state:'succeeded',reply:'Late evidence'}})]);
 expect(turns[1].messages.map(m=>m.text)).toEqual(['Another topic']);
 expect(turns[2].messages).toMatchObject([{key:5,text:'Late evidence',agentMessage:{direction:'reply'}}]);
});

it('retains exact selected reference metadata with the user message, without displaying native instructions as user text', () => {
  const referenceItems = [{ id: 'skill:exact', kind: 'skill', name: 'review', source: 'Project · Personal', detail: '/synthetic/SKILL.md', status: 'available' }];
  const message = groupChatTurns([event(1, 'user', { text: 'Review this', nativeText: 'Private resolved instructions', referenceItems })])[0].messages[0];
  expect(message).toMatchObject({ text: 'Review this', referenceItems });
  expect(message).not.toHaveProperty('nativeText');
});

it("batches replay without duplicates and applies history replacements in event order", () => {
  const previous = [event(1, "user", { text: "Original" }), event(2, "text", { text: "Old reply" }), event(3, "status", { status: "idle" })];
  expect(mergeChatEvents(previous, previous)).toBe(previous);
  const incoming = [event(4, "metadata", { historyReplacedFrom: 2 }), event(5, "text", { text: "New reply" }), event(5, "text", { text: "Duplicate" }), event(6, "metadata", { historyReplacedFrom: 5 }), event(7, "text", { text: "Final reply" })];
  const next = mergeChatEvents(previous, incoming);
  expect(next.map(item => item.id)).toEqual([1, 4, 6, 7]);
  expect(groupChatTurns(next)[0].messages.map(message => message.text)).toEqual(["Original", "Final reply"]);
  expect(previous.map(item => item.id)).toEqual([1, 2, 3]);
});

it("preserves internal receipt identity while keeping native prompt boundaries", () => {
  const task = { id: "receipt", kind: "return", sourceConversationId: "helper" };
  const turns = groupChatTurns([event(1, "user", { text: "Original goal" }), event(2, "text", { text: "First answer" }),
    event(3, "user", { text: "Helper result", task }), event(4, "text", { text: "Synthesized answer" })]);
  expect(turns).toHaveLength(2);
  expect(turns[0].messages[0]).not.toHaveProperty("task");
  expect(turns[1].messages[0]).toMatchObject({ text: "Helper result", task });
});

it("keeps_each_user_request_with_its_reply_errors_and_execution_events", () => {
  const events = [
    event(1, "user", { text: "Read the personal list" }),
    event(2, "tool", { method: "item/started", params: { turnId: "first" } }),
    event(3, "text", { itemId: "reply", text: "Three entries" }),
    event(4, "status", { status: "idle" }),
    event(5, "user", { text: "Read a missing personal note" }),
    event(6, "tool", { method: "item/completed", params: { turnId: "second" } }),
    event(7, "error", { message: "Note not found" }),
    event(8, "status", { status: "error" }),
  ];
  const turns = groupChatTurns(events);
  expect(turns.map((turn) => turn.key)).toEqual([1, 5]);
  expect(turns.map((turn) => turn.events.map((e) => e.id))).toEqual([
    [1, 2, 3, 4], [5, 6, 7, 8],
  ]);
  expect(turns.map((turn) => turn.messages.map((m) => [m.kind, m.text]))).toEqual([
    [["user", "Read the personal list"], ["text", "Three entries"]],
    [["user", "Read a missing personal note"], ["error", "Note not found"]],
  ]);
  expect(events[2].data).toEqual({ itemId: "reply", text: "Three entries" });
});

it("merges_streaming_chunks_by_item_without_merging_different_replies", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "Summarize the personal list" }),
    event(2, "text", { itemId: "intro", text: "Reading " }),
    event(3, "tool", { method: "item/started", params: {} }),
    event(4, "text", { itemId: "intro", text: "the list" }),
    event(5, "text", { itemId: "answer", text: "Three " }),
    event(6, "text", { itemId: "answer", text: "entries" }),
  ]);
  expect(turns).toHaveLength(1);
  expect(turns[0].messages).toEqual([
    { kind: "user", text: "Summarize the personal list", key: 1, item: undefined },
    { kind: "text", text: "Reading the list", key: 2, item: "intro" },
    { kind: "text", text: "Three entries", key: 5, item: "answer" },
  ]);
});

it("preserves_events_before_the_first_user_message_without_inventing_a_user", () => {
  const turns = groupChatTurns([
    event(1, "error", { message: "Execution interrupted by restart" }),
    event(2, "status", { status: "interrupted" }),
    event(3, "user", { text: "Continue reading" }),
    event(4, "text", { itemId: "reply", text: "Resumed" }),
  ]);
  expect(turns.map((turn) => turn.events.map((e) => e.id))).toEqual([[1, 2], [3, 4]]);
  expect(turns[0].messages.map((m) => m.kind)).toEqual(["error"]);
});

it("does_not_join_reused_item_ids_across_user_requests", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "First request" }),
    event(2, "text", { itemId: "omp-message", text: "First answer" }),
    event(3, "user", { text: "Second request" }),
    event(4, "text", { itemId: "omp-message", text: "Second answer" }),
  ]);
  expect(turns.map((turn) => turn.messages.at(-1)?.text)).toEqual(["First answer", "Second answer"]);
  expect(groupChatTurns([])).toEqual([]);
});

it("keeps assistant text before and after a tool in chronological blocks", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "Inspect the note" }),
    event(2, "text", { itemId: "reply", text: "I will " }),
    event(3, "text", { itemId: "reply", text: "check it." }),
    event(4, "tool", { method: "item/started", params: { turnId: "t", item: { id: "read", type: "commandExecution", command: "cat note.txt" } } }),
    event(5, "tool", { method: "item/commandExecution/outputDelta", params: { turnId: "t", itemId: "read", delta: "note contents" } }),
    event(6, "tool", { method: "item/completed", params: { turnId: "t", item: { id: "read", type: "commandExecution", status: "completed" } } }),
    event(7, "text", { itemId: "reply", text: "The note says " }),
    event(8, "text", { itemId: "reply", text: "hello." }),
  ]);
  expect(turns[0].blocks.map(block => block.kind === "message" ? block.message.text : "execution"))
    .toEqual(["Inspect the note", "I will check it.", "execution", "The note says hello."]);
  expect(turns[0].blocks.find(block => block.kind === "execution")?.events.map(event => event.id)).toEqual([4, 5, 6]);
  expect(turns[0].messages.map(message => message.text)).toEqual(["Inspect the note", "I will check it.", "The note says hello."]);
});

it("updates the initial execution block when completion arrives after an assistant message", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "Inspect" }),
    event(2, "tool", { method: "item/started", params: { turnId: "t", item: { id: "read", type: "commandExecution", command: "cat note.txt" } } }),
    event(3, "text", { itemId: "reply", text: "Still checking." }),
    event(4, "tool", { method: "item/completed", params: { turnId: "t", item: { id: "read", type: "commandExecution", status: "completed" } } }),
    event(5, "metadata", { systemTask: "memory", status: "running" }),
    event(6, "metadata", { systemTask: "memory", status: "completed", count: 2 }),
  ]);
  expect(turns[0].blocks.map(block => block.kind)).toEqual(["message", "execution", "message", "execution"]);
  expect(turns[0].blocks.filter(block => block.kind === "execution").map(block => block.events.map(event => event.id)))
    .toEqual([[2, 4], [5, 6]]);
});

it("associates startup memory loading with the following user request", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "Previous request" }),
    event(2, "text", { text: "Previous answer" }),
    event(3, "status", { status: "idle" }),
    event(4, "status", { status: "running" }),
    event(5, "metadata", { memoryRecall: "recall-1", status: "running", count: 1 }),
    event(6, "metadata", { memoryRecall: "recall-1", status: "completed", count: 1 }),
    event(7, "user", { text: "New request" }),
    event(8, "text", { text: "New answer" }),
  ]);
  expect(turns.map(turn => turn.events.map(event => event.id))).toEqual([[1, 2, 3], [4, 5, 6, 7, 8]]);
  expect(turns[1].blocks.map(block => block.kind === "message" ? block.message.text : "execution"))
    .toEqual(["New request", "execution", "New answer"]);
});

it("updates a background hook in its original turn when it finishes during a later request", () => {
  const turns = groupChatTurns([
    event(1, "user", { text: "First" }),
    event(2, "text", { text: "Done" }),
    event(3, "metadata", { systemTask: "memory", status: "running" }),
    event(4, "user", { text: "Second" }),
    event(5, "metadata", { systemTask: "memory", status: "completed", count: 1 }),
    event(6, "text", { text: "Second answer" }),
  ]);
  expect(turns[0].blocks.filter(block => block.kind === "execution").map(block => block.events.map(event => event.id)))
    .toEqual([[3, 5]]);
  expect(turns[1].blocks.map(block => block.kind)).toEqual(["message", "message"]);
});

it("does not merge reused text item chunks across a later tool completion", () => {
  const turn = groupChatTurns([
    event(1, "user", { text: "Run the check" }),
    event(2, "tool", { method: "item/started", params: { item: { id: "test", type: "commandExecution" } } }),
    event(3, "text", { itemId: "omp-message", text: "The test is running." }),
    event(4, "tool", { method: "item/completed", params: { item: { id: "test", type: "commandExecution", status: "completed" } } }),
    event(5, "text", { itemId: "omp-message", text: "It passed." }),
  ])[0];
  expect(turn.messages.map(message => message.text)).toEqual(["Run the check", "The test is running.", "It passed."]);
  expect(turn.blocks.filter(block => block.kind === "execution")).toHaveLength(1);
});

it("keeps terminal conversation state in execution block events after stopping a streamed tool", () => {
  const turn = groupChatTurns([
    event(1, "status", { status: "running" }),
    event(2, "user", { text: "live-tool-flow" }),
    event(3, "text", { itemId: "intro", text: "Checking the sample" }),
    event(4, "tool", { method: "item/started", params: { turnId: "t", item: { id: "live-command", type: "commandExecution", command: "read sample.txt", status: "inProgress" } } }),
    event(5, "tool", { method: "item/commandExecution/outputDelta", params: { turnId: "t", itemId: "live-command", delta: "reading 1/3\n" } }),
    event(6, "status", { status: "interrupted" }),
  ])[0];
  const block = turn.blocks.find(block => block.kind === "execution")!;
  expect(block.events.map(event => event.id)).toEqual([4, 5, 6]);
  expect(summarizeOperations(block.events)[0]).toMatchObject({ status: "interrupted", output: "reading 1/3\n" });
});

it.each([["interrupted", "interrupted"], ["error", "failed"], ["idle", "unknown"]])(
  "propagates terminal %s to an unfinished native hook without claiming success", (status, expected) => {
    const turn = groupChatTurns([
      event(1, "user", { text: "Trigger native hook" }),
      event(2, "hook", { id: "h", source: "codex", name: "preflight.sh", event: "preToolUse", status: "running" }),
      event(3, "status", { status }),
    ])[0];
    const block = turn.blocks.find(block => block.kind === "execution")!;
    expect(block.events.map(event => event.id)).toEqual([2, 3]);
    expect(summarizeOperations(block.events)[0].status).toBe(expected);
  },
);

it.each(['before-user','after-user'] as const)('keeps real title/memory Hooks with accepted request when startup is %s',order=>{
 const user=event(order==='before-user'?2:1,'user',{text:'Accepted request',runId:'r1'}),started=event(order==='before-user'?1:2,'metadata',{execution:'started',runId:'r1'});
 const turns=groupChatTurns([...(order==='before-user'?[started,user]:[user,started]),event(3,'text',{text:'Actual reply',runId:'r1'}),event(4,'status',{status:'idle',runId:'r1'}),event(5,'metadata',{systemTask:'memory',jobId:'job-r1',status:'completed',count:1}),event(6,'metadata',{systemTask:'title',status:'completed',sourceEventId:3,title:'Actual title'})]);
 expect(turns).toHaveLength(1);expect(turns[0].messages.map(m=>m.text)).toEqual(['Accepted request','Actual reply']);
 expect(summarizeOperations(turns[0].events).filter(op=>op.item.hook?.source==='platform').map(op=>op.item.hook&&'task' in op.item.hook?op.item.hook.task:undefined)).toEqual(['memory','title']);
});
it('moves source-event ownership with native events and keeps delayed background completions on their own request',()=>{
 const turns=groupChatTurns([event(1,'user',{text:'First',runId:'r1'}),event(2,'metadata',{execution:'started',runId:'different-start'}),event(3,'text',{text:'First answer',runId:'r1'}),event(4,'user',{text:'Second',runId:'r2'}),event(5,'metadata',{execution:'started',runId:'r2'}),event(6,'text',{text:'Second answer',runId:'r2'}),event(7,'metadata',{systemTask:'title',sourceEventId:3,status:'completed',title:'First actual title'}),event(8,'metadata',{systemTask:'memory',jobId:'first-job',sourceEventId:3,status:'completed',count:2}),event(9,'metadata',{systemTask:'memory',jobId:'second-job',runId:'r2',status:'completed',count:1})]);
 const first=turns.find(t=>t.messages.some(m=>m.text==='First'))!,second=turns.find(t=>t.messages.some(m=>m.text==='Second'))!;
 expect(first.events.map(e=>e.id)).toEqual([1,3,7,8]);expect(second.events.map(e=>e.id)).toEqual([4,5,6,9]);
 expect(turns.find(t=>t.events.some(e=>e.id===2))!.events.map(e=>e.id)).toEqual([2]);
});
it('preserves nonhuman queued input provenance for distinct message presentation',()=>{
 const source={kind:'coordination' as const,receiptIds:['receipt']};
 const turns=groupChatTurns([event(1,'user',{text:'Child report',source})]);
 expect(turns[0].messages[0]).toMatchObject({source});
});
