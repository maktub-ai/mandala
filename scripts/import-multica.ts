import { productHome } from "../cli/product-env.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readConfig, writeConfig, validateConfig } from "../server/config";
import type { Config } from "../shared/types";

const run = promisify(execFile);
const applyAt = process.argv.indexOf("--apply");
const ids = process.argv.slice(2, applyAt < 0 ? undefined : applyAt);
if (ids.length !== 2) throw new Error("Pass exactly two Multica project IDs. Add --apply /private/mapping.json only after reviewing the mapping.");
const get = async (args: string[]) => JSON.parse((await run("multica", [...args, "--output", "json"], {
  maxBuffer: 1024 * 1024,
})).stdout);
const sources = await Promise.all(ids.map(async (id) => {
  const project = await get(["project", "get", id]);
  const resources = await get(["project", "resource", "list", id]);
  const list = Array.isArray(resources) ? resources : resources.resources ?? [];
  const primary = list.find((item: { resource_type: string; resource_ref?: { local_path?: string } }) =>
    item.resource_type === "local_directory" && typeof item.resource_ref?.local_path === "string");
  return { id, name: project.title, resourceCount: list.length,
    resourceKinds: list.map((item: { resource_type: string }) => item.resource_type),
    suggestedCwd: primary?.resource_ref?.local_path ?? "" };
}));
console.log(JSON.stringify({ sources, mappingDraft: { confirmed: false, config: {
  version: 2, projects: sources.map((source) => ({ id: source.id, name: source.name,
    cwd: source.suggestedCwd, agentIds: [], resources: [], mcp: [], skills: [] })), agents: [],
} }, needsMapping: ["primary cwd", "Mandala agents", "additional directories or remote repositories"] }, null, 2));
if (applyAt < 0) process.exit(0);
const mappingPath = process.argv[applyAt + 1];
if (!mappingPath || !resolve(mappingPath).startsWith(homedir() + "/"))
  throw new Error("Mapping must be a private file under your home directory");
const document = JSON.parse(await readFile(mappingPath, "utf8")) as { confirmed?: boolean; config: Config };
if (document.confirmed !== true) throw new Error("Review the private mapping and set confirmed to true before import");
const mapping = document.config;
if (mapping.projects.length !== 2 ||
    !ids.every((id) => mapping.projects.some((project) => project.id === id)) ||
    mapping.projects.some((project) => !project.cwd || !project.agentIds.length))
  throw new Error("Mapping must include both selected source IDs as project IDs");
const home = resolve(productHome());
const { config, revision } = await readConfig(home);
for (const agent of mapping.agents) {
  const existing = config.agents.find((item) => item.id === agent.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(agent))
    throw new Error(`Agent ${agent.id} conflicts with the existing Mandala definition`);
}
if (mapping.projects.some((project) => config.projects.some((existing) => existing.id === project.id)))
  throw new Error("One or more projects are already imported");
const updated: Config = { version: 2,
  projects: [...config.projects, ...mapping.projects],
  agents: [...config.agents, ...mapping.agents.filter((agent) =>
    !config.agents.some((existing) => existing.id === agent.id))] };
validateConfig(updated);
await writeConfig(home, updated, revision);
console.log("Imported into the private Mandala data directory. Multica was not changed.");
