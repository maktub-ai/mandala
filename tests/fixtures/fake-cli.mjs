import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const statePath = process.argv[process.argv.indexOf("--state") + 1];
const persistent = process.argv.includes("--state");
const readThreads = () => {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; }
};
const saveThreads = (threads) => writeFileSync(statePath, JSON.stringify(threads));
let activeThread = "native-1", activeTurn = "turn-1";
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (!r.method) {
    send({ method: "approval/result", params: r });
    return;
  }
  if (r.method === "exit") {
    process.exit(3);
  }
  if (r.method === "approval") {
    send({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: activeThread, turnId: activeTurn, command: "echo ok" },
    });
  }
  let result = r.params;
  if (r.method === "initialize")
    result = { userAgent: "open_mana/0.154.0 (fixture)" };
  if (r.method === "config/read") result = { config: { approval_policy: "on-request" } };
  // This fixture launches no background terminals; foreground hold is separate.
  if (r.method === "thread/backgroundTerminals/list") result = { data: [], nextCursor: null };
  if (r.method === "account/read")
    result = {
      account:
        process.argv.includes("--logged-out") ||
        process.argv.includes("--custom-provider")
          ? null
          : { type: "chatgpt", email: "private@example.com", planType: "plus" },
      requiresOpenaiAuth: !process.argv.includes("--custom-provider"),
    };
  if (r.method === "model/list")
    result = {
      data: process.argv.includes("--chat") ? [
        { model: "model-fixture", displayName: "Fixture", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort })) },
        { model: "model-second", displayName: "Second fixture", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({ reasoningEffort })) },
      ] : [{ model: "model-fixture", displayName: "Fixture" }],
      nextCursor: null,
    };
  if (r.method === "thread/start") {
    activeThread = persistent ? "native-" + randomUUID() : "native-1";
    if (persistent) { const threads = readThreads(); threads[activeThread] = []; saveThreads(threads); }
    result = { thread: { id: activeThread } };
    send({ method: "fixture/start", params: r.params });
  }
  if (r.method === "thread/resume" && process.argv.includes("--resume-conflict")) {
    send({ id: r.id, error: { code: -32600, message: `thread ${r.params.threadId} already has an active writer` } });
    return;
  }
  if (r.method === "thread/resume") {
    activeThread = r.params.threadId;
    result = { thread: { id: activeThread } };
  }
  if (r.method === "thread/read" && persistent)
    result = { thread: { id: r.params.threadId, turns: readThreads()[r.params.threadId] || [] } };
  if (r.method === "thread/fork" && persistent) {
    const threads = readThreads();
    const turns = threads[r.params.threadId] || [];
    const index = turns.findIndex((turn) => turn.id === r.params.beforeTurnId);
    activeThread = "native-" + randomUUID();
    threads[activeThread] = r.params.beforeTurnId ? turns.slice(0, index) : turns.slice();
    saveThreads(threads);
    result = { thread: { id: activeThread } };
  }
  if (r.method === "turn/start") {
    activeThread = r.params.threadId;
    activeTurn = persistent ? "turn-" + randomUUID() : "turn-1";
    if (persistent) {
      const threads = readThreads();
      (threads[activeThread] ||= []).push({ id: activeTurn, items: [{ type: "userMessage", content: r.params.input }] });
      saveThreads(threads);
    }
    result = { turn: { id: activeTurn, status: "inProgress" } };
  }
  if (r.method === "thread/start" && process.argv.includes("--slow-start")) {
    setTimeout(() => send({ id: r.id, result }), 10000);
    return;
  }
  if (r.id !== undefined) {
    const text = JSON.stringify({ id: r.id, result }) + "\n";
    if (process.argv.includes("--chat")) process.stdout.write(text);
    else {
      process.stdout.write(text.slice(0, 7));
      setTimeout(() => process.stdout.write(text.slice(7)), 2);
    }
  }
});
if (process.argv.includes("--chat")) {
  let active;
  const complete = (status) => {
    if (active) {
      send({
        method: "turn/completed",
        params: { threadId: activeThread, turn: { id: activeTurn, status } },
      });
      active = null;
    }
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const r = JSON.parse(line);
    if (!r.method) {
      if(active==='activity-flow')return;
      if ((active === "native-question" || active === "native-question-nonblocking")) {
        if (r.id !== 64 || typeof r.result?.answers?.preview?.answers?.[0] !== "string") { complete("failed"); return; }
        send({method:"item/agentMessage/delta",params:{threadId:activeThread,turnId:activeTurn,itemId:"question-answer",delta:"Question answered: "+r.result.answers.preview.answers[0]}});
        complete("completed");return;
      }
      if (active?.startsWith("mcp-approval-")) {
        const choice = active.slice("mcp-approval-".length);
        const expected = {action:choice === "reject" ? "decline" : "accept",content:null,
          ...(choice === "session" || choice === "always" ? {_meta:{persist:choice}} : {})};
        if (r.id !== 0 || JSON.stringify(r.result) !== JSON.stringify(expected)) {
          send({method:"error",params:{threadId:activeThread,error:{message:"Invalid MCP elicitation response"}}});
          complete("failed"); return;
        }
        send({method:"item/agentMessage/delta",params:{threadId:activeThread,turnId:activeTurn,itemId:"mcp-reply",delta:"MCP approval resolved: " + choice}});
      }
      setTimeout(() => complete("completed"), 10);
      return;
    }
    if (r.method === "turn/interrupt") {
      if (active === "ignore-stop") return;
      setTimeout(() => complete("interrupted"), 10);
      return;
    }
    if (r.method !== "turn/start") return;
    active = r.params.input[0].text;
    const text = active;
    setTimeout(() => {
      send({
        method: "turn/started",
        params: {
          threadId: activeThread,
          turn: { id: activeTurn, status: "inProgress" },
        },
      });
      if ((text === "native-question" || text === "native-question-nonblocking"))
        send({id:64,method:"item/tool/requestUserInput",params:{threadId:activeThread,turnId:activeTurn,itemId:"preview-question",isBlocking:text !== "native-question-nonblocking",questions:[{id:"preview",header:"Preview",question:"Where should the content open?",options:[{label:"In app",description:"Preview inside OpenMana"},{label:"Copy path",description:"Copy the local path"}]}]}});
      else if (text.startsWith("mcp-approval-"))
        send({id:0,method:"mcpServer/elicitation/request",params:{threadId:activeThread,turnId:activeTurn,
          serverName:"openmana_tasks",mode:"form",message:'Allow the openmana_tasks MCP server to run tool "project_agents"?',
          requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",persist:["session","always"]}}});
      else if (text === "approval" || text === "approval-options" || text === "approval-cancel")
        send({
          id: 42,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThread,
            turnId: activeTurn,
            command: "echo ok",
            ...(text === "approval-cancel" ? {availableDecisions:["accept","cancel"],proposedExecpolicyAmendment:["echo"]} : {}),
            ...(text === "approval-options" ? {availableDecisions:["accept","acceptForSession",{acceptWithExecpolicyAmendment:{execpolicy_amendment:["echo"]}},"decline"],proposedExecpolicyAmendment:["echo"]} : {}),
            cwd: "/personal/reading",
            reason: "读取个人样例的标签数量",
          },
        });
      else {
        if(text==='activity-flow')return;
        if (text === "placeholder-progress") {
          const emitItem = item => send({method:"item/completed",params:{threadId:activeThread,turnId:activeTurn,item}});
          for (let index = 0; index < 7; index++) {
            emitItem({id:`placeholder-${index}`,type:"agentMessage",text:".",stopReason:"toolUse"});
            emitItem({id:`placeholder-tool-${index}`,type:"commandExecution",command:`inspect setting ${index}`,status:"completed"});
          }
          emitItem({id:"meaningful-progress",type:"agentMessage",text:"Synthetic setting located.",stopReason:"toolUse"});
          emitItem({id:"placeholder-answer",type:"agentMessage",text:"Synthetic setting verified.",stopReason:"stop"});
          complete("completed");
          return;
        }
        if (text === "observed-many") {
          for (let index = 0; index < 300; index++) send({ method: "item/completed", params: {
            threadId: activeThread, turnId: activeTurn, item: { id: `many-${index}`, type: "commandExecution",
              command: `inspect synthetic resource ${index}`, status: "completed", durationMs: index,
              aggregatedOutput: Array.from({ length: 300 }, (_, line) => `Synthetic output ${line}`).join("\n") } } });
          send({ method: "item/completed", params: { threadId: activeThread, turnId: activeTurn,
            item: { id: "many-answer", type: "agentMessage", phase: "final_answer", text: "300 operations completed." } } });
          complete("completed");
          return;
        }
        if (text === "observed-flow") {
          const emitItem = (method, item) => send({ method, params: { threadId: activeThread, turnId: activeTurn, item } });
          emitItem("item/started", { id: "progress", type: "agentMessage", phase: "commentary", text: "" });
          send({ method: "item/agentMessage/delta", params: { threadId: activeThread, turnId: activeTurn, itemId: "progress", delta: "Checking both resources" } });
          emitItem("item/completed", { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking both resources" });
          send({ method: "item/reasoning/summaryTextDelta", params: { threadId: activeThread, turnId: activeTurn, itemId: "reason", delta: "Compare the independent results." } });
          emitItem("item/started", { id: "parallel-a", type: "commandExecution", command: "read resource A", status: "inProgress" });
          emitItem("item/started", { id: "parallel-b", type: "commandExecution", command: "read resource B", status: "inProgress" });
          send({ method: "item/commandExecution/outputDelta", params: { threadId: activeThread, turnId: activeTurn, itemId: "parallel-b", delta: "reading resource B\n" } });
          setTimeout(() => {
            if (active !== text) return;
            emitItem("item/completed", { id: "parallel-a", type: "commandExecution", command: "read resource A", status: "completed", durationMs: 600, aggregatedOutput: "A ready" });
          }, 600);
          setTimeout(() => {
            if (active !== text) return;
            emitItem("item/completed", { id: "parallel-b", type: "commandExecution", command: "read resource B", status: "completed", durationMs: 1200, aggregatedOutput: "B ready" });
            emitItem("item/completed", { id: "answer-a", type: "agentMessage", phase: "final_answer", text: "Both resources are ready." });
            emitItem("item/completed", { id: "answer-b", type: "agentMessage", phase: "final_answer", text: "Evidence: A and B verified." });
            complete("completed");
          }, 1200);
          return;
        }
        if (text === "live-tool-flow") {
          send({ method: "item/agentMessage/delta", params: { threadId: activeThread, turnId: activeTurn, itemId: "intro", delta: "Checking the sample" } });
          send({ method: "item/started", params: { threadId: activeThread, turnId: activeTurn,
            item: { type: "commandExecution", id: "live-command", command: "read sample.txt", status: "inProgress" } } });
          send({ method: "item/commandExecution/outputDelta", params: { threadId: activeThread, turnId: activeTurn,
            itemId: "live-command", delta: "reading 1/3\n" } });
          return;
        }
        if (text === "hook-flow") {
          const hook = (id, status, sourcePath, output, durationMs) => ({ threadId: activeThread, turnId: activeTurn,
            run: { id, eventName: "UserPromptSubmit", sourcePath, handlerType: "command", status,
              entries: output ? [{ text: output }] : [], durationMs, statusMessage: null } });
          send({ method: "hook/started", params: hook("hook-preflight", "running", "/tmp/fixture/preflight.sh") });
          send({ method: "hook/completed", params: hook("hook-preflight", "completed", "/tmp/fixture/preflight.sh", "Synthetic preflight complete", 12) });
          send({ method: "hook/completed", params: hook("hook-audit", "failed", "/tmp/fixture/audit.sh", "Synthetic hook failure", 3) });
        }
        if (text === "tool-flow") {
          const command = {
            type: "commandExecution",
            id: "command-1",
            command: "cat tags.txt",
            cwd: "/personal/reading",
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          send({
            method: "item/started",
            params: { threadId: activeThread, turnId: activeTurn, item: command },
          });
          send({
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: activeThread,
              turnId: activeTurn,
              itemId: "command-1",
              delta: "tags: 3\n",
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: activeThread,
              turnId: activeTurn,
              item: {
                ...command,
                status: "completed",
                aggregatedOutput: "tags: 3\n",
                exitCode: 0,
                durationMs: 55,
              },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: activeThread,
              turnId: activeTurn,
              item: {
                type: "fileChange",
                id: "file-1",
                status: "completed",
                changes: [
                  {
                    path: "/personal/reading/tags.txt",
                    kind: { type: "update", move_path: null },
                    diff: "@@ -1 +1 @@\n-tags: 2\n+tags: 3",
                  },
                ],
              },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: activeThread,
              turnId: activeTurn,
              item: {
                type: "mcpToolCall",
                id: "mcp-1",
                server: "reading",
                tool: "list_tags",
                status: "completed",
                arguments: {},
                result: {
                  content: [
                    { type: "text", text: "fiction, science, history" },
                  ],
                  structuredContent: null,
                  _meta: null,
                },
                error: null,
                durationMs: 10,
              },
            },
          });
        }
        if (text === "stream-inline" || text.startsWith("stream-inline:")) {
          const chunks = ['同段', '新增', '文字', ' &amp; ', 'Z', ' 👨‍👩‍👧‍👦é', ' 完成。'];
          const gate = text.startsWith("stream-inline:") ? text.slice("stream-inline:".length) : null;
          let index = 0;
          const timer = setInterval(() => {
            if (!active) { clearInterval(timer); return; }
            // The browser acknowledges each rendered append before releasing the next one.
            if (gate && Number(readFileSync(gate, "utf8")) <= index) return;
            if (index === chunks.length) { clearInterval(timer); complete('completed'); return; }
            send({ method: 'item/agentMessage/delta', params: {
              threadId: activeThread, turnId: activeTurn, itemId: 'message-1', delta: chunks[index++],
            } });
            if (!gate && index === chunks.length) { clearInterval(timer); complete('completed'); }
          }, gate ? 10 : 160);
          return;
        }
        if (text === "stream-reading") {
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: activeThread, turnId: activeTurn,
              itemId: "message-1",
              delta: Array.from(
                { length: 40 },
                (_, i) => `阅读资料 ${i + 1}\n\n`,
              ).join(""),
            },
          });
          let count = 0;
          const timer = setInterval(() => {
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: activeThread, turnId: activeTurn,
                itemId: "message-1",
                delta: `更新 ${++count}\n\n`,
              },
            });
            if (count === 15 || !active) {
              clearInterval(timer);
              complete("completed");
            }
          }, 100);
          return;
        }
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: activeThread, turnId: activeTurn,
            itemId: "message-1",
            delta: "Fixture reply: " + text,
          },
        });
        if (text !== "hold" && text !== "ignore-stop" && !text.includes("message-hold:") && !text.startsWith("fixture-delegate:")) setTimeout(() => complete("completed"), 30);
      }
    }, 10);
  });
}
