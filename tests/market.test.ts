import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../server/config";
import { createMarket } from "../server/market";
import { conversationContext } from "../server/conversation-context";
import { prepareCapabilityRuntime } from "../server/omp";

let home: string;
const sha = "a".repeat(40);
const text = "---\nname: sample\ndescription: A synthetic workflow\n---\nRead references/guide.md before answering.";
const tree = ["skills/sample/SKILL.md", "skills/sample/references/guide.md", "LICENSE"].map(path => ({ path, type: "blob", mode: "100644", size: 120 }));
const mcp = { name: "org.example/demo", description: "Synthetic MCP", version: "1.2.0", packages: [{ registryType: "npm", identifier: "@example/demo", version: "1.2.0", transport: { type: "stdio" } }] };
const fetcher = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("git/trees")) return Response.json({ sha, truncated: false, tree });
  if (url.includes("registry.modelcontextprotocol.io")) return Response.json({ servers: [{ server: mcp, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } }], metadata: {} });
  return new Response(url.endsWith("SKILL.md") ? text : "Synthetic resource");
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mana-market-"));
  const { config, revision } = await readConfig(home);
  config.agents.push({ id: "a", name: "Researcher", instructions: "", defaultCli: "codex", models: {}, skills: [], mcp: [] });
  config.projects.push({ id: "p", name: "Reading", cwd: "", resources: [], agentIds: ["a"], skills: [], mcp: [] });
  await writeConfig(home, config, revision);
  fetcher.mockClear();
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it("downloads the pinned Skill and all resources, links Agent/Project, and reloads installation metadata", async () => {
  const market = createMarket(home, fetcher);
  const result = await market.search("skill", "sample");
  expect(result.items).toHaveLength(1);
  const detail = await market.detail(result.items[0].catalogId);
  expect(detail.description).toBe("A synthetic workflow");
  expect(detail.version).toBe(sha);
  const current = await readConfig(home);
  const installed = await market.install({ catalogId: detail.catalogId, version: detail.version, revision: current.revision, targets: [{ kind: "agent", id: "a" }, { kind: "project", id: "p" }] });
  const saved = await readConfig(home);
  const context = conversationContext(saved.config, { projectId: "p", agentId: "a" }, home);
  expect(context.agent.skills[0].name).toBe("sample");
  expect(context.project.skills[0]).toEqual(context.agent.skills[0]);
  expect(await readFile(join(context.agent.skills[0].path, "SKILL.md"), "utf8")).toBe(text);
  expect(await readFile(join(context.agent.skills[0].path, "references/guide.md"), "utf8")).toBe("Synthetic resource");
  const runtime = await prepareCapabilityRuntime(home, "synthetic-chat", [], context.agent.skills);
  expect(await readFile(join(runtime, "skills/sample/SKILL.md"), "utf8")).toBe(text);
  expect(await readFile(join(runtime, "skills/sample/references/guide.md"), "utf8")).toBe("Synthetic resource");
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("raw.githubusercontent.com")).every(([url]) => String(url).includes(sha))).toBe(true);
  expect((await createMarket(home, fetcher).installed())[0].id).toBe(installed.id);
  expect((await market.installed())[0].targets).toHaveLength(2);
});

it("deduplicates installs, preserves unrelated references, and requires unlinking before uninstall", async () => {
  const market = createMarket(home, fetcher);
  const item = (await market.search("skill", "sample")).items[0];
  const detail = await market.detail(item.catalogId);
  const install = () => readConfig(home).then(({ revision }) => market.install({ catalogId: item.catalogId, version: detail.version, revision, targets: [{ kind: "agent", id: "a" }] }));
  const first = await install(); await install();
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
  await expect(market.uninstall(first.id, (await readConfig(home)).revision)).rejects.toThrow(/referenced/);
  await market.unlink(first.id, { kind: "agent", id: "a" }, (await readConfig(home)).revision);
  await market.uninstall(first.id, (await readConfig(home)).revision);
  expect(await market.installed()).toEqual([]);
  expect((await readConfig(home)).config.skillLibrary).toEqual([]);
  expect(await readdir(join(home, "market", "packages"))).toEqual([]);
});

it.each(["skill", "mcp"] as const)("unlinks a paused %s from an Agent and Project before uninstalling without disturbing other assignments", async kind => {
  const market = createMarket(home, fetcher);
  const detail = await market.detail(kind === "skill" ? "skill:anthropics/sample" : "mcp:org.example/demo");
  const targets = [{ kind: "agent", id: "a" }, { kind: "project", id: "p" }] as const;
  const installed = await market.install({ catalogId: detail.catalogId, version: detail.version,
    revision: (await readConfig(home)).revision, targets: [...targets] });
  const snapshot = await readConfig(home);
  const field = kind === "skill" ? "skillIds" : "connectionIds";
  const disabledField = kind === "skill" ? "disabledSkillIds" : "disabledConnectionIds";
  if (kind === "skill") snapshot.config.skillLibrary!.push({ id: "other", name: "other", path: home });
  else snapshot.config.connections!.push({ id: "other", name: "other", transport: "http", url: "https://example.test/mcp" });
  for (const owner of [snapshot.config.agents[0], snapshot.config.projects[0]]) {
    owner[field] = [...owner[field]!, "other"];
    owner[disabledField] = [installed.id, "other"];
  }
  await writeConfig(home, snapshot.config, snapshot.revision);
  await market.unlink(installed.id, targets[0], (await readConfig(home)).revision);
  const partial = (await readConfig(home)).config;
  expect(partial.agents[0][field]).toEqual(["other"]);
  expect(partial.agents[0][disabledField]).toEqual(["other"]);
  expect(partial.projects[0][disabledField]).toEqual([installed.id, "other"]);
  await expect(market.uninstall(installed.id, (await readConfig(home)).revision)).rejects.toThrow(/referenced/);
  await market.unlink(installed.id, targets[1], (await readConfig(home)).revision);
  await market.uninstall(installed.id, (await readConfig(home)).revision);
  const final = (await readConfig(home)).config;
  expect(final.projects[0][field]).toEqual(["other"]);
  expect(final.projects[0][disabledField]).toEqual(["other"]);
  expect((kind === "skill" ? final.skillLibrary : final.connections)?.map(item => item.id)).toEqual(["other"]);
  expect(await market.installed()).toEqual([]);
});

it("does not download or change config on a stale revision or invalid target", async () => {
  const market = createMarket(home, fetcher);
  const detail = await market.detail("skill:anthropics/sample");
  fetcher.mockClear();
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: "stale", targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow("configuration changed");
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "project", id: "absent" }] })).rejects.toThrow(/invalid/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("rolls back downloaded files when config changes during installation", async () => {
  const racingFetch = async (input: string | URL | Request) => {
    if (String(input).endsWith("references/guide.md")) {
      const latest = await readConfig(home); latest.config.agents[0].name = "External edit";
      await writeConfig(home, latest.config, latest.revision);
    }
    return fetcher(input);
  };
  const market = createMarket(home, racingFetch);
  const detail = await market.detail("skill:anthropics/sample");
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow("configuration changed");
  expect((await readConfig(home)).config.agents[0].name).toBe("External edit");
  expect(await readdir(join(home, "market", "packages"))).toEqual([]);
});

it("installs a versioned npm MCP using argument arrays and Project references", async () => {
  const market = createMarket(home, fetcher);
  const search = await market.search("mcp", "demo");
  expect(search.items[0].name).toBe("demo");
  const detail = await market.detail(search.items[0].catalogId);
  const installed = await market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "project", id: "p" }] });
  const config = (await readConfig(home)).config;
  expect(config.connections?.[0]).toMatchObject({ id: installed.id, transport: "stdio", command: "npx", args: ["--yes", "@example/demo@1.2.0"] });
  expect(conversationContext(config, { projectId: "p", agentId: "a" }, home).project.mcp).toHaveLength(1);
});

it("rejects untrusted package paths and changed versions", async () => {
  const badFetch = async () => Response.json({ sha, tree: [...tree, { path: "skills/sample/../../escape", type: "blob", mode: "100644", size: 1 }] });
  const market = createMarket(home, badFetch);
  await expect(market.detail("skill:anthropics/sample")).rejects.toThrow(/invalid/);
  const service = createMarket(home, fetcher);
  const detail = await service.detail("skill:anthropics/sample");
  await expect(service.install({ catalogId: detail.catalogId, version: "new-version", revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow(/changed/);
  await expect(service.detail("skill:anthropics/../../outside")).rejects.toThrow(/invalid/);
});

it.each([
  { path: "skills/sample/link", type: "blob", mode: "120000", size: 1 },
  { path: "skills/sample/submodule", type: "commit", mode: "160000", size: 1 },
])("refuses incomplete Skill packages containing $type $mode entries", async entry => {
  const market = createMarket(home, async url => url.includes("git/trees") ? Response.json({ sha, tree: [...tree, entry] }) : fetcher(url));
  await expect(market.detail("skill:anthropics/sample")).rejects.toThrow("invalid Skill package files");
  expect((await readConfig(home)).config.marketInstallations).toBeUndefined();
});

const registryFetch = (server: object) => async () => Response.json({ servers: [{ server, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } }], metadata: {} });

it("refuses required raw secrets and unknown environment fields, but saves named references", async () => {
  const server = { ...mcp, packages: [{ ...mcp.packages[0], environmentVariables: [{ name: "DEMO_KEY", isRequired: true }] }] };
  const market = createMarket(home, registryFetch(server));
  const detail = await market.detail("mcp:org.example/demo");
  const input = { catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent" as const, id: "a" }] };
  const invalidReferences: Record<string, string>[] = [{}, { DEMO_KEY: "synthetic-secret" }, { DEMO_KEY: "${DEMO_KEY}", OTHER: "${OTHER}" }];
  for (const environment of invalidReferences) {
    await expect(market.install({ ...input, environment })).rejects.toThrow("invalid MCP environment references");
    expect((await readConfig(home)).config.connections).toBeUndefined();
  }
  const installation = await market.install({ ...input, environment: { DEMO_KEY: "${DEMO_KEY}" } });
  expect((await readConfig(home)).config.connections?.[0]).toMatchObject({ name: "org-example-demo", env: { DEMO_KEY: "${DEMO_KEY}" } });
  await market.unlink(installation.id, input.targets[0], (await readConfig(home)).revision);
  await market.uninstall(installation.id, (await readConfig(home)).revision);
  expect((await readConfig(home)).config.connections).toEqual([]);
});

it("installs a public HTTPS MCP and keeps installed metadata available offline", async () => {
  const server = { ...mcp, packages: [], remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp" }] };
  const market = createMarket(home, registryFetch(server));
  const detail = await market.detail("mcp:org.example/demo");
  await market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "project", id: "p" }] });
  expect((await readConfig(home)).config.connections?.[0]).toMatchObject({ transport: "http", url: "https://mcp.example.org/mcp" });
  const offline = createMarket(home, async () => { throw new Error("offline"); });
  expect((await offline.installed())[0]).toMatchObject({ missing: false, targets: [{ kind: "project", id: "p", name: "Reading" }] });
});

it.each([
  { ...mcp, packages: [], remotes: [{ type: "streamable-http", url: "https://localhost/mcp" }] },
  { ...mcp, packages: [{ ...mcp.packages[0], runtimeArguments: [{ value: "--package=other" }] }] },
  { ...mcp, packages: [{ ...mcp.packages[0], packageArguments: [{ type: "positional", value: "{credential}" }] }] },
])("shows unsupported connections without installing them (%#)", async server => {
  const market = createMarket(home, registryFetch(server));
  const detail = await market.detail("mcp:org.example/demo");
  expect(detail.unsupported).toContain("unsupported");
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow(/unsupported/);
  expect(await market.installed()).toEqual([]);
});

it("serializes simultaneous installs and rejects a stale second write without duplicating packages", async () => {
  const market = createMarket(home, fetcher);
  const detail = await market.detail("skill:anthropics/sample");
  const input = { catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent" as const, id: "a" }] };
  const results = await Promise.allSettled([market.install(input), market.install(input)]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("configuration changed");
  expect(await market.installed()).toHaveLength(1);
  expect(await readdir(join(home, "market", "packages"))).toHaveLength(1);
});

it("reads YAML multiline descriptions for searchable catalog cards", async () => {
  const readme = '---\nname: sample\ndescription: >-\n  Create useful designs\n  with deliberate typography.\n---\n# Sample';
  const market = createMarket(home, url => url.endsWith("SKILL.md") ? Promise.resolve(new Response(readme)) : fetcher(url));
  expect((await market.search("skill", "typography")).items[0].description).toBe("Create useful designs with deliberate typography.");
  expect((await market.detail("skill:anthropics/sample")).description).not.toBe(">-");
});
it("uses MCP registry update dates while leaving repository popularity unreported", async () => {
  const entries = ["2025-01-01T00:00:00Z", "2026-09-01T00:00:00Z"].map((updatedAt, index) => ({
    server: { name: `org.example/server-${index}`, version: "1.0.0", description: "Synthetic date-ranked MCP", remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp" }] },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, updatedAt } },
  }));
  const market = createMarket(home, async () => Response.json({ servers: entries }));
  const result = await market.search("mcp", "", "", "mcp-registry", "updated");
  expect(result.items.map(item => item.name)).toEqual(["server-1", "server-0"]);
  expect(result.items[0].updatedAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
  expect(result.items.every(item => item.stats === undefined)).toBe(true);
});

it("preserves usable MCP entries when a current registry payload contains malformed optional arrays or rows", async () => {
  const entries = [mcp, { ...mcp, name: "org.example/invalid-packages", remotes: {}, packages: {} }, null,
    { ...mcp, name: "org.example/invalid-args", packages: [{ ...mcp.packages[0], runtimeArguments: {} }] }];
  const market = createMarket(home, async () => Response.json({ servers: entries.map(server => ({ server, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } })) }));
  const result = await market.search("mcp");
  expect(result.items.some(item => item.catalogId === "mcp:org.example/demo")).toBe(true);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings![0]).toContain("3");
});
it("validates the entire GitHub tree response before accessing untrusted paths", async () => {
  for (const entry of [null, { type: "blob", path: 4, mode: "100644" }]) {
    const market = createMarket(home, async () => Response.json({ sha, tree: [entry] }));
    await expect(market.search("skill")).rejects.toThrow("invalid Skill directory response");
  }
});
it("keeps manifest failures visible while preserving other searchable skills", async () => {
  const market = createMarket(home, async url => url.includes("git/trees") ? Response.json({sha, tree}) : new Response("source unavailable", {status:503}));
  const result = await market.search("skill");
  expect(result.items).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("HTTP 503");
});

it("returns partial GitHub cards within the description budget and aborts pending manifests", async () => {
  const signals: AbortSignal[] = [];
  const market = createMarket(home, async (url, signal) => {
    if (url.includes("git/trees")) return Response.json({ sha, tree });
    signals.push(signal!);
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const resultPromise = market.search("skill");
  // Wait for the asynchronous source settings read to reach the stalled network boundary.
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  const result = await resultPromise;
  expect(result.items).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("timed out");
  expect(signals[0].aborted).toBe(true);
}, 8_000);
