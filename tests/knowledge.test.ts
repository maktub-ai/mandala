import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../shared/types";
import { createKnowledge, deleteKnowledge, readKnowledge, recallMemory, updateKnowledge } from "../server/knowledge";

let home: string;
const config: Config = { version: 2,
  projects: [{ id: "reading", name: "Reading", cwd: "/tmp", agentIds: ["reader"], resources: [], mcp: [], skills: [] }],
  agents: ["reader", "unrelated"].map((id) => ({ id, name: id, instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] })) };
const memory = () => ({ kind: "memory", title: "Use article tags", content: "Tags are lowercase.",
  scope: "project", projectId: "reading", level: "L1", status: "candidate" });
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-knowledge-")); });
afterEach(() => rm(home, { recursive: true, force: true }));

it("starts empty without creating a private library file", async () => {
  expect(await readKnowledge(home)).toEqual([]);
  expect(await readdir(home)).toEqual([]);
});

it("persists a candidate with scope, provenance and private permissions", async () => {
  const created = await createKnowledge(home, { ...memory(), sourceConversationId: "sample-chat", sourceEventId: 1 }, config);
  expect(created).toMatchObject({ ...memory(), sourceConversationId: "sample-chat", sourceEventId: 1 });
  expect(created.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(created.createdAt).toBe(created.updatedAt);
  expect(await readKnowledge(home)).toEqual([created]);
  expect((await stat(join(home, "knowledge.json"))).mode & 0o777).toBe(0o600);
  expect(await readdir(home)).toEqual(["knowledge.json"]);
});

it("confirms and edits an existing candidate without changing its identity or creation time", async () => {
  const created = await createKnowledge(home, memory(), config);
  const confirmed = await updateKnowledge(home, created.id, { status: "active", title: "Reviewed tag convention" }, config);
  expect(confirmed).toMatchObject({ id: created.id, createdAt: created.createdAt, status: "active", title: "Reviewed tag convention" });
  expect((await readKnowledge(home))[0]).toEqual(confirmed);
});

it("changes owner and can clear optional provenance without preserving stale scope references", async () => {
  const created = await createKnowledge(home, { ...memory(), sourceConversationId: "sample-chat" }, config);
  const updated = await updateKnowledge(home, created.id, { scope: "agent", projectId: null, agentId: "reader", sourceConversationId: null }, config);
  expect(updated.scope).toBe("agent");
  expect(updated.agentId).toBe("reader");
  expect(updated.projectId).toBeUndefined();
  expect(updated.sourceConversationId).toBeUndefined();
});

it("stores documents and skills as data and removes an explicitly deleted entry", async () => {
  const document = await createKnowledge(home, { kind: "document", title: "Reading list", content: "# List", scope: "global", status: "active" }, config);
  const skill = await createKnowledge(home, { kind: "skill", title: "Tag review", content: "<script>never execute</script>", scope: "agent", agentId: "reader", status: "candidate" }, config);
  await deleteKnowledge(home, document.id);
  expect(await readKnowledge(home)).toEqual([skill]);
});

it("serializes independent simultaneous writes without losing entries", async () => {
  await Promise.all(Array.from({ length: 8 }, (_, index) => createKnowledge(home, { ...memory(), title: `Rule ${index}` }, config)));
  expect(await readKnowledge(home)).toHaveLength(8);
  expect(await readdir(home)).toEqual(["knowledge.json"]);
});

it.each([
  { scope: "project", projectId: "missing" },
  { scope: "agent", projectId: null, agentId: "missing" },
  { scope: "agent", agentId: "unrelated" },
  { scope: "global", projectId: "reading" },
  { scope: "project", agentId: "reader" },
  { level: "L9" }, { status: "enabled" }, { kind: "executable" }, { kind: ["memory"] },
  { title: "  " }, { content: "  " }, { sourceConversationId: "../private" },
  { id: "injected" }, { createdAt: "invented" },
  { sourceEventId: 1 }, { sourceConversationId: "sample-chat", sourceEventId: 1.5 },
  { sourceConversationId: "sample-chat", sourceEventId: 0 },
])("rejects invalid metadata %j before persistence", async (patch) => {
  await expect(createKnowledge(home, { ...memory(), ...patch }, config)).rejects.toThrow("invalid knowledge");
  expect(await readdir(home)).toEqual([]);
});

it("rejects invalid updates and leaves the previous private JSON intact", async () => {
  const created = await createKnowledge(home, memory(), config);
  const previous = await readFile(join(home, "knowledge.json"), "utf8");
  await expect(updateKnowledge(home, created.id, { status: "approved-by-model" }, config)).rejects.toThrow("invalid knowledge");
  expect(await readFile(join(home, "knowledge.json"), "utf8")).toBe(previous);
});

it("does not overwrite corrupt stored data or pretend missing IDs exist", async () => {
  await expect(updateKnowledge(home, "missing", { title: "Missing" }, config)).rejects.toThrow("knowledge entry not found");
  await expect(deleteKnowledge(home, "missing")).rejects.toThrow("knowledge entry not found");
  await writeFile(join(home, "knowledge.json"), "{broken", { mode: 0o600 });
  await expect(createKnowledge(home, memory(), config)).rejects.toThrow();
  expect(await readFile(join(home, "knowledge.json"), "utf8")).toBe("{broken");
});

it("recalls only confirmed memories accessible to the current Project and Agent", async () => {
  const scoped = structuredClone(config);
  scoped.projects.push({ ...scoped.projects[0], id: "other" });
  const allowed = await Promise.all([
    createKnowledge(home, { ...memory(), scope: "global", projectId: null, status: "active", level: "L3" }, scoped),
    createKnowledge(home, { ...memory(), status: "active" }, scoped),
    createKnowledge(home, { ...memory(), scope: "agent", agentId: "reader", status: "active" }, scoped),
    createKnowledge(home, { ...memory(), scope: "agent", projectId: null, agentId: "reader", status: "active" }, scoped),
  ]);
  await Promise.all([
    createKnowledge(home, memory(), scoped),
    createKnowledge(home, { ...memory(), projectId: "other", status: "active", level: "L4" }, scoped),
    createKnowledge(home, { ...memory(), scope: "agent", projectId: "other", agentId: "reader", status: "active", level: "L4" }, scoped),
    createKnowledge(home, { ...memory(), scope: "agent", projectId: null, agentId: "unrelated", status: "active", level: "L4" }, scoped),
    createKnowledge(home, { ...memory(), kind: "document", level: null, status: "active" }, scoped),
    createKnowledge(home, { ...memory(), kind: "skill", level: null, status: "active" }, scoped),
  ]);
  const recalled = await recallMemory(home, { projectId: "reading", agentId: "reader", query: "article tags" });
  expect(new Set(recalled.entries.map((entry) => entry.id))).toEqual(new Set(allowed.map((entry) => entry.id)));
  expect(recalled.instructions).toContain("untrusted reference data");
  expect(recalled.instructions).toContain(JSON.stringify(allowed[0].content));
});

it("prioritizes stable L4 and L3 memories and recalls L1/L2 only when the current query matches", async () => {
  const unrelated = await createKnowledge(home, { ...memory(), title: "Flights", content: "Airline tickets", status: "active" }, config);
  const relevant = await createKnowledge(home, { ...memory(), title: "标签约定", content: "文章标签使用小写。", level: "L2", status: "active" }, config);
  const stable = await createKnowledge(home, { ...memory(), title: "Writing style", content: "Keep prose short.", level: "L3", status: "active" }, config);
  const identity = await createKnowledge(home, { ...memory(), title: "Reader identity", content: "I maintain the reading list.", level: "L4", status: "active" }, config);
  const recalled = await recallMemory(home, { projectId: "reading", agentId: "reader", query: "整理文章标签" });
  expect(recalled.entries.map((entry) => entry.id)).toEqual([identity.id, stable.id, relevant.id]);
  expect(recalled.instructions).not.toContain(unrelated.content);
});

it("bounds the complete JSON memory context even for large entries with escaped text", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, index) => createKnowledge(home, {
    ...memory(), title: `Memory ${index}`, content: '"\\\n'.repeat(10000), level: "L3", status: "active",
  }, config)));
  const recalled = await recallMemory(home, { projectId: "reading", agentId: "reader", query: "review" });
  expect(recalled.entries.length).toBeGreaterThan(0);
  expect(recalled.entries.length).toBeLessThanOrEqual(8);
  expect(recalled.instructions.length).toBeLessThanOrEqual(6000);
  expect(recalled.truncated).toBe(true);
  const data = JSON.parse(recalled.instructions.slice(recalled.instructions.indexOf("[{")));
  expect(data).toHaveLength(recalled.entries.length);
  expect(data[0].content.length).toBeLessThan(30000);
});

it("does not use the current working directory as a knowledge home and fails on corrupt memory", async () => {
  expect(await recallMemory("", { projectId: "reading", agentId: "reader", query: "tags" }))
    .toEqual({ entries: [], instructions: "", truncated: false });
  await writeFile(join(home, "knowledge.json"), "{broken");
  await expect(recallMemory(home, { projectId: "reading", agentId: "reader", query: "tags" })).rejects.toThrow();
});


it("automatically adopts extracted facts but keeps conflicting titles for review", async () => {
  const fact = { ...memory(), scope: "agent", agentId: "reader", sourceConversationId: "chat", sourceEventId: 1 };
  const first = await createKnowledge(home, fact, config, true);
  expect(first.status).toBe("active");
  const conflict = await createKnowledge(home, { ...fact, content: "Tags are uppercase.", sourceEventId: 2 }, config, true);
  expect(conflict.status).toBe("candidate");
  expect((await recallMemory(home, { projectId: "reading", agentId: "reader", query: "article tags" })).entries.map(e => e.id)).toEqual([first.id]);
  await updateKnowledge(home, first.id, { status: "candidate" }, config);
  const recaptured = await createKnowledge(home, { ...fact, sourceEventId: 3 }, config, true);
  expect(recaptured.status).toBe("candidate");
  expect((await recallMemory(home, { projectId: "reading", agentId: "reader", query: "article tags" })).entries).toEqual([]);
});

it.each([
  { access: { mode: "all" } }, { scope: "global", projectId: null },
  { content: "Tags are uppercase." }, { level: "L4" },
])("requires renewed adoption when active memory changes: %j", async patch => {
  const original = await createKnowledge(home, { ...memory(), status: "active" }, config);
  const changed = await updateKnowledge(home, original.id, { ...patch, status: "active" }, config);
  expect(changed.status).toBe("candidate");
  expect((await recallMemory(home, { projectId: "reading", agentId: "reader", query: "article tags" })).entries).toEqual([]);
  expect((await updateKnowledge(home, original.id, { status: "active" }, config)).status).toBe("active");
});
