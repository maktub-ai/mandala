import { pluginIdentity, pluginRepository, pluginSourceId, type PluginEntry } from './data-plugins';
import type { ExtensionEntry } from './ui-extensions';
export const marketSources = [
  { id: "mandala-plugins", name: "Mandala Plugins", kind: "plugin", url: "https://github.com/maktub-ai/mandala-plugins" },
  { id: "anthropic", name: "Anthropic", kind: "skill", url: "https://github.com/anthropics/skills" },
  { id: "clawhub", name: "ClawHub", kind: "skill", url: "https://clawhub.ai" },
  { id: "mcp-registry", name: "MCP Registry", kind: "mcp", url: "https://registry.modelcontextprotocol.io" },
  { id: "mandala-themes", name: "Mandala Themes", kind: "theme", url: "https://github.com/maktub-ai/mandala-themes" },
  { id: "mandala-languages", name: "Mandala Languages", kind: "language", url: "https://github.com/maktub-ai/mandala-plugins" },
  { id: "mandala-pets", name: "Mandala Pets", kind: "pet", url: "https://github.com/maktub-ai/mandala-pets" },
] as const;
export type MarketSourceId = string;
export const marketSourceOf = (catalogId: string): MarketSourceId => catalogId.startsWith("plugin:") ? pluginSourceId(pluginIdentity(catalogId).repository) : catalogId.startsWith("theme:") ? "mandala-themes" : catalogId.startsWith("language:") ? "mandala-languages" : catalogId.startsWith("pet:") ? "mandala-pets" : catalogId.startsWith("skill:github:") ? catalogId.slice(6).split("/").slice(0, 2).join("/") : catalogId.startsWith("skill:clawhub/") ? "clawhub" : catalogId.startsWith("mcp:") ? "mcp-registry" : "anthropic";
export const marketSorts = ["default", "downloads", "stars", "updated"] as const;
export type MarketSort = typeof marketSorts[number];
export type MarketKind = "skill" | "mcp" | "theme" | "language" | "pet" | "plugin";
export type MarketTarget = { kind: "agent" | "project"; id: string };
export type MarketInstallation = {
  id: string; catalogId: string; kind: MarketKind; name: string; description: string;
  version: string; sourceUrl: string; installedAt: string; packageId?: string;
};
export type MarketItem = {
  catalogId: string; kind: MarketKind; name: string; description: string; version: string; sourceUrl: string; publisher?: string;
  kinds?: import("./ui-extensions").UiExtensionKind[];
  stats?: Partial<Record<"downloads" | "stars" | "installs" | "comments", number>>; updatedAt?: number;
};
/** The saved language source remains an alias for official language plugins. */
export const matchesMarketSource = (item: MarketItem, source: string) => marketSourceOf(item.catalogId) === source
  || source === 'mandala-languages' && item.kind === 'plugin' && item.catalogId.startsWith(`plugin:${pluginRepository}:`) && item.kinds?.includes('language') === true;
export type MarketDetail = MarketItem & {
  extension?: ExtensionEntry;
  plugin?: PluginEntry;
  readme?: string; fileCount?: number; unsupported?: string;
  requirements?: { binaries: string[]; environment: string[]; platforms: string[] };
  connection?: { name: string; transport: "http" | "stdio"; command?: string; args?: string[]; url?: string };
  environment?: { name: string; description?: string; required: boolean }[];
};
export type InstalledMarketItem = MarketInstallation & { targets: (MarketTarget & { name: string })[]; missing: boolean };

export function sortMarketItems(items: MarketItem[], sort: MarketSort): MarketItem[] {
  if (sort === "default") return items;
  const value = (item: MarketItem) => (sort === "updated" ? item.updatedAt : item.stats?.[sort]) ?? -1;
  return [...items].sort((a, b) => value(b) - value(a));
}

export type MarketSource = { id: string; name: string; kind: MarketKind; url: string; adapter?: "github-skills" | "github-plugins" };
export type MarketSourceSnapshot = { sources: MarketSource[]; enabled: string[] | null; revision: string };
export type MarketSourceUpdate = { sources: MarketSource[]; enabled: string[]; revision: string };
/** Only canonical public GitHub repositories with skills/<name>/SKILL.md are supported. */
export function githubSkillSource(name: string, url: string): MarketSource {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\x00-\x1f]/.test(name) || typeof url !== "string") throw new Error("invalid GitHub Skills repository");
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/?$/);
  if (!match || match[2] === "." || match[2] === ".." || match[2].endsWith(".git")) throw new Error("invalid GitHub Skills repository");
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  return { id: `github:${repository}`, name: name.trim(), kind: "skill", url: `https://github.com/${repository}`, adapter: "github-skills" };
}

export function githubPluginSource(name: string, url: string): MarketSource {
  const entry = githubSkillSource(name, url);
  return { ...entry, id: pluginSourceId(entry.url.slice("https://github.com/".length)), kind: "plugin", adapter: "github-plugins" };
}
