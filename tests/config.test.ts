import * as fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../server/config";
import { enabledRuntimes } from "../shared/runtimes";
import type { Config } from "../shared/types";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mana-config-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));
const sample = () => ({
  version: 1 as const,
  projects: [{ id: "reading", name: "Reading", cwd: "" }],
  agents: [
    {
      id: "developer",
      name: "Developer",
      instructions: "Build carefully.",
      defaultCli: "codex" as const,
      models: {},
    },
  ],
});
it("initializes_empty_config", async () => {
  expect((await readConfig(home)).config).toEqual({
    version: 2,
    projects: [],
    agents: [],
  });
});
it("reads_saved_agent_and_creates_default_project_directory", async () => {
  await writeConfig(home, sample(), (await readConfig(home)).revision);
  const { config } = await readConfig(home);
  expect(config.agents[0].name).toBe("Developer");
  expect(config.projects[0].cwd).toBe(join(home, "workspaces", "reading"));
  expect((await stat(config.projects[0].cwd)).isDirectory()).toBe(true);
});
it("rejects_stale_revision_without_overwriting_external_edit", async () => {
  const { revision } = await readConfig(home);
  const external = JSON.stringify({ ...sample(), agents: [] });
  await writeFile(join(home, "config.json"), external);
  await expect(writeConfig(home, sample(), revision)).rejects.toThrow(
    "configuration changed",
  );
  expect(await readFile(join(home, "config.json"), "utf8")).toBe(external);
});
it("preserves_invalid_file", async () => {
  await writeFile(join(home, "config.json"), "{broken");
  await expect(readConfig(home)).rejects.toThrow();
  expect(await readFile(join(home, "config.json"), "utf8")).toBe("{broken");
});
it("rejects_path_traversal_project_id_before_creating_directory", async () => {
  const data = sample();
  data.projects[0].id = "../escape";
  await expect(
    writeConfig(home, data, (await readConfig(home)).revision),
  ).rejects.toThrow("invalid");
});
it("rejects literal MCP environment secrets and URL credentials", async () => {
  const legacy = sample();
  const config: Config = {
    version: 2 as const,
    projects: legacy.projects.map((p) => ({ ...p, agentIds: ["developer"], resources: [],
      mcp: [{ name: "private", transport: "stdio" as const, command: "node", env: { API_KEY: "literal-secret" } }], skills: [] })),
    agents: legacy.agents.map((a) => ({ ...a, mcp: [], skills: [] })),
  };
  await expect(writeConfig(home, config, (await readConfig(home)).revision)).rejects.toThrow("invalid");
  config.projects[0].mcp = [{ name: "private", transport: "http",
    url: "https://user:secret@example.test/mcp" }];
  await expect(writeConfig(home, config, (await readConfig(home)).revision)).rejects.toThrow("invalid");
});

it("rejects_external_edit_during_directory_validation", async () => {
  const { revision } = await readConfig(home),
    external = JSON.stringify({ version: 1, projects: [], agents: [] }) + "\n";
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fs.stat).mockImplementationOnce(async (...args) => {
    await writeFile(join(home, "config.json"), external);
    return actual.stat(...args);
  });
  await expect(writeConfig(home, sample(), revision)).rejects.toThrow(
    "configuration changed",
  );
  expect(await readFile(join(home, "config.json"), "utf8")).toBe(external);
});

it("migrates_v1_without_losing_existing_project_agent_choice", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify(sample()));
  const { config } = await readConfig(home);
  expect(config.version).toBe(2);
  expect(config.projects[0].agentIds).toEqual(["developer"]);
  expect(config.projects[0].resources).toEqual([]);
  expect(config.agents[0].models).toEqual({});
  expect(config.agents[0].mcp).toEqual([]);
  expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).version).toBe(1);
});

it("rejects invalid runtime values and system task settings before saving", async () => {
  await writeConfig(home, sample(), (await readConfig(home)).revision);
  const { config, revision } = await readConfig(home);
  for (const runtime of [{ codex: { env: { API_KEY: "literal-secret" } } },
    { codex: { args: ["--listen=http://0.0.0.0:9000"] } }, { omp: { args: "--no-tools" } }]) {
    await expect(writeConfig(home, { ...config, agents: [{ ...config.agents[0], runtime }] } as Config, revision)).rejects.toThrow();
  }
  await expect(writeConfig(home, { ...config, system: { cli: "invalid", automaticTitles: true } } as unknown as Config, revision)).rejects.toThrow();
  await expect(writeConfig(home, { ...config, system: { cli: "codex", memoryCapture: "yes" } } as unknown as Config, revision)).rejects.toThrow();
  expect((await readConfig(home)).revision).toBe(revision);
});

it("preserves custom identity appearance and rejects malformed colors or seeds", async () => {
  const { config, revision } = await readConfig(home);
  config.projects.push({ id: "identity", name: "Identity", cwd: home, agentIds: [], resources: [], mcp: [], skills: [], color: "#38BDF8", avatarSeed: "stable-seed" });
  await writeConfig(home, config, revision);
  const saved = await readConfig(home);
  expect(saved.config.projects[0]).toMatchObject({ color: "#38BDF8", avatarSeed: "stable-seed" });
  for (const patch of [{ color: "red" }, { color: "url(x)" }, { avatarSeed: "" }, { avatarSeed: 42 }, { emoji: "ab" }, { emoji: "🚀🚀" }, { emoji: 1 }, { icon: "made-up" }]) {
    const next = structuredClone(saved.config);
    Object.assign(next.projects[0], patch);
    await expect(writeConfig(home, next, saved.revision)).rejects.toThrow("invalid configuration");
  }
});

it("persists project icons and rejects unsupported icons without changing saved configuration", async () => {
  const { config, revision } = await readConfig(home);
  config.projects.push({ id: "icon-project", name: "Icon project", cwd: home, agentIds: [], resources: [], mcp: [], skills: [] });
  Object.assign(config.projects[0], { icon: "book", color: "#124abc" });
  await writeConfig(home, config, revision);
  const saved = await readConfig(home);
  expect(saved.config.projects[0]).toMatchObject({ icon: "book", color: "#124abc" });
  for (const icon of ["", "unknown", "<svg/>", 42, null, [], {}]) {
    const next = structuredClone(saved.config);
    Object.assign(next.projects[0], { icon });
    await expect(writeConfig(home, next, saved.revision)).rejects.toThrow("invalid configuration");
  }
  expect((await readConfig(home)).revision).toBe(saved.revision);
});

it("preserves independent system task routes alongside the shared fallback", async () => {
  const { config, revision } = await readConfig(home);
  const system = { cli: "codex", model: "shared-default", automaticTitles: true, memoryCapture: false,
    tasks: { title: { cli: "omp", model: "small-title-model" }, memory: { cli: "codex" }, taskProgress: { cli: "omp", model: "task-judge" } } };
  await writeConfig(home, { ...config, system } as Config, revision);
  expect((await readConfig(home)).config.system).toEqual(system);
});

it.each([
  null, [], "title", { summary: { cli: "codex" } }, { title: null }, { title: [] },
  { title: {} }, { memory: { cli: "invalid" } }, { title: { cli: "codex", model: 1 } },
  { memory: { cli: "omp", model: "x".repeat(201) } }, { title: { cli: "codex", token: "literal" } },
].map((tasks) => ({ tasks })))("rejects malformed task-specific system routes before saving: $tasks", async ({ tasks }) => {
  const { config, revision } = await readConfig(home);
  await expect(writeConfig(home, { ...config, system: { cli: "codex", tasks } } as unknown as Config, revision)).rejects.toThrow("invalid configuration");
  expect((await readConfig(home)).revision).toBe(revision);
});

it.each([[], ["codex"], ["omp"], ["omp", "codex"]].map((runtimes) => ({ runtimes })))(
  "preserves the enabled runtime list without rejecting an agent using a disabled CLI: $runtimes", async ({ runtimes }) => {
    await writeConfig(home, sample(), (await readConfig(home)).revision);
    const { config, revision } = await readConfig(home);
    await writeConfig(home, { ...config, runtimes } as Config, revision);
    const saved = (await readConfig(home)).config;
    expect((saved as Config & { runtimes: string[] }).runtimes).toEqual(runtimes);
    expect(saved.agents[0].defaultCli).toBe("codex");
  },
);

it.each([null, "codex", {}, ["unknown-runtime"], ["codex", "codex"], ["omp", "omp"], ["codex", 1], ["Codex"]]
  .map((runtimes) => ({ runtimes })))("rejects invalid or duplicate enabled runtime entries: $runtimes", async ({ runtimes }) => {
  const { config, revision } = await readConfig(home);
  await expect(writeConfig(home, { ...config, runtimes } as unknown as Config, revision)).rejects.toThrow("invalid configuration");
  expect((await readConfig(home)).revision).toBe(revision);
});


it("retains the saved legacy executor while respecting an explicit empty list", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify(sample()));
  const { config } = await readConfig(home);
  expect(config.runtimes).toBeUndefined();
  expect(enabledRuntimes(config)).toEqual(["codex"]);
  expect(enabledRuntimes({ runtimes: [] })).toEqual([]);
  const selected: Config = { ...config, runtimes: ["omp"] };
  const enabled = enabledRuntimes(selected);
  expect(enabled).toEqual(["omp"]);
  enabled.push("codex");
  expect(selected.runtimes).toEqual(["omp"]);
});

it("migrates a legacy Project directory and resources to its default Workspace without writing on read", async () => {
  const legacy = { version: 2, projects: [{ id: "p", name: "Personal", cwd: home, resources: [
    { id: "r", label: "Notes", kind: "local", location: home }], agentIds: [], mcp: [], skills: [] }], agents: [] };
  const text = JSON.stringify(legacy);
  await writeFile(join(home, "config.json"), text);
  expect((await readConfig(home)).config.projects[0].workspaces).toEqual([
    { id: "default", name: "Default", cwd: home, resources: legacy.projects[0].resources }]);
  expect(await readFile(join(home, "config.json"), "utf8")).toBe(text);
});
it("saves multiple Workspaces and permits a Project with none", async () => {
  const { revision } = await readConfig(home);
  const value = { version: 2 as const, agents: [], projects: [
    { id: "p", name: "Personal", cwd: "", resources: [], agentIds: [], mcp: [], skills: [], workspaces: [
      { id: "notes", name: "Notes", cwd: home, resources: [] },
      { id: "drafts", name: "Drafts", cwd: "/tmp", resources: [] }] },
    { id: "planning", name: "Planning", cwd: "", resources: [], agentIds: [], mcp: [], skills: [], workspaces: [] },
  ] };
  await writeConfig(home, value, revision);
  const saved = (await readConfig(home)).config;
  expect(saved.projects[0].workspaces).toHaveLength(2);
  expect(saved.projects[1].workspaces).toEqual([]);
  expect(saved.projects[1].cwd).toBe("");
});
it("rejects duplicate or invalid Workspace definitions before writing", async () => {
  const { revision } = await readConfig(home);
  const value = { version: 2 as const, agents: [], projects: [{ id: "p", name: "Personal", cwd: home,
    resources: [], agentIds: [], mcp: [], skills: [], workspaces: [
      { id: "notes", name: "Notes", cwd: home, resources: [] },
      { id: "notes", name: "Duplicate", cwd: "/tmp", resources: [] }] }] };
  await expect(writeConfig(home, value, revision)).rejects.toThrow("invalid");
});

it("keeps directories and resources in one canonical Workspace definition in the config file", async () => {
  await writeConfig(home, sample(), (await readConfig(home)).revision);
  const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  expect(raw.projects[0].cwd).toBeUndefined();
  expect(raw.projects[0].resources).toBeUndefined();
  raw.projects[0].workspaces[0].cwd = "/tmp";
  await writeFile(join(home, "config.json"), JSON.stringify(raw));
  expect((await readConfig(home)).config.projects[0].cwd).toBe("/tmp");
});

it.each([['codex','yes'],['omp',true]])('rejects invalid or unsupported full access for %s',async(cli,fullAccess)=>{
 const config:Config={version:2,projects:[],agents:[{id:'dev',name:'Dev',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[],runtime:{[cli]:{fullAccess}} as any}]};
 await expect(writeConfig(home,config,(await readConfig(home)).revision)).rejects.toThrow('invalid');
});

it('accepts ACP runtimes and validates their models and managed arguments',async()=>{
 const config:Config={version:2,projects:[],agents:[{id:'acp',name:'ACP',instructions:'',defaultCli:'gemini',models:{gemini:'native-model'},skills:[],mcp:[]}],runtimes:['claude','gemini','opencode']};
 await writeConfig(home,config,(await readConfig(home)).revision);
 expect((await readConfig(home)).config.runtimes).toEqual(config.runtimes);
 config.agents[0].runtime={gemini:{args:['--yolo']}};
 await expect(writeConfig(home,config,(await readConfig(home)).revision)).rejects.toThrow(/managed/);
});

it.each(['zh-CN','en'] as const)('persists the memory output language %s',async language=>{
 const {config,revision}=await readConfig(home);
 await writeConfig(home,{...config,system:{cli:'codex',memory:{language}}},revision);
 expect((await readConfig(home)).config.system?.memory?.language).toBe(language);
});
it('rejects unsupported memory language preferences',async()=>{
 const {config,revision}=await readConfig(home);
 await expect(writeConfig(home,{...config,system:{cli:'codex',memory:{language:'unsupported'}}} as unknown as Config,revision)).rejects.toThrow();
});

it('progress disable revision survives re-enable and ignores rejected saves',async()=>{
 const {taskProgressSettingsRevision}=await import('../server/config');
 let saved=await readConfig(home);const initial=taskProgressSettingsRevision(home);
 await expect(writeConfig(home,{...saved.config,system:{cli:'codex',automaticTaskProgress:false}},'stale')).rejects.toThrow();
 expect(taskProgressSettingsRevision(home)).toBe(initial);
 await writeConfig(home,{...saved.config,system:{cli:'codex',automaticTaskProgress:false}},saved.revision);
 const disabled=taskProgressSettingsRevision(home);expect(disabled).toBeGreaterThan(initial);
 saved=await readConfig(home);await writeConfig(home,{...saved.config,system:{...saved.config.system!,automaticTaskProgress:true}},saved.revision);
 expect(taskProgressSettingsRevision(home)).toBe(disabled);
});

it("round-trips emoji and icon symbols for Agents and Projects", async () => {
  let saved = await readConfig(home);
  const next = structuredClone(saved.config);
  next.projects = [{ id: "emoji", name: "Emoji", cwd: home, agentIds: [], resources: [], mcp: [], skills: [], emoji: "🧑‍💻" }];
  next.agents = [...next.agents, { id: "emoji-agent", name: "Emoji agent", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [], icon: "rocket" }];
  await writeConfig(home, next, saved.revision);
  saved = await readConfig(home);
  expect(saved.config.projects[0].emoji).toBe("🧑‍💻");
  expect(saved.config.agents.find(a => a.id === "emoji-agent")?.icon).toBe("rocket");
  const bad = structuredClone(saved.config);
  bad.agents.find(a => a.id === "emoji-agent")!.emoji = "hi";
  await expect(writeConfig(home, bad, saved.revision)).rejects.toThrow("invalid configuration");
});

it("round-trips every supported project icon through config validation", async () => {
  const { projectIcons } = await import("../shared/identity");
  let saved = await readConfig(home);
  for (const icon of projectIcons) {
    const next = structuredClone(saved.config);
    next.projects = [{ id: "icons", name: "Icons", cwd: home, agentIds: [], resources: [], mcp: [], skills: [], icon }];
    await writeConfig(home, next, saved.revision);
    saved = await readConfig(home);
    expect(saved.config.projects[0].icon).toBe(icon);
  }
});

it.each(['claude','gemini','opencode'] as const)('persists %s system defaults and task-specific routes',async cli=>{
 const {config,revision}=await readConfig(home);
 const system={cli,tasks:{title:{cli},memory:{cli},taskProgress:{cli}}};
 await writeConfig(home,{...config,runtimes:[cli],system},revision);
 expect((await readConfig(home)).config.system).toEqual(system);
});
