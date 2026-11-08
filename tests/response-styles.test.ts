import { AgentSideConnection, ndJsonStream, type ContentBlock } from "@agentclientprotocol/sdk";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../server/config";
import { openStore, type Store } from "../server/store";
import { createSessionManager, type SessionManager } from "../server/sessions";
import { startNativeRuntime } from "../server/native-runtime";
import { runtimeIds } from "../shared/runtimes";
import type { CodexClient, CodexOptions } from "../server/codex";
import type { OmpOptions } from "../server/omp";
import type { Config, Cli } from "../shared/types";
vi.mock("../server/native-runtime", () => ({ startNativeRuntime: vi.fn() }));

let home: string, store: Store, manager: SessionManager | undefined, config: Config;
let received: string[], inputs: string[], options: CodexOptions, turn: number;
const nativeId = "response-style-session";
function native(optionsForRun: CodexOptions): CodexClient {
  options = optionsForRun;
  return {
    getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
    startThread: async input => { received.push(input.instructions); return nativeId; },
    resumeThread: async (_id, _mcp, instructions) => { received.push(instructions!); },
    startTurn: async (_id, input) => {
      inputs.push(input); const id = `turn-${++turn}`;
      optionsForRun.onEvent({ method: "turn/started", params: { threadId: nativeId, turn: { id, status: "inProgress" } } });
      return id;
    },
    interrupt: async () => optionsForRun.onEvent({ method: "turn/completed", params: { threadId: nativeId, turn: { id: `turn-${turn}`, status: "interrupted" } } }),
    replyApproval() {}, close() {},
  };
}
function setup(cli: Cli) {
  config.agents[0].defaultCli = cli;
  vi.mocked(startNativeRuntime).mockImplementation(async (actualCli, callbacks) => { expect(actualCli).toBe(cli); return native(callbacks); });
  manager = createSessionManager(store, async () => structuredClone(config), async callbacks => native(callbacks), async (callbacks: OmpOptions) => {
    const client = native(callbacks); received.push(await readFile(callbacks.instructions!, "utf8"));
    return { ...client, startThread: async () => nativeId };
  }, home);
}
function finish(text = "Original final answer") {
  options.onEvent({ method: "item/agentMessage/delta", params: { threadId: nativeId, turnId: `turn-${turn}`, itemId: `answer-${turn}`, delta: text } });
  options.onEvent({ method: "item/completed", params: { threadId: nativeId, turnId: `turn-${turn}`, item: { id: `answer-${turn}`, type: "agentMessage", phase: "final_answer", text } } });
  options.onEvent({ method: "turn/completed", params: { threadId: nativeId, turn: { id: `turn-${turn}`, status: "completed" } } });
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mandala-response-styles-")); store = openStore(home);
  received = []; inputs = []; turn = 0;
  config = { version: 2, runtimes: [...runtimeIds], projects: [{ id: "p", name: "Synthetic project", cwd: home, agentIds: ["a"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "a", name: "Synthetic Agent", instructions: "Keep this Agent instruction", defaultCli: "codex", models: {}, mcp: [], skills: [] }] };
});
afterEach(async () => { await manager?.close(); manager = undefined; store.close(); await rm(home, { recursive: true, force: true }); vi.clearAllMocks(); });

it("accepts all styles without narrowing the five Runtime schema, and rejects invalid values before writing", async () => {
  config.runtimeDefaults = { gemini: { args: [] }, claude: { args: [] }, opencode: { args: [] } };
  await writeConfig(home, config, (await readConfig(home)).revision);
  expect((await readConfig(home)).config.responseStyle).toBeUndefined();
  for (const style of ["standard", "concise", "explanatory"] as const) {
    const saved = await readConfig(home);
    await writeConfig(home, { ...saved.config, responseStyle: style, agents: [{ ...saved.config.agents[0], responseStyle: style }] }, saved.revision);
    const current = (await readConfig(home)).config;
    expect(current).toMatchObject({ responseStyle: style, agents: [{ responseStyle: style }], runtimeDefaults: config.runtimeDefaults });
    expect(current.runtimes).toEqual(runtimeIds);
  }
  const saved = await readConfig(home);
  for (const value of ["", "inherit", "verbose", null, 1, {}, []]) for (const scope of ["global", "agent"]) {
    const invalid = structuredClone(saved.config); Object.assign(scope === "global" ? invalid : invalid.agents[0], { responseStyle: value });
    await expect(writeConfig(home, invalid, saved.revision)).rejects.toThrow("invalid configuration");
    expect((await readConfig(home)).revision).toBe(saved.revision);
  }
  delete saved.config.agents[0].responseStyle; await writeConfig(home, saved.config, saved.revision);
  expect((await readConfig(home)).config.agents[0]).not.toHaveProperty("responseStyle");
});

it.each(runtimeIds)("%s hands the next execution its effective style while preserving host context, input and historical answers", async cli => {
  config.agents[0].skills = [{ name: "source-check", path: "", content: "---\nname: source-check\ndescription: Check synthetic sources\n---\nRead the supplied source facts." }];
  setup(cli); const chat = await manager!.create("p", "a", undefined, cli);
  await manager!.send(chat.id, "Answer in English in exactly one sentence.");
  expect(received.at(-1)).toContain("Response style: standard");
  expect(received.at(-1)).toContain("Keep this Agent instruction");
  expect(received.at(-1)).toContain(chat.id);
  expect(received.at(-1)).toContain("Available Skills for this turn");
  expect(received.at(-1)).toContain('"name":"source-check","description":"Check synthetic sources"');
  expect(received.at(-1)!.indexOf("Available Skills for this turn")).toBeLessThan(received.at(-1)!.indexOf("Keep this Agent instruction"));
  expect(received.at(-1)!.indexOf("Keep this Agent instruction")).toBeLessThan(received.at(-1)!.indexOf("Response style:"));
  config.responseStyle = "explanatory"; expect(received).toHaveLength(1); finish();
  const history = store.listEvents(chat.id, 0).filter(event => event.kind === "text");
  expect(history).toHaveLength(1); expect(history[0].data).toMatchObject({ text: "Original final answer" });
  await manager!.send(chat.id, "Next question"); expect(received.at(-1)).toContain("Response style: explanatory"); finish("Second final answer");
  config.agents[0].responseStyle = "concise";
  await manager!.close(); setup(cli); await manager!.continue(chat.id, "Recover the same native session");
  expect(store.getConversation(chat.id)?.nativeId).toBe(nativeId); expect(received.at(-1)).toContain("Response style: concise"); finish("Recovered final answer");
  delete config.agents[0].responseStyle; config.responseStyle = "standard";
  await manager!.send(chat.id, "Restore inheritance"); finish("Inherited final answer");
  expect(received.map(text => text.match(/Response style: (\w+)/)?.[1])).toEqual(["standard", "explanatory", "concise", "standard"]);
  for (const text of received) expect(text.match(/Response style: /g)).toHaveLength(1);
  expect(inputs).toEqual(["Answer in English in exactly one sentence.", "Next question", "Recover the same native session", "Restore inheritance"]);
  expect(store.listEvents(chat.id, 0).filter(event => event.kind === "text").slice(0, 1)).toEqual(history);
  expect(store.getConversation(chat.id)?.status).toBe("idle");
});

it.each(runtimeIds)("%s preserves an explicit standard override and refreshes inherited style after interrupt/continue", async cli => {
  config.responseStyle = "explanatory"; config.agents[0].responseStyle = "standard"; setup(cli);
  const chat = await manager!.create("p", "a", undefined, cli); await manager!.send(chat.id, "Request before interruption");
  expect(received.at(-1)).toContain("Response style: standard");
  delete config.agents[0].responseStyle; await manager!.stop(chat.id); expect(store.getConversation(chat.id)?.status).toBe("interrupted");
  expect(received).toHaveLength(1); await manager!.continue(chat.id, "Continue explicitly");
  expect(received.at(-1)).toContain("Response style: explanatory"); expect(received.at(-1)).not.toContain("Response style: standard"); finish();
});

it.each(runtimeIds)("%s Task uses the executing Agent's style and returns its answer without another transformation", async cli => {
  config.responseStyle = "concise"; config.agents.push({ ...config.agents[0], id: "sender", responseStyle: "standard" });
  config.projects[0].agentIds.push("sender"); config.agents[0].responseStyle = "explanatory"; setup(cli);
  const source = await manager!.create("p", "sender", undefined, cli);
  const task = await manager!.createTask(source.id, "a", "Read the synthetic facts", undefined, { policy: "notify" });
  await vi.waitFor(() => expect(inputs).toHaveLength(1)); expect(received.at(-1)).toContain("Response style: explanatory");
  finish("One unmodified final answer");
  await vi.waitFor(() => expect(manager!.listTasks().find(item => item.id === task.id)?.result).toBe("One unmodified final answer"));
  expect(inputs).toEqual(["Read the synthetic facts"]);
});

it.each(["claude", "gemini", "opencode"] as const)("%s ACP wire prompt includes current Mandala context and only the new effective style", async cli => {
  const { connectAcp } = await vi.importActual<typeof import("../server/acp")>("../server/acp");
  const prompts: ContentBlock[][] = [];
  vi.mocked(startNativeRuntime).mockImplementation(async (actualCli, callbacks) => {
    expect(actualCli).toBe(cli);
    const input = new PassThrough(), output = new PassThrough();
    new AgentSideConnection(client => ({
      authenticate: async () => ({}),
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      newSession: async () => ({ sessionId: "wire-session" }), loadSession: async () => ({}), cancel: async () => {},
      async prompt({ sessionId, prompt }) {
        prompts.push(prompt);
        await client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Native wire answer" } } });
        return { stopReason: "end_turn" as const };
      },
    }), ndJsonStream(Writable.toWeb(input), Readable.toWeb(output) as ReadableStream<Uint8Array>));
    return connectAcp(ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as ReadableStream<Uint8Array>), callbacks, () => { input.destroy(); output.destroy(); });
  });
  config.agents[0].defaultCli = cli; config.responseStyle = "concise";
  manager = createSessionManager(store, async () => structuredClone(config), undefined, undefined, home);
  const chat = await manager.create("p", "a", undefined, cli);
  await manager.send(chat.id, "Original user input");
  await expect.poll(() => store.getConversation(chat.id)?.status).toBe("idle");
  config.responseStyle = "explanatory";
  await manager.close(); manager = createSessionManager(store, async () => structuredClone(config), undefined, undefined, home);
  await manager.continue(chat.id, "Resumed user input");
  await expect.poll(() => store.getConversation(chat.id)?.status).toBe("idle");
  const texts = prompts.map(prompt => prompt[0].type === "text" ? prompt[0].text : "");
  expect(texts).toHaveLength(2);
  for (const text of texts) { expect(text).toMatch(/^<mandala-context>\n/); expect(text).toContain("You are an AI assistant running inside Mandala"); expect(text).toContain("Keep this Agent instruction"); expect(text.match(/Response style: /g)).toHaveLength(1); }
  expect(texts[0]).toContain("Response style: concise"); expect(texts[0]).toMatch(/<\/mandala-context>\n\nOriginal user input$/);
  expect(texts[1]).toContain("Response style: explanatory"); expect(texts[1]).not.toContain("Response style: concise"); expect(texts[1]).toMatch(/<\/mandala-context>\n\nResumed user input$/);
  expect(store.getConversation(chat.id)?.nativeId).toBe("wire-session");
  expect(store.listEvents(chat.id, 0).filter(event => event.kind === "text").map(event => (event.data as {text: string}).text)).toEqual(["Native wire answer", "Native wire answer"]);
});
