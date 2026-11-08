import { createHash } from "node:crypto";
import type { Config, McpServer, Skill } from "../shared/types";

// Stable across reloads; identical definitions share one entry, same-name variants remain distinct.
const key = (value: unknown): string => JSON.stringify(value, (_name, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function normalizeCatalog(value: Config): Config {
  const config = structuredClone(value);
  const connections = config.connections ?? [], skills = config.skillLibrary ?? [];
  if (!Array.isArray(connections) || !Array.isArray(skills)) throw new Error("invalid configuration");
  const add = <T extends McpServer | Skill>(library: (T & { id: string })[], definition: T, prefix: string) => {
    const text = key(definition);
    const match = library.find(({ id: _id, ...item }) => key(item) === text);
    if (match) return match.id;
    const id = prefix + createHash("sha256").update(text).digest("hex").slice(0, 16);
    library.push({ ...definition, id });
    return id;
  };
  for (const owner of [...config.projects, ...config.agents]) {
    if (!Array.isArray(owner.mcp ?? []) || !Array.isArray(owner.skills ?? [])) throw new Error("invalid configuration");
    if (owner.mcp?.length) owner.connectionIds = [...(owner.connectionIds ?? []), ...owner.mcp.map(m => add(connections, m, "mcp-"))];
    if (owner.skills?.length) owner.skillIds = [...(owner.skillIds ?? []), ...owner.skills.map(s => add(skills, s, "skill-"))];
    owner.mcp = []; owner.skills = [];
  }
  for (const project of config.projects) {
    if (project.runtime !== undefined) {
      project.legacyRuntime = project.runtime;
      delete project.runtime;
    }
  }
  if (connections.length || config.connections) config.connections = connections;
  if (skills.length || config.skillLibrary) config.skillLibrary = skills;
  return config;
}
