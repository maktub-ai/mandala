import { skillResources } from "../shared/skills";
import type { Agent, McpServer, Project, Skill } from "../shared/types";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile, readdir, stat, realpath } from "node:fs/promises";
import type { Cli } from "../shared/types";
const run = promisify(execFile);

export type NativeCapability = { name: string; source: "native"; path: string; scope?: "user" | "directory"; enabled?: boolean; configurationFingerprint?: string };
// Retain effective configuration identity without returning commands, URLs,
// headers or environment values that may contain native credentials.
const mcpFingerprint = (definition: unknown) => createHash("sha256").update(JSON.stringify(definition, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex");
export type CapabilityItem<T> = {
  name: string;
  source: "project" | "agent" | "native";
  overridden: ("agent" | "native")[];
  status: "available" | "unverified" | "effective" | "error" | "pending" | "restart";
  definition: T | NativeCapability;
};

function merge<T extends { name: string }>(
  project: T[], agent: T[], native: NativeCapability[],
): CapabilityItem<T>[] {
  const result = new Map<string, CapabilityItem<T>>();
  for (const [source, items] of [
    ["native", native], ["agent", agent], ["project", project],
  ] as const) {
    for (const item of items) {
      const previous = result.get(item.name);
      result.set(item.name, {
        name: item.name,
        source,
        overridden: previous ? [previous.source, ...previous.overridden].filter(
          (x): x is "agent" | "native" => x !== "project",
        ) : [],
        status: source === "native" ? "available" : "unverified",
        definition: item,
      });
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function capabilitySignature(project: Project, agent: Agent): string {
  const mcp = [...new Map([...agent.mcp, ...project.mcp].map((item) => [item.name, item])).values()];
  const skills = [...new Map([...agent.skills, ...project.skills].map((item) => [item.name, item])).values()];
  return JSON.stringify({ mcp, skills:skills.map(skill=>({...skill,resources:skill[skillResources]})), instructions: agent.instructions, directories: project.resources,
    background: project.background, knowledgeIds: [project.knowledgeIds, agent.knowledgeIds], runtime: { agent: agent.runtime } });
}

export function resolveCapabilities(
  project: Project,
  agent: Agent,
  native: { mcp: NativeCapability[]; skills: NativeCapability[] },
): { mcp: CapabilityItem<McpServer>[]; skills: CapabilityItem<Skill>[] } {
  return {
    mcp: merge(project.mcp, agent.mcp, native.mcp),
    skills: merge(project.skills, agent.skills, native.skills),
  };
}

async function readMcpFile(path: string): Promise<NativeCapability[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Object.entries(value.mcpServers ?? {}).map(([name, definition]) => ({ name, source: "native", path,
      configurationFingerprint: mcpFingerprint(definition),
      ...(definition && typeof definition === "object" && "enabled" in definition && definition.enabled === false ? { enabled: false } : {}),
    }));
  } catch {
    return [];
  }
}

async function readSkills(root: string, scope: "user" | "directory"): Promise<NativeCapability[]> {
  const seen = new Set<string>(), skills: NativeCapability[] = [];
  const walk = async (directory: string) => {
    const target = await realpath(directory).catch(() => null);
    if (!target || seen.has(target)) return;
    seen.add(target);
    const path = join(directory, "SKILL.md");
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) {
      const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const name = header?.match(/^name:\s*(.+?)\s*$/m)?.[1].replace(/^(["'])|(["'])$/g, "") || basename(directory);
      skills.push({ name, source: "native", path, scope });
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(join(directory, entry.name)).catch(() => null))?.isDirectory())
        await walk(join(directory, entry.name));
  };
  await walk(root);
  return skills;
}

export async function discoverNativeSkills(cli: Cli, cwd: string): Promise<NativeCapability[]> {
  const home = homedir();
  const userRoots = [join(home, ".agents", "skills"), ...(cli === "codex"
    ? [join(process.env.CODEX_HOME ?? join(home, ".codex"), "skills")]
    : cli === "omp" ? [join(home, ".omp", "agent", "skills"), join(home, ".pi", "agent", "skills")] : cli === "claude" ? [join(home,".claude","skills")] : [])];
  const directoryRoots = [join(cwd, ".agents", "skills"), ...(cli === "codex" || cli === "omp" ? [join(cwd, ".codex", "skills")] : []),
    ...(cli === "omp" ? [join(cwd, ".omp", "skills"), join(cwd, ".claude", "skills")] : cli === "claude" ? [join(cwd,".claude","skills")] : [])];
  return (await Promise.all([
    ...userRoots.map(root => readSkills(root, "user")),
    ...directoryRoots.map(root => readSkills(root, "directory")),
  ])).flat();
}

export async function discoverNative(cli: Cli, cwd: string): Promise<{
  mcp: NativeCapability[];
  skills: NativeCapability[];
}> {
  const home = homedir();
  let mcp: NativeCapability[] = [];
  if (cli === "codex") {
    try {
      const { stdout } = await run("codex", ["mcp", "list", "--json"], {
        cwd, timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const value = JSON.parse(stdout);
      mcp = (Array.isArray(value) ? value : Object.entries(value).map(([name, definition]) => ({ ...(definition && typeof definition === "object" ? definition : {}), name }))).map((item: { name: string; enabled?: boolean }) => ({
        name: item.name, source: "native", path: "Codex CLI effective configuration", ...(item.enabled === false ? { enabled: false } : {}),
        configurationFingerprint: mcpFingerprint(item),
      }));
    } catch { /* The UI reports an empty, unverified inventory. */ }
  } else if (cli === "omp") {
    const paths = [
      join(home, ".omp", "agent", "mcp.json"),
      join(home, ".pi", "agent", "mcp.json"),
      join(cwd, ".omp", "mcp.json"),
      join(cwd, "mcp.json"),
      join(cwd, ".mcp.json"),
    ];
    mcp = (await Promise.all(paths.map(readMcpFile))).flat();
  }
  const skills = await discoverNativeSkills(cli, cwd);
  return {
    mcp: [...new Map(mcp.map((x) => [x.name, x])).values()],
    skills: [...new Map(skills.map((x) => [x.name, x])).values()],
  };
}
