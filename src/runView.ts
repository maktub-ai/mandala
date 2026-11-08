import type { Approval, DisplayEvent } from "../shared/types";
import type {ApprovalDecision} from '../shared/approvals';
import {describeOperation,groupActivity,type OperationPresentation} from './activity-presentation';
import type { ExplicitProgress } from "../shared/conversation-progress";
import type { ChatMessage } from "../shared/chat-turns";
import type { ChatTurn } from "./chatTurns";
import {presentTurnText} from '../shared/conversation-output';
import { summarizeOperations, type NativeItem, type Operation } from "./execution";

type RunEventData = {
  status?: string; execution?: string; systemTask?: string; method?: string;
  cli?: string;
  state?:string;reason?:string;queuedInputId?:string;runId?:string;
  params?: { turn?: { durationMs?: number }; itemId?: string; delta?: string;
    item?: NativeItem & { phase?: string; stopReason?: string; summary?: string[]; content?: string[] } };
};

export type RunOperation = Operation & {
  presentation: OperationPresentation;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  timingSource: "native" | "observed" | "unknown";
};
export type RunApproval={
  request:Approval;
  state:'pending'|'approved'|'rejected'|'resolved'|'unknown';
  decision?:ApprovalDecision;
};
export type RunTimelineItem =
  | {kind:"operation";key:string;operation:RunOperation}
  | {kind:"progress";key:string;progress:ExplicitProgress;technicalOperation?:RunOperation}
  | {kind:"message";key:string;message:ChatMessage}
  | {kind:"error";key:string;message:ChatMessage}
  | {kind:"reasoning";key:string;text:string}
  | {kind:"approval";key:string;event:DisplayEvent;approval:RunApproval};

// A report receipt is identity, never a guess based on command wording or prose.
function returnedProgressId(operation:RunOperation):number|undefined {
  const candidates:unknown[]=[operation.item.result,operation.output];
  const result=operation.item.result as {output?:unknown;content?:{text?:string}[]}|undefined;
  if(typeof result?.output==='string')candidates.push(result.output);
  if(Array.isArray(result?.content))for(const part of result.content)if(part?.text)candidates.push(part.text);
  for(let value of candidates.flatMap(value=>typeof value==='string'?[value,...value.split(/\r?\n/)]:[value])){
    if(typeof value==='string'){try{value=JSON.parse(value);}catch{continue;}}
    if(value&&typeof value==='object'&&(value as {command?:string}).command==='progress report')value=(value as {data?:unknown}).data;
    if(value&&typeof value==='object'){
      const receipt=value as {id?:number;kind?:string};
      if(receipt.kind==='progress'&&typeof receipt.id==='number')return receipt.id;
    }
  }
}
export function eventTime(event: DisplayEvent | undefined) {
  const time = event ? Date.parse(event.createdAt) : NaN;
  return Number.isFinite(time) ? time : undefined;
}
export function presentRun(turn: ChatTurn) {
  let cli: string | undefined;
  const reasoning = new Map<string, string>();
  let terminal: DisplayEvent | undefined;
  let status = "running";
  let queueReason:string|undefined;
  let nativeDuration: number | undefined;
  let approvalStarted: number | undefined;
  let approvalMs = 0;
  for (const event of turn.events) {
    const data = event.data as RunEventData;
    if(event.kind==='metadata'&&!data.systemTask&&['loaded','applying'].includes(data.status??'')&&typeof data.cli==='string')cli=data.cli;
    if(event.kind==='metadata'&&(data.execution==='queued'||data.state==='queued')&&turn.events.some(e=>{
      const user=e.data as RunEventData;
      return e.kind==='user'&&(data.queuedInputId&&data.queuedInputId===user.queuedInputId||data.runId&&data.runId===user.runId);
    })){
      status='queued';queueReason=data.reason;
    }
    if(event.kind==='metadata'&&data.execution==='started'){status='running';queueReason=undefined;terminal=undefined;}
    if (event.kind === "status") {
      status = data.status ?? status;
      queueReason=undefined;
      const time = eventTime(event);
      if (status === "approval" && approvalStarted === undefined) approvalStarted = time;
      else if (status !== "approval" && approvalStarted !== undefined && time !== undefined) {
        approvalMs += Math.max(0, time - approvalStarted);
        approvalStarted = undefined;
      }
      if (["idle", "error", "interrupted"].includes(status)) terminal = event;
    }
    if (event.kind !== "tool") continue;
    const { method, params: p = {} } = data;
    if (method === "turn/completed" && typeof p.turn?.durationMs === "number" && Number.isFinite(p.turn.durationMs) && p.turn.durationMs >= 0) nativeDuration = p.turn.durationMs;
    const item = p.item;
    if (item?.type === "reasoning") {
      const text = item.summary?.length ? item.summary.join("\n\n") : item.content?.join("\n\n");
      if (text) {
        reasoning.delete(`${item.id}:content`);
        reasoning.delete(`${item.id}:summary`);
        reasoning.set(item.id, text);
      }
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const key = `${p.itemId}:${method.includes("summary") ? "summary" : "content"}`;
      reasoning.set(key, (reasoning.get(key) ?? "") + (p.delta ?? ""));
    }
  }
  const summarized = summarizeOperations(turn.events);
  const isBackground = (op: Operation) => op.item.hook?.source === "platform" && op.item.hook.event === "systemTask";
  const {answers,progress,output,incomplete,latestProgress}=presentTurnText(turn,status);
  const byId = new Map(turn.events.map(event => [event.id, event]));
  const all: RunOperation[] = summarized.map(operation => {
    const events = operation.eventIds.map(id => byId.get(id)).filter((e): e is DisplayEvent => !!e);
    const first = events[0];
    const started = first?.kind === "tool" ? (first.data as RunEventData).method === "item/started" :
      first && (first.data as RunEventData).status === "running";
    const startedAt = started ? eventTime(first) : undefined;
    const endedAt = !["inProgress", "running"].includes(operation.status) ? eventTime(events.at(-1)) : undefined;
    const native = operation.item.durationMs;
    const nativeKnown = typeof native === "number" && Number.isFinite(native) && native >= 0;
    const durationMs = nativeKnown ? native :
      startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
    return { ...operation, presentation:describeOperation(operation.item), startedAt, endedAt, durationMs,
      timingSource: nativeKnown ? "native" : durationMs !== undefined ? "observed" : "unknown" };
  });
  const operations = all.filter(op => !isBackground(op) && op.item.type !== "modelCall");
  const modelCalls = all.filter(op => op.item.type === "modelCall");
  const background = all.filter(isBackground);
  const start = turn.events.find(e => e.kind === "metadata" && (e.data as RunEventData).execution === "started") ??
    turn.events.find(e => e.kind === "user") ?? turn.events.find(e => e.kind === "status" && (e.data as RunEventData).status === "running");
  const startedAt = eventTime(start);
  const endedAt = eventTime(terminal);
  const durationMs = startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
  const points = operations.flatMap(op => op.startedAt === undefined ? [] :
    [{ time: op.startedAt, delta: 1 }, ...(op.endedAt === undefined ? [] : [{ time: op.endedAt, delta: -1 }])]);
  points.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0, maxParallel = 0;
  for (const point of points) { active += point.delta; maxParallel = Math.max(maxParallel, active); }
  const lastActivityAt = eventTime(turn.events.filter(e => !(e.kind === "metadata" && (e.data as RunEventData).systemTask)).at(-1));
  const timeline:RunTimelineItem[]=[];
  const reportItems=new Map<number,Extract<RunTimelineItem,{kind:"progress"}>>();
  for(const event of turn.events)if(event.kind==='progress'){
    const data=event.data as {text:string;runId:string;source:'cli';steps?:ExplicitProgress['steps']};
    reportItems.set(event.id,{kind:'progress',key:`progress:${event.id}`,progress:{text:data.text,source:data.source,runId:data.runId,sourceEventId:event.id,updatedAt:event.createdAt,...(data.steps?{steps:data.steps}:{}),historical:!['running','approval'].includes(status)}});
  }
  const operationHeads=new Map<number,RunTimelineItem>();
  for(const op of operations.filter(op=>op.item.type!=='hook')){
    const receiptId=returnedProgressId(op),report=receiptId===undefined?undefined:reportItems.get(receiptId);
    if(!op.eventIds.length)continue;
    const key=`operation:${op.key}`;
    if(report){
      report.technicalOperation=op;report.key=key;
      operationHeads.set(op.eventIds[0],report);
      reportItems.delete(receiptId!);
    }else operationHeads.set(op.eventIds[0],{kind:'operation',key,operation:op});
  }
  const messages=new Map(progress.map(message=>[message.key,message]));
  for(const message of turn.messages.filter(m=>m.kind==='error'))messages.set(message.key,message);
  const seenReasoning=new Set<string>();
  const decisions=new Map<string,ApprovalDecision>(),resolvedApprovals=new Set<string>(),answeredQuestions=new Set<string>();
  const nativeRequests=new Map<string|number,string>();
  for(const event of turn.events){
    if(event.kind==='approval'){const request=event.data as Approval;nativeRequests.set(request.nativeRequestId,request.id);}
    if(event.kind!=='metadata')continue;
    const data=event.data as {approvalDecision?:{approvalId:string;decision:ApprovalDecision};resolvedRequestId?:string|number;resolvedApprovalIds?:string[];answeredQuestionId?:string};
    if(data.approvalDecision)decisions.set(data.approvalDecision.approvalId,data.approvalDecision.decision);
    if(data.resolvedApprovalIds)for(const id of data.resolvedApprovalIds)resolvedApprovals.add(id);
    else if(data.resolvedRequestId!==undefined){
      const id=nativeRequests.get(data.resolvedRequestId);if(id)resolvedApprovals.add(id);
      nativeRequests.delete(data.resolvedRequestId);
    }
    if(data.answeredQuestionId)answeredQuestions.add(data.answeredQuestionId);
  }
  for(const event of turn.events){
    const operation=operationHeads.get(event.id);
    if(operation)timeline.push(operation);
    const report=reportItems.get(event.id);if(report)timeline.push(report);
    const message=messages.get(event.id);if(message)timeline.push({kind:message.kind==='error'?'error':'message',key:`message:${message.key}`,message});
    if(event.kind==='approval'){
      const request=event.data as Approval,decision=decisions.get(request.id);
      const state:RunApproval['state']=decision?decision.startsWith('reject')?'rejected':'approved':
        resolvedApprovals.has(request.id)||answeredQuestions.has(request.id)?'resolved':
        ['running','approval'].includes(status)?'pending':'unknown';
      timeline.push({kind:'approval',key:`approval:${event.id}`,event,approval:{request,state,...(decision?{decision}:{})}});
    }
    const data=event.data as RunEventData,id=data.params?.item?.id??data.params?.itemId;
    if(id&&!seenReasoning.has(id)){
      const value=reasoning.get(id)??reasoning.get(`${id}:summary`)??reasoning.get(`${id}:content`);
      if(value){seenReasoning.add(id);timeline.push({kind:'reasoning',key:`reasoning:${id}`,text:value});}
    }
  }
  return { answers, progress, output, latestProgress, timeline, activityTimeline:groupActivity(timeline,cli), reasoning: [...reasoning.entries()].filter(([key]) =>
    !key.endsWith(":content") || !reasoning.has(key.replace(/:content$/, ":summary"))),
    operations, background, modelCalls, status, queueReason, incomplete, startedAt, endedAt, durationMs,
    nativeDuration, approvalMs, approvalStarted, maxParallel, lastActivityAt };
}

export function formatDuration(ms: number | undefined) {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} m ${Math.floor(ms / 1000) % 60} s`;
}
