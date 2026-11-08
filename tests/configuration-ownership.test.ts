import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, writeConfig } from "../server/config";
import { conversationContext } from "../server/conversation-context";
import { createKnowledge, recallMemory } from "../server/knowledge";
import type { Config } from "../shared/types";
let home: string;
const fixture = (): Config => ({ version: 2, projects: [{ id: "p", name: "Personal", cwd: "/tmp", agentIds: ["a", "b"], resources: [], mcp: [], skills: [], runtime: { codex: { args: ["--profile", "old-project"], approvalMode: "auto" } } }],
  agents: ["a", "b"].map(id => ({ id, name: id, defaultCli: "codex", instructions: "Read", models: {}, mcp: [{ name: "files", transport: "stdio", command: "personal-mcp" }], skills: [] })) });
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-ownership-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("centralizes old definitions, keeps references stable and retains inactive Project settings", async () => {
  const raw = fixture(); await writeFile(join(home, "config.json"), JSON.stringify(raw));
  const first = await readConfig(home);
  expect(first.config.connections).toHaveLength(1);
  expect(first.config.agents[0].connectionIds).toEqual(first.config.agents[1].connectionIds);
  expect(first.config.agents[0].mcp).toEqual([]);
  expect(first.config.projects[0].runtime).toBeUndefined();
  expect(first.config.projects[0].legacyRuntime).toEqual(raw.projects[0].runtime);
  expect(conversationContext(first.config, { projectId: "p", agentId: "a" }, home).agent.mcp[0].name).toBe("files");
  await writeConfig(home, first.config, first.revision);
  expect((await readConfig(home)).config.connections).toEqual(first.config.connections);
  expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).agents[0].mcp).toEqual([]);
});
it("keeps same-name connections with different definitions distinct and rejects dangling references", async () => {
  const raw = fixture(); raw.agents[1].mcp[0].command = "other-mcp";
  await writeFile(join(home, "config.json"), JSON.stringify(raw));
  const { config, revision } = await readConfig(home);
  expect(config.connections).toHaveLength(2);
  expect(config.agents[0].connectionIds).not.toEqual(config.agents[1].connectionIds);
  config.connections = [];
  await expect(writeConfig(home, config, revision)).rejects.toThrow();
});
it("enforces use permissions independently from ownership and relevance", async () => {
  const config = fixture();
  await createKnowledge(home, { kind: "memory", title: "Personal reading", content: "Read poetry", scope: "global", status: "active", level: "L4", access: { mode: "private" } }, config);
  await createKnowledge(home, { kind: "memory", title: "Shared reading", content: "Read novels", scope: "agent", agentId: "a", status: "active", access: { mode: "selected", agentIds: ["b"] } }, config);
  expect((await recallMemory(home, { projectId: "", agentId: "a", query: "reading" })).entries).toHaveLength(0);
  expect((await recallMemory(home, { projectId: "", agentId: "b", query: "reading" })).entries.map(e => e.title)).toEqual(["Shared reading"]);
});
it("retrieves an allowed referenced document without loading unrelated or private documents", async () => {
  const config = fixture();
  const doc = await createKnowledge(home, { kind: "document", title: "Reading tags", content: "Use lowercase tags", scope: "global", status: "active" }, config);
  expect((await recallMemory(home, { projectId: "p", agentId: "a", query: "reading tags", documentIds: [doc.id] })).entries.map(e => e.id)).toEqual([doc.id]);
  expect((await recallMemory(home, { projectId: "p", agentId: "a", query: "other task", documentIds: [doc.id] })).entries).toHaveLength(0);
  expect((await recallMemory(home, { projectId: "p", agentId: "a", query: "reading tags" })).entries).toHaveLength(0);
});

it("preserves sharing rules across updates and applies Project grants only in that Project", async () => {
  const config = fixture();
  const shared = await createKnowledge(home, { kind: "memory", title: "Reading convention", content: "Use book tags", scope: "agent", agentId: "a", status: "active", level: "L4",
    access: { mode: "selected", projectIds: ["p"] } }, config);
  expect((await recallMemory(home, { projectId: "p", agentId: "b", query: "unrelated" })).entries.map(e => e.id)).toEqual([shared.id]);
  expect((await recallMemory(home, { projectId: "", agentId: "a", query: "reading" })).entries).toHaveLength(0);
  await expect(createKnowledge(home, { kind: "memory", title: "Invalid", content: "Reading", scope: "global", access: { mode: "selected", agentIds: ["missing"] } }, config)).rejects.toThrow();
});
