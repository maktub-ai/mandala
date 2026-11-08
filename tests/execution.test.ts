import { expect, it } from "vitest";
import React from "react";
import { renderChineseMarkup } from "./helpers/render-ui";
import { summarizeOperations } from "../src/execution";
import ExecutionTrace, { ApprovalContent } from "../src/ExecutionTrace";
import type { DisplayEvent, Approval } from "../shared/types";
const event = (id: number, method: string, params: unknown): DisplayEvent => ({
  id,
  conversationId: "c",
  kind: "tool",
  createdAt: "2026-09-29",
  data: { method, params },
});
const hook = (id: number, data: unknown): DisplayEvent => ({
  id, conversationId: "c", kind: "hook", createdAt: "2026-10-01", data,
});
it("updates_each_native_hook_run_once_and_keeps_it_in_execution_order", () => {
  const operations = summarizeOperations([
    hook(1, { id: "h1", name: "personal-audit.sh", event: "postToolUse", status: "running", source: "codex" }),
    event(2, "item/completed", { turnId: "t", item: {
      id: "h1", type: "commandExecution", command: "cat personal.txt", status: "completed", exitCode: 0,
    } }),
    hook(3, { id: "h1", name: "personal-audit.sh", event: "postToolUse", status: "failed", source: "codex",
      durationMs: 20, output: "Personal fixture hook failed" }),
    hook(4, { id: "omp-error", name: "personal-extension.ts", event: "agent_end", status: "failed", source: "omp",
      output: "Personal fixture extension error" }),
  ]);
  expect(operations).toHaveLength(3);
  expect(operations.map((operation) => operation.item.type)).toEqual(["hook", "commandExecution", "hook"]);
  expect(operations[0].status).toBe("failed");
  expect(operations[0].output).toBe("Personal fixture hook failed");
});
it("renders_native_hook_trigger_source_duration_and_output_without_html", () => {
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, { events: [
    hook(1, { id: "h", name: "personal-audit.sh", event: "postToolUse", status: "running", source: "codex" }),
    hook(2, { id: "h", name: "personal-audit.sh", event: "postToolUse", status: "failed", source: "codex",
      durationMs: 20, output: "<script>personal error</script>" }),
  ] }));
  expect(html).toContain("personal-audit.sh");
  expect(html).toContain("postToolUse");
  expect(html).toContain("Codex");
  expect(html).toContain("20 ms");
  expect(html).toContain("1 次失败");
  expect(html).toContain("&lt;script&gt;personal error&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
it("preserves_blocked_and_stopped_hook_results_without_claiming_completion", () => {
  const events = [
    hook(1, { id: "blocked", name: "personal-policy.sh", event: "preToolUse", status: "blocked", source: "codex" }),
    hook(2, { id: "stopped", name: "personal-stop.sh", event: "stop", status: "stopped", source: "codex" }),
  ];
  expect(summarizeOperations(events).map((operation) => operation.status)).toEqual(["blocked", "stopped"]);
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, { events }));
  expect(html).toContain("已阻止");
  expect(html).toContain("已停止");
});
it("counts_a_running_hook_and_shows_zero_duration_without_inventing_other_runs", () => {
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, { events: [
    hook(1, { id: "h", name: "personal-fast.sh", event: "preToolUse", status: "running", source: "codex", durationMs: 0 }),
  ] }));
  expect(html).toContain("1 次进行中");
  expect(html).toContain("0 ms");
  expect(html).not.toContain("次失败");
  const noHook = renderChineseMarkup(React.createElement(ExecutionTrace, { events: [] }));
  expect(noHook).toBe("");
});
it("keeps_operation_rows_scannable_and_counts_visible_while_outputs_are_collapsed", () => {
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, {
    events: [
      event(1, "item/started", {
        turnId: "t", item: { type: "commandExecution", id: "reading", command: "cat notes.txt", status: "inProgress" },
      }),
      event(2, "item/completed", {
        turnId: "t", item: { type: "commandExecution", id: "missing", command: "cat missing.txt", status: "completed", exitCode: 1 },
      }),
      event(3, "item/completed", {
        turnId: "t", item: { type: "commandExecution", id: "done", command: "pwd", status: "completed", exitCode: 0 },
      }),
    ],
  }));
  expect(html).toMatch(/^<section/);
  const summary = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  expect(summary).toContain("3 次操作");
  expect(summary).toContain("1 次进行中");
  expect(summary).toContain("1 次失败");
  expect(html).not.toContain("open=\"\"");
});
it("labels_command_output_and_preserves_text_without_rendering_html", () => {
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, {
    events: [event(1, "item/completed", {
      turnId: "t", item: { type: "commandExecution", id: "cmd", command: "cat personal.txt",
        status: "completed", aggregatedOutput: "<script>private fixture</script>", exitCode: 0 },
    })],
  }));
  expect(html).toContain("工具输出");
  expect(html).toContain("&lt;script&gt;private fixture&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
it("shows_a_nonzero_command_exit_as_failure_even_if_the_item_completed", () => {
  const operations = summarizeOperations([
    event(1, "item/completed", {
      turnId: "t",
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "cat missing.txt",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "No such file",
      },
    }),
  ]);
  expect(operations[0].status).toBe("failed");
});
it("marks_unfinished_operations_interrupted_when_the_conversation_stops", () => {
  const events = [
    event(1, "item/started", {
      turnId: "t",
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "sleep 10",
        status: "inProgress",
      },
    }),
    {
      id: 2,
      conversationId: "c",
      kind: "status",
      createdAt: "2026-09-29",
      data: { status: "interrupted" },
    } as DisplayEvent,
  ];
  expect(summarizeOperations(events)[0].status).toBe("interrupted");
});
it("keeps_identical_item_ids_from_different_turns_separate", () => {
  const events = [
    event(1, "item/completed", {
      turnId: "first",
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "echo first",
        status: "completed",
      },
    }),
    event(2, "item/completed", {
      turnId: "second",
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "echo second",
        status: "completed",
      },
    }),
  ];
  expect(summarizeOperations(events).map((o) => o.item.command)).toEqual([
    "echo first",
    "echo second",
  ]);
});
const approval = (method: string, params: unknown): Approval => ({
  id: "a",
  conversationId: "c",
  nativeRequestId: 1,
  method,
  params,
});
it("explains_terminal_input_and_network_approval_context", () => {
  const html = renderChineseMarkup(
    React.createElement(ApprovalContent, {
      approval: approval("item/commandExecution/requestApproval", {
        kind: "writeStdin",
        command: "yes",
        networkApprovalContext: { host: "example.com", protocol: "https" },
      }),
      events: [],
    }),
  );
  const visible = html.split("<details")[0];
  expect(visible).toContain("向已运行命令发送输入");
  expect(visible).toContain("example.com");
  expect(visible).toContain("https");
});
it("explicitly_reports_missing_file_changes_in_a_directory_permission_request", () => {
  const html = renderChineseMarkup(
    React.createElement(ApprovalContent, {
      approval: approval("item/fileChange/requestApproval", {
        turnId: "t",
        itemId: "file",
        grantRoot: "/personal/notes",
      }),
      events: [
        event(1, "item/started", {
          turnId: "t",
          item: {
            id: "file",
            type: "fileChange",
            changes: [],
            status: "inProgress",
          },
        }),
      ],
    }),
  );
  expect(html).toContain("CLI 尚未提供文件变更明细");
  expect(html).toContain("/personal/notes");
});

it("shows the latest output line inside a collapsed compact operation row", () => {
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, { events: [
    event(1, "item/started", { turnId: "t", item: { id: "build", type: "commandExecution", command: "npm test", status: "inProgress" } }),
    event(2, "item/commandExecution/outputDelta", { turnId: "t", itemId: "build", delta: "First line\nLatest progress\n" }),
  ] }));
  const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
  expect(summary).toContain("Latest progress");
  expect(summary).toContain("执行中");
  expect(summary).not.toContain("First line");
  expect(summary).not.toContain("<small>");
  expect(html).not.toContain('open=""');
});

it("groups actual platform background hook lifecycles separately from native hooks and later runs", () => {
  const metadata = (id: number, data: unknown): DisplayEvent => ({ ...hook(id, data), kind: "metadata" });
  const events = [
    metadata(1, { systemTask: "title", status: "running" }),
    metadata(2, { systemTask: "memory", status: "running" }),
    hook(3, { id: "h", name: "audit", event: "stop", status: "completed", source: "codex" }),
    metadata(4, { systemTask: "title", status: "completed", applied: true }),
    metadata(5, { systemTask: "memory", status: "failed", message: "Provider rejected model" }),
    metadata(6, { systemTask: "memory", status: "running" }),
    metadata(7, { systemTask: "memory", status: "completed", count: 2 }),
  ];
  const operations = summarizeOperations(events);
  expect(operations.map(operation => [operation.item.hook?.source, operation.status]))
    .toEqual([["platform", "completed"], ["platform", "failed"], ["codex", "completed"], ["platform", "completed"]]);
  expect(operations[0].eventIds).toEqual([1, 4]);
  expect(operations[1].eventIds).toEqual([2, 5]);
  const html = renderChineseMarkup(React.createElement(ExecutionTrace, { events }));
  expect(html).toContain("平台后台 Hook");
  expect(html).toContain("Mandala");
  expect(html).toContain("生成标题");
  expect(html).toContain("提炼记忆");
  expect(html).toContain("Provider rejected model");
  expect(html).toContain("Codex");
});

it("does not cancel independent platform hooks when the user conversation stops", () => {
  const events: DisplayEvent[] = [
    { id: 1, conversationId: "c", kind: "metadata", createdAt: "2026-10-01", data: { systemTask: "memory", status: "running" } },
    { id: 2, conversationId: "c", kind: "status", createdAt: "2026-10-01", data: { status: "interrupted" } },
  ];
  expect(summarizeOperations(events)[0]).toMatchObject({ status: "running", eventIds: [1] });
});

it("uses a later native hook completion as evidence after terminal state was unknown", () => {
  const events: DisplayEvent[] = [
    hook(1, { id: "h", source: "codex", name: "audit.sh", event: "stop", status: "running" }),
    { id: 2, conversationId: "c", kind: "status", createdAt: "2026-10-01", data: { status: "idle" } },
    hook(3, { id: "h", source: "codex", name: "audit.sh", event: "stop", status: "completed", output: "Checked" }),
  ];
  expect(summarizeOperations(events)[0]).toMatchObject({ status: "completed", eventIds: [1, 2, 3], output: "Checked" });
});

it("shows the generated title and whether it was actually written back", () => {
  const events: DisplayEvent[]=[{id:1,conversationId:"c",kind:"metadata",createdAt:"2026-10-01",data:{systemTask:"title",status:"completed",applied:true,title:"Personal reading"}}];
  const html=renderChineseMarkup(React.createElement(ExecutionTrace,{events}));
  expect(html).toContain("Personal reading");
  expect(html).toContain("已更新对话标题");
});
it('shows fixed context preparation and native acknowledgement separately with partial visibility',()=>{
 const context=(id:number,actualUse:string):DisplayEvent=>({id,conversationId:'c',kind:'metadata',createdAt:'2026-10-02',data:{contextSnapshotId:'snapshot',actualUse,sourceVersions:[{assetId:'a',versionId:'v1'}],nativeVisibility:'partial'}});
 const prepared=summarizeOperations([context(1,'prepared')]);expect(prepared).toHaveLength(1);expect(prepared[0].status).toBe('running');
 const acknowledged=summarizeOperations([context(1,'prepared'),context(2,'acknowledged')]);expect(acknowledged).toHaveLength(1);expect(acknowledged[0].status).toBe('completed');
 expect(acknowledged[0].item.result).toMatchObject({sourceVersions:[{assetId:'a',versionId:'v1'}],nativeVisibility:'partial',actualUse:'acknowledged'});
});

it("keeps pending memory jobs visible and groups retries by durable job identity", () => {
  const metadata = (id:number,data:unknown):DisplayEvent => ({...hook(id,data),kind:"metadata"});
  const events = [
    metadata(1,{systemTask:"memory",status:"pending",jobId:"request-a",stage:"scene",message:"quota exhausted"}),
    metadata(2,{systemTask:"memory",status:"completed",jobId:"request-b",count:2}),
    metadata(3,{systemTask:"memory",status:"running",jobId:"request-a",stage:"scene"}),
    metadata(4,{systemTask:"memory",status:"completed",jobId:"request-a",count:3}),
  ];
  const pending = summarizeOperations(events.slice(0,2));
  expect(pending.map(operation=>operation.status)).toEqual(["pending","completed"]);
  const html = renderChineseMarkup(React.createElement(ExecutionTrace,{events:events.slice(0,2)}));
  expect(html).toContain("待处理");
  expect(html).toContain("quota exhausted");
  const operations = summarizeOperations(events);
  expect(operations).toHaveLength(2);
  expect(operations[0].eventIds).toEqual([1,3,4]);
  expect(operations[1].eventIds).toEqual([2]);
  expect(operations[0].item.result).toMatchObject({jobId:"request-a",count:3});
  expect(operations[0].output).toBe("");
});
it('shows a context access reset in the existing expandable execution trace',()=>{
 const reset:DisplayEvent={id:1,conversationId:'c',kind:'metadata',createdAt:'2026-10-30',data:{nativeContextReset:{reason:'receipt_access_revoked',historyPreserved:true},message:'Context rebuilt after access changed. Previous history is retained and was not replayed.'}};
 const html=renderChineseMarkup(React.createElement(ExecutionTrace,{events:[reset],lazy:true}));
 expect(html).toContain('Context rebuilt');expect(html).toContain('Previous history is retained');
 expect(summarizeOperations([reset])[0].status).toBe('completed');
});
