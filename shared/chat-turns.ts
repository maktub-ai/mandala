import type {AgentMessage} from './agent-messages';
import type { NativeAttachment } from "./chat-input";
import type { ComposerReferenceItem } from './composer-references';
import type { DisplayEvent, Task } from "./types";
import { summarizeOperations } from "./execution";

export type ChatMessage = {
  source?:import('./tasks').QueuedInputSource;
  kind: "user" | "text" | "error" | "agent_message";
  agentMessage?: Partial<AgentMessage> & {id:string;direction:'sent'|'request'|'reply';autoResumeAllowed?:boolean};
  text: string;
  attachments?: NativeAttachment[];
  referenceItems?: ComposerReferenceItem[];
  key: number;
  item?: string;
  task?: Pick<Task, "id" | "kind" | "sourceConversationId">;
};
export type ChatBlock =
  | { kind: "message"; key: number; message: ChatMessage }
  | { kind: "execution"; key: number; events: DisplayEvent[] };
export type ChatTurn = {
  key: number;
  messages: ChatMessage[];
  events: DisplayEvent[];
  blocks: ChatBlock[];
};

export function mergeChatEvents(previous: DisplayEvent[], incoming: DisplayEvent[]): DisplayEvent[] {
  let next = [...previous], ids = new Set(previous.map(event => event.id)), changed = false;
  for (const event of incoming) {
    const replacedFrom = event.kind === "metadata" ? (event.data as { historyReplacedFrom?: number }).historyReplacedFrom : undefined;
    if (replacedFrom !== undefined) {
      const retained = next.filter(item => item.id < replacedFrom || item.id >= event.id);
      changed ||= retained.length !== next.length;
      next = retained; ids = new Set(next.map(item => item.id));
    }
    if (!ids.has(event.id)) { next.push(event); ids.add(event.id); changed = true; }
  }
  return changed ? next : previous;
}

export function groupChatTurns(events: DisplayEvent[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const latestMessages=new Map<string,ChatMessage['agentMessage']>();
  const messageHeads=new Map<string,number>();
  for(const event of events){const m=(event.data as {agentMessage?:ChatMessage['agentMessage']}).agentMessage;if(event.kind==='metadata'&&m){const key=m.id+':'+m.direction;if(!messageHeads.has(key)&&(m.direction!=='reply'||m.reply?.trim()))messageHeads.set(key,event.id);latestMessages.set(m.id,m);}}

  for (const event of events) {
    let turn = turns.at(-1);
    const data = event.data as { execution?: string; runId?: string };
    const message=(event.data as {agentMessage?:ChatMessage['agentMessage']}).agentMessage;
    if(event.kind==='metadata'&&message?.direction==='reply'&&messageHeads.get(message.id+':reply')===event.id){
      turn={key:event.id,messages:[],events:[],blocks:[]};turns.push(turn);
    }
    const accepted = data.runId && turn?.events.some(item => item.kind === "user" &&
      (item.data as { runId?: string }).runId === data.runId);
    if (event.kind === "metadata" && data.execution === "started" && turn?.events.length && !accepted) {
      turn = { key: event.id, messages: [], events: [], blocks: [] };
      turns.push(turn);
    }
    if (!turn || event.kind === "user") {
      let startup = -1;
      turn?.events.forEach((event, index) => {
        const data = event.data as { status?: string; execution?: string };
        if (event.kind === "status" && data.status === "running" || event.kind === "metadata" && data.execution === "started") startup = index;
      });
      const pending = turn && startup >= 0 && !turn.events.slice(startup).some((event) =>
        ["user", "text", "error"].includes(event.kind)) ? turn.events.splice(startup) : [];
      if (turn && !turn.events.length) turns.pop();
      turn = { key: event.id, messages: [], events: pending, blocks: [] };
      turns.push(turn);
    }
    turn.events.push(event);
  }
  const owners = new Map<string, ChatTurn>();
  const eventOwners = new Map<number, ChatTurn>();
  for (const turn of turns) for (const event of turn.events) {
    eventOwners.set(event.id, turn);
    const data = event.data as { runId?: string };
    if (event.kind === "user" && data.runId) owners.set(data.runId, turn);
  }
  for (const event of events) {
    const data = event.data as { runId?: string; sourceEventId?: number };
    const owner = data.runId ? owners.get(data.runId) : data.sourceEventId ? eventOwners.get(data.sourceEventId) : undefined;
    const previous = eventOwners.get(event.id);
    if (!owner || !previous || owner === previous) continue;
    previous.events = previous.events.filter(e => e !== event);
    owner.events.push(event);
    eventOwners.set(event.id, owner);
  }
  for (const turn of turns) turn.events.sort((a, b) => a.id - b.id);
  const operations = summarizeOperations(events);
  const eventOperations = new Map<number, string[]>();
  for (const operation of operations)
    for (const id of operation.eventIds)
      eventOperations.set(id, [...eventOperations.get(id) ?? [], operation.key]);
  const operationBlocks = new Map<string, Extract<ChatBlock, { kind: "execution" }>>();
  for (const turn of turns) {
    // The CLI acknowledges startup before the stored user event; show that work under
    // the request that caused it while preserving the original event log in turn.events.
    const user = turn.events.find((event) => event.kind === "user");
    const ordered = user ? [user, ...turn.events.filter((event) => event !== user)] : turn.events;
    let mergeText = false;
    for (const event of ordered) {
      if (eventOperations.has(event.id)) mergeText = false;
      for (const operationKey of eventOperations.get(event.id) ?? []) {
        let block = operationBlocks.get(operationKey);
        if (!block) {
          const last = turn.blocks.at(-1);
          block = last?.kind === "execution" ? last : { kind: "execution", key: event.id, events: [] };
          if (block !== last) turn.blocks.push(block);
          operationBlocks.set(operationKey, block);
        }
        if (!block.events.includes(event)) block.events.push(event);
      }
      if (event.kind === "tool") {
        const data = event.data as { method?: string; params?: { item?: { id: string; type: string; text?: string } } };
        const item = data.params?.item;
        if (data.method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
          const existing = [...turn.messages].reverse().find(m => m.kind === "text" && m.item === item.id);
          if (existing) existing.text = item.text;
          else if (item.text) {
            const message: ChatMessage = { kind: "text", text: item.text, key: event.id, item: item.id };
            turn.messages.push(message);
            turn.blocks.push({ kind: "message", key: event.id, message });
          }
          mergeText = false;
        }
      }
      const agentMessage=(event.data as {agentMessage?:ChatMessage['agentMessage']}).agentMessage;
      if(event.kind==='metadata'&&agentMessage&&messageHeads.get(agentMessage.id+':'+agentMessage.direction)===event.id){
        const latest={...agentMessage,...latestMessages.get(agentMessage.id),direction:agentMessage.direction};
        const message:ChatMessage={kind:'agent_message',key:event.id,text:latest.direction==='reply'?latest.reply??'':latest.text??'',agentMessage:latest};
        turn.messages.push(message);turn.blocks.push({kind:'message',key:event.id,message});mergeText=false;continue;
      }
      if(event.kind==='user'&&agentMessage)continue;
      if (event.kind !== "user" && event.kind !== "text" && event.kind !== "error") continue;
      const data = event.data as { source?:ChatMessage["source"]; text?: string; message?: string; itemId?: string; task?: ChatMessage["task"]; attachments?: NativeAttachment[]; referenceItems?: ComposerReferenceItem[] };
      const last = turn.blocks.at(-1);
      if (mergeText && event.kind === "text" && last?.kind === "message" && last.message.kind === "text" && last.message.item === data.itemId)
        last.message.text += data.text ?? "";
      else {
        const message: ChatMessage = { kind: event.kind, text: data.text ?? data.message ?? "", key: event.id, item: data.itemId,
          ...(event.kind === "user" && data.attachments ? { attachments: data.attachments } : {}),
          ...(event.kind === 'user' && data.referenceItems ? { referenceItems: data.referenceItems } : {}),
          ...(event.kind === "user" && data.source ? {source:data.source} : {}),
          ...(event.kind === "user" && data.task ? { task: data.task } : {}) };
        turn.messages.push(message);
        turn.blocks.push({ kind: "message", key: event.id, message });
      }
      mergeText = event.kind === "text";
    }
  }
  return turns.filter(turn => turn.events.length);
}
