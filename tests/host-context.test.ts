import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionManager } from "../server/sessions";
import { openStore } from "../server/store";
import type { CodexClient, CodexOptions } from "../server/codex";
import type { Config } from "../shared/types";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(["codex", "omp"] as const)("%s receives host identity and current scope on first turn and resume", async cli => {
  const home = mkdtempSync(join(tmpdir(), "mandala-host-context-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const config: Config = {runtimes:['codex','omp'], version: 2, projects: [], agents: [] };
  let options!: CodexOptions;
  const received: string[] = [];
  const factory = async (o: CodexOptions): Promise<CodexClient> => {
    options = o;
    return { getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
      startThread: async p => { if (cli === "codex") received.push(p.instructions); return "native"; },
      resumeThread: async (_id, _mcp, instructions) => { received.push(instructions!); },
      startTurn: async () => "turn", interrupt: async () => {}, replyApproval() {}, close() {} };
  };
  const manager = createSessionManager(store, async () => config, factory, async o => {
    received.push(readFileSync(o.instructions!, "utf8"));
    return factory(o);
  }, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("", "", undefined, cli);
  await manager.send(chat.id, "当前我们这个 APP 叫什么，可以做啥？");
  const session = (instructions: string) => {
    expect(instructions).toContain("running inside Mandala");
    expect(instructions).toContain("local-first");
    expect(instructions).toContain("Reply in the language used by the user");
    expect(instructions).toContain("explicit output-language request takes priority");
    expect(instructions).toContain("not from these instructions, templates, tool output or source code");
    expect(instructions).toContain("unbound project or Agent does not mean there is no host application");
    expect(instructions).not.toContain("OpenMana, open-mana and openmana");
    expect(instructions).toContain("Do not volunteer former product names");
    expect(instructions).not.toContain("CodeGraph status lists");
    expect(instructions).not.toContain("Wiki commands use");
    return JSON.parse(instructions.split("MANDALA_SESSION_JSON:\n")[1].split("\nEND_MANDALA_SESSION_JSON")[0]);
  };
  expect(session(received[0])).toEqual({ conversationId: chat.id, cli, project: null, agent: null,
    workspace: null, cwd: join(home, "workspaces", "conversations", chat.id) });
  options.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
  await manager.send(chat.id, "再介绍一下这个应用");
  expect(received).toHaveLength(2);
  expect(session(received[1])).toEqual(session(received[0]));
});

it("injects bound display names and the selected workspace rather than only background instructions", async () => {
  const home = mkdtempSync(join(tmpdir(), "mandala-host-scope-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const config: Config = {runtimes:['codex','omp'], version: 2,
    projects: [{ id: "p", name: "Project display", cwd: home, agentIds: ["a"], resources: [], mcp: [], skills: [],
      workspaces: [{ id: "w", name: "Workspace display", cwd: home, resources: [] }] }],
    agents: [{ id: "a", name: "Agent display", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }] };
  let instructions = "", options!: CodexOptions;
  const manager = createSessionManager(store, async () => config, async o => {
    options = o;
    return { getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
      startThread: async p => { instructions = p.instructions; return "native"; },
      resumeThread: async (_id, _mcp, next) => { instructions = next!; },
      startTurn: async () => "turn", interrupt: async () => {}, replyApproval() {}, close() {} };
  }, undefined, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a", undefined, "codex", { workspaceId: "w" });
  await manager.send(chat.id, "当前项目是什么？");
  const session = () => {
    expect(instructions).toContain("MANDALA_SESSION_JSON:\n");
    return JSON.parse(instructions.split("MANDALA_SESSION_JSON:\n")[1].split("\nEND_MANDALA_SESSION_JSON")[0]);
  };
  expect(session()).toEqual({ conversationId: chat.id, cli: "codex", project: { id: "p", name: "Project display" },
    agent: { id: "a", name: "Agent display" }, workspace: { id: "w", name: "Workspace display" }, cwd: home });
  options.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
  config.projects[0].name = "Renamed project";
  await manager.send(chat.id, "现在项目叫什么？");
  expect(session().project.name).toBe("Renamed project");
});
