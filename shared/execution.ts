import type { RunContextTrace } from "./tasks";
import type { DisplayEvent } from "./types";
import type { HookEventData } from "./hooks";
type PlatformHook = Omit<HookEventData, "source" | "status"> & { status: HookEventData["status"] | "pending"; source: "platform"; task: "title" | "memory" | "recall" };
export type NativeItem = {
  id: string;
  type: string;
  status?: string;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  model?: string;
  ttftMs?: number;
  changes?: { path: string; kind: { type: string }; diff: string }[];
  server?: string;
  tool?: string;
  kind?: string;
  locations?: {path:string;line?:number|null}[];
  plan?: {step:string;status:string}[];
  explanation?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  text?: string;
  query?: string;
  hook?: HookEventData | PlatformHook;
};
export type Operation = {
  key: string;
  item: NativeItem;
  output: string;
  status: string;
  eventIds: number[];
};
const visibleTypes = new Set([
  "modelCall",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "plan",
  "contextCompaction",
  "collabAgentToolCall",
]);
export function summarizeOperations(events: DisplayEvent[]): Operation[] {
  const operations = new Map<string, Operation>();
  const platformRuns = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "metadata") {
      const reset = event.data as {nativeContextReset?:{reason?:string};message?:string};
      if(reset.nativeContextReset?.reason==='receipt_access_revoked'){
        const key=`context-reset:${event.id}`;
        operations.set(key,{key,item:{id:key,type:'dynamicToolCall',tool:'Context rebuilt',result:reset.message},output:reset.message??'',status:'completed',eventIds:[event.id]});
        continue;
      }
      const context = event.data as Partial<RunContextTrace>;
      if (context.contextSnapshotId && ["prepared", "acknowledged"].includes(context.actualUse ?? "")) {
        const key = `context:${context.contextSnapshotId}`, previous = operations.get(key);
        operations.set(key,{key,item:{id:key,type:"dynamicToolCall",tool:"Mandala context",result:context},output:"",status:context.actualUse === "acknowledged" ? "completed" : "running",eventIds:[...previous?.eventIds ?? [],event.id]});
        continue;
      }
      const data = event.data as { systemTask?: string; memoryRecall?: string; status?: string;
        message?: string; count?: number; entryIds?: string[]; entries?: { title: string; kind: string; assetId?: string; versionId?: string }[]; cli?: string; model?: string | null;
        sourceEventId?: number; applied?: boolean; title?: string; code?: string; stage?: string; jobId?: string };
      const task = data.memoryRecall ? "recall" : data.systemTask;
      if (!["title", "memory", "recall"].includes(task ?? "") ||
          !["running", "completed", "failed", "queued", "pending"].includes(data.status ?? "")) continue;
      const key = data.memoryRecall ? `hook:platform:recall:${data.memoryRecall}` :
        data.jobId ? `hook:platform:${task}:${data.jobId}` :
        data.status === "running" ? `hook:platform:${task}:${event.id}` :
          platformRuns.get(task!) ?? `hook:platform:${task}:${event.id}`;
      if (data.status === "running" && !data.jobId) platformRuns.set(task!, key);
      const previous = operations.get(key);
      const hook: PlatformHook = { id: key, source: "platform", task: task as PlatformHook["task"],
        name: task!, event: task === "recall" ? "beforeTurn" : "systemTask", status: (data.status === "queued" ? "pending" : data.status) as PlatformHook["status"] };
      operations.set(key, { key, item: { id: key, type: "hook", hook,
        result: { ...(data.count !== undefined ? { count: data.count } : {}),
          ...(data.entryIds ? { entryIds: data.entryIds } : {}),
          ...(data.entries ? { entries: data.entries } : {}),
          ...(data.cli ? { cli: data.cli, requestedModel: data.model ?? null } : {}),
          ...(data.sourceEventId ? { sourceEventId: data.sourceEventId } : {}),
          ...(data.applied !== undefined ? { applied: data.applied } : {}),
          ...(data.title ? { title: data.title } : {}),
          ...(data.code ? { code: data.code } : {}), ...(data.stage ? { stage: data.stage } : {}), ...(data.jobId ? {jobId:data.jobId} : {}) } },
        output: data.message ?? (data.jobId && data.status === "completed" ? "" : previous?.output ?? ""), status: hook.status,
        eventIds: [...previous?.eventIds ?? [], event.id] });
      if (data.status !== "running" && !data.memoryRecall && !data.jobId) platformRuns.delete(task!);
      continue;
    }
    if (event.kind === "hook") {
      const hook = event.data as HookEventData;
      const key = `hook:${hook.source}:${hook.id}`;
      const previous = operations.get(key);
      operations.set(key, {
        key,
        item: { id: hook.id, type: "hook", durationMs: hook.durationMs, hook },
        output: hook.output ?? previous?.output ?? "",
        status: hook.status,
        eventIds: [...previous?.eventIds ?? [], event.id],
      });
      continue;
    }
    if (event.kind === "status") {
      const status = (event.data as { status: string }).status;
      if (["idle", "error", "interrupted"].includes(status))
        for (const operation of operations.values())
          if (["inProgress", "running"].includes(operation.status) && operation.item.hook?.source !== "platform") {
            operation.eventIds.push(event.id);
            operation.status =
              status === "idle"
                ? "unknown"
                : status === "error"
                  ? "failed"
                  : "interrupted";
          }
      continue;
    }
    if (event.kind !== "tool") continue;
    const { method, params: p } = event.data as {
      method: string;
      params: {
        turnId?: string;
        item?: NativeItem;
        itemId?: string;
        delta?: string;
        explanation?: string;
        plan?: {step:string;status:string}[];
      };
    };
    if(method==='turn/plan/updated'&&Array.isArray(p.plan)){
      const key='plan:'+(p.turnId??''),previous=operations.get(key);
      operations.set(key,{key,item:{id:key,type:'plan',plan:p.plan,explanation:p.explanation},output:'',status:'updated',eventIds:[...previous?.eventIds??[],event.id]});
      continue;
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      p.item &&
      visibleTypes.has(p.item.type)
    ) {
      const key = `${p.turnId ?? ""}:${p.item.id}`,
        previous = operations.get(key);
      operations.set(key, {
        key,
        item: { ...previous?.item, ...p.item },
        output: p.item.aggregatedOutput ?? previous?.output ?? "",
        eventIds: [...previous?.eventIds ?? [], event.id],
        status:
          (p.item.exitCode != null && p.item.exitCode !== 0) || p.item.error
            ? "failed"
            : (p.item.status ??
              (method === "item/completed" ? "completed" : "inProgress")),
      });
    } else if (method === "item/commandExecution/outputDelta") {
      const operation = operations.get(`${p.turnId ?? ""}:${p.itemId}`);
      if (operation) { operation.output += p.delta ?? ""; operation.eventIds.push(event.id); }
    }
  }
  return [...operations.values()];
}
