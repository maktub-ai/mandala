import { responseStyles } from "../shared/response-style";
import { renameSync, readFileSync } from "node:fs";
import { createSkillCatalog } from "./skill-catalog";
import { withSkillEvidenceRead } from "./skill-evidence";
import { openStore } from "./store";
import { enabledRuntimes, runtimeIds, isCli, supportsSystemTasks } from "../shared/runtimes";
import { validateEffort } from "../shared/chat-input";
import { normalizeCatalog } from "./catalog";
import { linkedCapabilities } from "../shared/catalog";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Config, LegacyConfig } from "../shared/types";
import { projectWorkspaces } from "../shared/workspaces";
import { isRemoteAbsolutePath, isValidSshHost } from "../shared/execution-machines";
import { validateRuntimeArgs, validateRuntimeEnv } from "./runtime";
import { validateManagedSkillContent } from "../shared/skills";
import { isIdentityEmoji, projectIcons } from "../shared/identity";
const mandalaAuthority = Symbol("mandala-config");
const empty: Config = { version: 2, projects: [], agents: [] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function normalizeConfig(value: unknown): Config {
  const c = value as Config | LegacyConfig;
  if (!c || !Array.isArray(c.projects) || !Array.isArray(c.agents))
    throw new Error("invalid configuration");
  if (c.version === 2) return normalizeCatalog({ ...c, projects: c.projects.map(p => ({ ...p,
    cwd: p.workspaces !== undefined ? p.workspaces[0]?.cwd ?? "" : p.cwd,
    resources: p.workspaces !== undefined ? p.workspaces[0]?.resources ?? [] : p.resources,
    workspaces: projectWorkspaces(p),
  })) });
  if (c.version !== 1) throw new Error("invalid configuration");
  return {
    version: 2,
    projects: c.projects.map((p) => ({
      ...p,
      agentIds: c.agents.map((a) => a.id),
      resources: [],
      mcp: [],
      skills: [],
      workspaces: [{ id: "default", name: "Default", cwd: p.cwd, resources: [] }],
    })),
    agents: c.agents.map((a) => ({ ...a, mcp: [], skills: [] })),
  };
}
export function validateConfig(value: unknown): asserts value is Config {
  const c = value as Config;
  const invalid = () => {
    throw new Error("invalid configuration");
  };
  if (
    !c ||
    c.version !== 2 ||
    !Array.isArray(c.projects) ||
    !Array.isArray(c.agents)
  )
    invalid();
  if (c.responseStyle !== undefined && !responseStyles.includes(c.responseStyle)) invalid();
  if (c.runtimes !== undefined && (!Array.isArray(c.runtimes) ||
      c.runtimes.some((cli) => !isCli(cli)) ||
      new Set(c.runtimes).size !== c.runtimes.length)) invalid();
  if (c.chatDefaults !== undefined) {
    if (!c.chatDefaults || typeof c.chatDefaults !== "object" || Array.isArray(c.chatDefaults) ||
        Object.keys(c.chatDefaults).some(key => !isCli(key))) invalid();
    for (const value of Object.values(c.chatDefaults)) {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some(key => !["model", "effort"].includes(key)) ||
          (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200))) invalid();
      if (value.effort !== undefined) validateEffort(value.effort);
    }
  }
  if (c.marketInstallations !== undefined) {
    if (!Array.isArray(c.marketInstallations)) invalid();
    const seen = new Set<string>();
    for (const item of c.marketInstallations) {
      if (!item || !/^market-[a-f0-9]{20}$/.test(item.id) || seen.has(item.id) ||
          !["skill", "mcp"].includes(item.kind) || typeof item.catalogId !== "string" ||
          !(item.kind === "skill" ? /^skill:(?:anthropics\/[A-Za-z0-9_-]+|github:[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_-]{1,100}|clawhub\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,100})$/ : /^mcp:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).test(item.catalogId) ||
          typeof item.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.name) ||
          typeof item.description !== "string" || item.description.length > 5000 ||
          typeof item.version !== "string" || !item.version || item.version.length > 100 ||
          typeof item.sourceUrl !== "string" || !/^https:\/\//.test(item.sourceUrl) || item.sourceUrl.length > 2048 ||
          typeof item.installedAt !== "string" || !Number.isFinite(Date.parse(item.installedAt)) ||
          (item.packageId !== undefined && (item.kind !== "skill" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.packageId)))) invalid();
      seen.add(item.id);
    }
  }
  const ids = (items: { id: string; name: string }[]) => {
    const seen = new Set<string>();
    for (const x of items) {
      if (
        !x ||
        typeof x.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id) ||
        seen.has(x.id) ||
        typeof x.name !== "string" ||
        !x.name.trim() ||
        ("color" in x && (typeof x.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(x.color))) ||
        ("avatarSeed" in x && (typeof x.avatarSeed !== "string" || !x.avatarSeed.trim() || x.avatarSeed.length > 128))
      )
        invalid();
      seen.add(x.id);
    }
  };
  for(const item of [...c.projects,...c.agents])if(item.archivedAt!==undefined&&(typeof item.archivedAt!=='string'||!Number.isFinite(Date.parse(item.archivedAt))))invalid();
  for(const agent of c.agents)if(agent.temporary!==undefined&&typeof agent.temporary!=='boolean')invalid();
  ids(c.projects);
  ids(c.agents);
  if (c.executionMachines !== undefined) {
    if (!Array.isArray(c.executionMachines)) invalid();
    ids(c.executionMachines);
    const hosts = new Set<string>();
    for (const machine of c.executionMachines) {
      if (!isValidSshHost(machine.host) || hosts.has(machine.host)) invalid();
      hosts.add(machine.host);
    }
  }
  const machineIds = new Set((c.executionMachines ?? []).map(machine => machine.id));
  if ([...c.projects, ...c.agents].some(item => (item.icon !== undefined && !projectIcons.includes(item.icon)) || (item.emoji !== undefined && !isIdentityEmoji(item.emoji)))) invalid();
  if (c.system !== undefined && (!c.system || typeof c.system !== "object" || Array.isArray(c.system) || (c.system.cli !== undefined && (!isCli(c.system.cli) || !supportsSystemTasks(c.system.cli))) ||
      (c.system.model !== undefined && (typeof c.system.model !== "string" || c.system.model.length > 200)) ||
      (c.system.automaticTaskProgress !== undefined && typeof c.system.automaticTaskProgress !== "boolean") ||
      (c.system.automaticTitles !== undefined && typeof c.system.automaticTitles !== "boolean") ||
      (c.system.skillLearning !== undefined && typeof c.system.skillLearning !== "boolean") ||
      (c.system.memoryCapture !== undefined && typeof c.system.memoryCapture !== "boolean"))) invalid();
  if (c.system?.memory !== undefined) {
    const memory = c.system.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory) ||
        Object.keys(memory).some(key => !["request", "session", "idleHours", "language"].includes(key))) invalid();
    if (memory.language !== undefined && !["zh-CN", "en"].includes(memory.language)) invalid();
    for (const kind of ["request", "session"] as const) {
      const controls = memory[kind];
      if (controls === undefined) continue;
      if (!controls || typeof controls !== "object" || Array.isArray(controls) ||
          Object.keys(controls).some(key => !["generate", "read"].includes(key)) ||
          Object.values(controls).some(value => typeof value !== "boolean")) invalid();
    }
    if (memory.idleHours !== undefined && (typeof memory.idleHours !== "number" ||
        !Number.isFinite(memory.idleHours) || memory.idleHours <= 0 || memory.idleHours > 168)) invalid();
  }
  if (c.system?.tasks !== undefined) {
    const tasks = c.system.tasks;
    if (!tasks || typeof tasks !== "object" || Array.isArray(tasks) ||
        Object.keys(tasks).some((kind) => !["title", "memory", "taskProgress"].includes(kind))) invalid();
    for (const task of Object.values(tasks)) {
      if (!task || typeof task !== "object" || Array.isArray(task) ||
          Object.keys(task).some((key) => !["cli", "model"].includes(key)) ||
          !isCli(task.cli) || !supportsSystemTasks(task.cli) ||
          (task.model !== undefined && (typeof task.model !== "string" || task.model.length > 200))) invalid();
    }
  }
  const validateRuntime = (runtime: Config["agents"][number]["runtime"]) => {
    if (runtime === undefined) return;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
        Object.keys(runtime).some((key) => !isCli(key))) invalid();
    for (const cli of runtimeIds) {
      const value = runtime[cli];
      if (value === undefined) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
      if(value.gateway!==undefined&&!['native','unavailable'].includes(value.gateway))invalid();
      if (value.approvalMode !== undefined && !["default", "strict", "auto"].includes(value.approvalMode)) invalid();
      if (value.fullAccess !== undefined && (cli !== "codex" || typeof value.fullAccess !== "boolean")) invalid();
      if (value.args !== undefined) validateRuntimeArgs(cli, value.args);
      if (value.env !== undefined && (!value.env || typeof value.env !== "object" || Array.isArray(value.env) ||
          Object.keys(value.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
          Object.values(value.env).some((ref) => typeof ref !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)))) invalid();
      if (value.env !== undefined) validateRuntimeEnv(value.env);
    }
  };
  validateRuntime(c.runtimeDefaults);
  const managed = c.agents.filter(a => a.systemRole !== undefined);
  if (managed.some(a => a.systemRole !== "mandala" || !a.managedWorkspace || !isAbsolute(a.managedWorkspace)) ||
      managed.length > 1 || c.agents.some(a => a.managedWorkspace !== undefined && a.systemRole !== "mandala")) invalid();
  if (c.mandala !== undefined) {
    const settings = c.mandala;
    if (!settings || Object.keys(settings).some(key => !["agentId", "soul", "maxParallel"].includes(key)) ||
        managed.length !== 1 || managed[0].id !== settings.agentId ||
        typeof settings.soul !== "string" || settings.soul.length > 30000 ||
        !Number.isSafeInteger(settings.maxParallel) || settings.maxParallel < 1) invalid();
  } else if (managed.length) invalid();
  const agentIds = new Set(c.agents.map((a) => a.id));
  const validateCapabilities = (owner: { mcp: unknown; skills: unknown }) => {
    if (!Array.isArray(owner.mcp) || !Array.isArray(owner.skills)) invalid();
    const mcpNames = new Set<string>(), skillNames = new Set<string>();
    for (const m of owner.mcp as unknown[]) {
      const server = m as Record<string, any>;
      if (!server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(server.name) ||
          (server.name === "mandala_tasks" || server.name === "openmana_tasks") ||
          mcpNames.has(server.name) || !["stdio", "http"].includes(server.transport) ||
          (server.transport === "stdio" && (typeof server.command !== "string" || !server.command)) ||
          (server.transport === "http" && (typeof server.url !== "string" || !/^https?:\/\//.test(server.url) ||
            (() => { try { const url = new URL(server.url); return !!(url.username || url.password || url.hash ||
              [...url.searchParams.keys()].some((key) => /token|secret|password|api.?key/i.test(key))); }
              catch { return true; } })())) ||
          (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((x: unknown) => typeof x !== "string"))) ||
          (server.env !== undefined && (typeof server.env !== "object" || !server.env ||
            Object.keys(server.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
            Object.values(server.env).some((x) => typeof x !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(x))))) invalid();
      mcpNames.add(server.name);
    }
    for (const raw of owner.skills as unknown[]) {
      const s = raw as Record<string, any>;
      if (!s || typeof s.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(s.name) ||
          skillNames.has(s.name) || typeof s.path !== "string") invalid();
      if (s.content !== undefined) {
        if (s.path !== "" || typeof s.content !== "string" || !s.content.trim() || s.content.length > 200000) invalid();
        const error = validateManagedSkillContent(s.name, s.content);
        if (error) throw new Error(error);
      } else if (!s.versionRef || s.path!=="") { if (!isAbsolute(s.path)) invalid(); }
      if(s.versionRef && (!s.versionRef.assetId || !s.versionRef.versionId || typeof s.versionRef.assetId!=="string" || typeof s.versionRef.versionId!=="string"))invalid();
      if(s.creatorAgentId!==undefined && (typeof s.creatorAgentId!=="string"||!s.creatorAgentId))invalid();
      if(s.humanMaintained!==undefined && typeof s.humanMaintained!=="boolean")invalid();
      skillNames.add(s.name);
    }
  };
  for (const catalog of [c.connections ?? [], c.skillLibrary ?? []]) {
    if (!Array.isArray(catalog)) invalid();
    ids(catalog);
  }
  for (const connection of c.connections ?? []) validateCapabilities({ mcp: [connection], skills: [] });
  for (const skill of c.skillLibrary ?? []) validateCapabilities({ mcp: [], skills: [skill] });
  for (const owner of [...c.projects, ...c.agents]) {
    for (const refs of [owner.connectionIds, owner.skillIds, owner.disabledConnectionIds, owner.disabledSkillIds, owner.knowledgeIds])
      if (refs !== undefined && (!Array.isArray(refs) || refs.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(refs).size !== refs.length)) invalid();
    if (owner.disabledConnectionIds?.some(id => !owner.connectionIds?.includes(id)) ||
        owner.disabledSkillIds?.some(id => !owner.skillIds?.includes(id))) invalid();
    // A paused assignment remains a reference and must still be valid and unambiguous.
    validateCapabilities(linkedCapabilities(c, { ...owner, disabledConnectionIds: [], disabledSkillIds: [] }));
  }
  const validateCodeGraph = (value: unknown) => {
    if(value===undefined)return;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['enabled','scope'].includes(key))||typeof (value as {enabled?:unknown}).enabled!=='boolean'||!['directory','repository'].includes((value as {scope:string}).scope))invalid();
  };
  for (const p of c.projects) {
    if (p.background !== undefined && (typeof p.background !== "string" || p.background.length > 20000)) invalid();
    validateRuntime(p.legacyRuntime);
    if (typeof p.cwd !== "string" || (p.cwd !== "" && !isAbsolute(p.cwd)) ||
        !Array.isArray(p.agentIds) ||
        p.agentIds.some((id: unknown) => typeof id !== "string" || !agentIds.has(id)) ||
        new Set(p.agentIds).size !== p.agentIds.length ||
        !Array.isArray(p.resources)) invalid();
    if (p.workspaces !== undefined) {
      if (!Array.isArray(p.workspaces)) invalid();
      ids(p.workspaces);
      for (const workspace of p.workspaces) {
        validateCodeGraph(workspace.codeGraph);
        if (typeof workspace.cwd !== "string" || workspace.cwd && !isAbsolute(workspace.cwd) || !Array.isArray(workspace.resources)) invalid();
        if (workspace.machineId !== undefined && (typeof workspace.machineId !== "string" || !machineIds.has(workspace.machineId) || !isRemoteAbsolutePath(workspace.cwd))) invalid();
      }
    }
    for (const [resources, remote] of [[p.resources, p.workspaces?.[0]?.machineId !== undefined], ...(p.workspaces ?? []).map(w => [w.resources, w.machineId !== undefined] as const)] as const) {
    const resourceIds = new Set<string>();
    for (const r of resources) {
      if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.id) ||
          resourceIds.has(r.id) || typeof r.label !== "string" || !r.label.trim() ||
          !["local", "remote-git"].includes(r.kind) ||
          typeof r.location !== "string" || !r.location.trim() ||
          (r.kind === "local" && !(remote ? isRemoteAbsolutePath(r.location) : isAbsolute(r.location)))) invalid();
      validateCodeGraph(r.codeGraph);
      if(r.kind==="remote-git"&&r.codeGraph?.enabled)invalid();
      resourceIds.add(r.id);
    }
    }
    validateCapabilities(p);
    validateRuntime(p.runtime);
  }
  for (const a of c.agents)
    if (
      (a.maxParallel !== undefined && (!Number.isSafeInteger(a.maxParallel) || a.maxParallel < 1)) ||
      (a.responseStyle !== undefined && !responseStyles.includes(a.responseStyle)) ||
      typeof a.instructions !== "string" ||
      !isCli(a.defaultCli) ||
      !a.models ||
      typeof a.models !== "object" ||
      Object.entries(a.models).some(([cli, model]) => !isCli(cli) || typeof model !== "string")
    )
      invalid();
  for (const a of c.agents) { validateCapabilities(a); validateRuntime(a.runtime); }
}
export async function readConfig(
  home: string,
  options: { hydrateSkills?: boolean } = {},
): Promise<{ config: Config; revision: string }> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    text = JSON.stringify(empty, null, 2) + "\n";
    try {
      await writeFile(path, text, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      text = await readFile(path, "utf8");
    }
  }
  const config = normalizeConfig(JSON.parse(text));
  // Keep legacy profiles readable without silently changing their model provider.
  for(const runtime of [config.runtimeDefaults,...config.agents.map(agent=>agent.runtime)]) {
    if(!runtime || typeof runtime!=='object' || Array.isArray(runtime))continue;
    for(const value of Object.values(runtime))if(value && typeof value.gateway==='string' && value.gateway!=='native')value.gateway='unavailable';
  }
  // Background settings consumers do not execute or display Skills.
  if(options.hydrateSkills===false){
    config.skillLibrary=config.skillLibrary?.map(skill=>skill.versionRef?{...skill,content:undefined,unavailable:true}:skill);
  }else if(config.skillLibrary?.some(skill=>skill.versionRef)) {
    const store=openStore(home);try{const catalog=createSkillCatalog(home,store);if(!writes.has(home))catalog.recover(config);config.skillLibrary=withSkillEvidenceRead(store,config,()=>config.skillLibrary!.map(skill=>{try{return catalog.read(skill,undefined,config);}catch{return {...skill,content:undefined,unavailable:true};}}));}finally{store.close();}
  }
  validateConfig(config);
  return { config, revision: hash(text) };
}
const writes = new Map<string, Promise<unknown>>();
const codeGraphRevisions = new Map<string,number>();
export const codeGraphConfigurationAuthority = (home:string) => ({revision:codeGraphRevisions.get(home)??0,pending:writes.has(home)});
const progressRevisions = new Map<string,number>();
export const taskProgressSettingsRevision = (home:string) => progressRevisions.get(home) ?? 0;
export async function writeConfig(
  home: string,
  value: Config | LegacyConfig,
  expectedRevision: string,
  assertAuthorized?: () => void,
  authority?: symbol,
): Promise<string> {
  const operation = (writes.get(home) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      assertAuthorized?.();
      const config = structuredClone(normalizeConfig(value));
      validateConfig(config);
      const previous = await readConfig(home);
      if (previous.revision !== expectedRevision) throw new Error("configuration changed");
      if (authority !== mandalaAuthority) {
        const old = previous.config.mandala, next = config.mandala;
        if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error("Mandala settings are system managed");
        const protectedFields = (agent: Config["agents"][number]) => {
          const { name, defaultCli, ...protectedValue } = agent; return protectedValue;
        };
        if (old) {
          const before = previous.config.agents.find(a => a.id === old.agentId)!;
          const after = config.agents.find(a => a.id === old.agentId);
          if (!after || JSON.stringify(protectedFields(before)) !== JSON.stringify(protectedFields(after)))
            throw new Error("Mandala identity is system managed");
          if (config.projects.some(p => p.agentIds.includes(old.agentId))) throw new Error("Mandala project membership is system managed");
        } else if (config.agents.some(a => a.systemRole || a.managedWorkspace)) throw new Error("Mandala identity is system managed");
      }
      for (const p of config.projects) {
        for (const workspace of p.workspaces ?? []) {
          if (workspace.machineId !== undefined) continue;
          if (!workspace.cwd) {
            workspace.cwd = workspace.id === "default" ? join(home, "workspaces", p.id) : join(home, "workspaces", p.id, workspace.id);
            await mkdir(workspace.cwd, { recursive: true });
          }
          if (!(await stat(workspace.cwd)).isDirectory()) throw new Error("invalid workspace directory");
        }
        // Keep the legacy fields readable for older integrations; Workspaces own the environment.
        p.cwd = p.workspaces?.[0]?.cwd ?? "";
        p.resources = p.workspaces?.[0]?.resources ?? [];
      }
      if(config.skillLibrary?.some(skill=>skill.path===""&&typeof skill.content==="string")) {
        const store=openStore(home);try{const catalog=createSkillCatalog(home,store);config.skillLibrary=await Promise.all(config.skillLibrary.map(async skill=>{
          if(skill.versionRef&&typeof skill.content==='string'&&skill.content!==catalog.read(skill).content)skill={...skill,humanMaintained:skill.humanMaintained??!assertAuthorized};
          return catalog.persist(skill,()=>assertAuthorized?.());
        }));}finally{store.close();}
      }
      const text = JSON.stringify({ ...config, projects: config.projects.map(({ cwd, resources, ...project }) => project) }, null, 2) + "\n";
      const temp = join(home, `config-${randomUUID()}.tmp`);
      await writeFile(temp, text, { mode: 0o600 });
      try {
        if (
          hash(await readFile(join(home, "config.json"), "utf8")) !==
          expectedRevision
        )
          throw new Error("configuration changed");
        assertAuthorized?.();
        // Invalidate in-flight evaluations before the asynchronous save can race with their commit.
        if(config.system?.automaticTaskProgress===false)progressRevisions.set(home,taskProgressSettingsRevision(home)+1);
        if(config.system?.skillLearning===false){
          const store=openStore(home);try{store.database.exec('CREATE TABLE IF NOT EXISTS skill_learning_policy(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL); INSERT INTO skill_learning_policy VALUES(1,1) ON CONFLICT(id) DO UPDATE SET epoch=epoch+1');}finally{store.close();}
        }
        // Guarded commits cannot yield between the final authorization check and publication.
        // Skill-head publication also shares this synchronous commit boundary.
        if(assertAuthorized||config.skillLibrary?.some(skill=>skill.versionRef))renameSync(temp, join(home, "config.json"));
        else await rename(temp, join(home, "config.json"));
        codeGraphRevisions.set(home,(codeGraphRevisions.get(home)??0)+1);
        if(config.skillLibrary?.some(skill=>skill.versionRef)){const store=openStore(home);try{createSkillCatalog(home,store).recover(config);}finally{store.close();}}
      } catch(error){
        const store=openStore(home);try{createSkillCatalog(home,store).recover(JSON.parse(readFileSync(join(home,'config.json'),'utf8')));}finally{store.close();}
        throw error;
      } finally {
        await rm(temp, { force: true });
      }
      return hash(text);
    });
  writes.set(home, operation);
  try {
    return await operation;
  } finally {
    if (writes.get(home) === operation) writes.delete(home);
  }
}

// Lazy migration keeps old homes and ordinary configuration reads unchanged.
export async function ensureMandalaConfig(home: string, assertActive?:()=>void): Promise<{ config: Config; revision: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readConfig(home);
    assertActive?.();
    if (current.config.mandala) return current;
    const cli = enabledRuntimes(current.config)[0];
    if (!cli) return current;
    const id = `mandala-${randomUUID()}`, cwd = join(home, "workspaces", "mandala");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const config: Config = { ...current.config, mandala: { agentId: id, soul: "", maxParallel: 3 },
      agents: [...current.config.agents, { id, name: "Mandala", systemRole: "mandala", managedWorkspace: cwd,
        instructions: "", defaultCli: cli, models: {}, mcp: [], skills: [],
        runtime: { codex: { fullAccess: false, approvalMode: "default", args: [] } } }] };
    try { await writeConfig(home, config, current.revision, assertActive, mandalaAuthority); return await readConfig(home); }
    catch (error) { if ((error as Error).message !== "configuration changed" || attempt === 4) throw error; }
  }
  throw new Error("configuration changed");
}
export async function updateMandalaSettings(home: string, value: unknown, revision: string) {
  const patch = value as { name: string; soul: string; cli: Config["agents"][number]["defaultCli"]; maxParallel: number; models?: Config["agents"][number]["models"] };
  if (!patch || Object.keys(patch).some(key => !["name", "soul", "cli", "maxParallel", "models"].includes(key)) ||
      typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100 || !isCli(patch.cli))
    throw new Error("invalid Mandala settings");
  if (patch.models !== undefined && (!patch.models || typeof patch.models !== "object" || Array.isArray(patch.models) ||
      Object.entries(patch.models).some(([cli, model]) => !isCli(cli) || typeof model !== "string" || model.length > 200)))
    throw new Error("invalid Mandala models");
  const current = await ensureMandalaConfig(home);
  if (revision !== current.revision) throw new Error("configuration changed");
  if (!enabledRuntimes(current.config).includes(patch.cli)) throw new Error("Runtime disabled");
  const config: Config = { ...current.config,
    mandala: { ...current.config.mandala!, soul: patch.soul, maxParallel: patch.maxParallel },
    agents: current.config.agents.map(a => a.id === current.config.mandala!.agentId ? { ...a, name: patch.name.trim(), defaultCli: patch.cli, models: {...a.models,...patch.models} } : a) };
  await writeConfig(home, config, revision, undefined, mandalaAuthority);
  return readConfig(home);
}
