import { createUiExtensions } from './market-ui-extensions';
import { isUiExtension } from '../shared/ui-extensions';
import { marketFetch } from "./market-transport";
import { createMarketSources } from "./market-sources";
import { createClawHub } from "./market-clawhub";
import { marketBytes as bytes, safeMarketPath as safePath, skillHeader } from "./market-source";
import { marketSorts, sortMarketItems, type MarketSort, type MarketSourceUpdate } from "../shared/market";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readConfig, writeConfig } from "./config";
import type { Config } from "../shared/types";
import type { InstalledMarketItem, MarketDetail, MarketItem, MarketKind, MarketTarget } from "../shared/market";

type Fetcher = (url: string, signal?: AbortSignal) => Promise<Response>;
type TreeFile = { path: string; type: string; mode: string; size?: number };
type SkillTree = { sha: string; tree: TreeFile[]; truncated?: boolean };
const repositoryApi = (repository: string) => `https://api.github.com/repos/${repository}`;
const repositoryRaw = (repository: string) => `https://raw.githubusercontent.com/${repository}`;
const registry = "https://registry.modelcontextprotocol.io/v0.1/servers";
const stableId = (catalogId: string) => "market-" + createHash("sha256").update(catalogId).digest("hex").slice(0, 20);
const publicUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
      !/^(localhost|.*\.localhost|.*\.local|[\d.]+|\[.*\])$/.test(u.hostname) &&
      !/[{}]/.test(value) && ![...u.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key));
  } catch { return false; }
};
const targetOwner = (config: Config, target: MarketTarget) => {
  if (!target || !["agent", "project"].includes(target.kind) || typeof target.id !== "string") throw new Error("invalid market target");
  const owner = (target.kind === "agent" ? config.agents : config.projects).find(item => item.id === target.id);
  if (!owner) throw new Error("invalid market target");
  return owner;
};

export function createMarket(home: string, fetcher: Fetcher = marketFetch) {
  const sourceStore = createMarketSources(home);
  const cachedTrees = new Map<string, { value: SkillTree; expires: number }>();
  const details = new Map<string, MarketDetail>();
  let mutations: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutations.catch(() => {}).then(operation); mutations = next; return next;
  };
  const cooldowns = new Map<string, number>();
  const sourceFetch = fetcher;
  fetcher = async (url, signal) => {
    const host = new URL(url).host;
    if ((cooldowns.get(host) ?? 0) > Date.now()) throw new Error("Market source HTTP 429");
    let response: Response;
    try { response = await sourceFetch(url, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      const cause = error as Error & { cause?: { code?: string; name?: string } };
      throw new Error(`Market source connection failed (${(cause.name === "TimeoutError" || cause.cause?.name === "TimeoutError") ? "timeout" : cause.cause?.code ?? "network"}); check network access and retry`);
    }
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After"), seconds = retry && /^[0-9]+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 60;
      cooldowns.set(host, Date.now() + Math.min(3600, Math.max(1, Number.isFinite(seconds) ? seconds : 60)) * 1000);
    }
    return response;
  };
  const extensions = createUiExtensions(home, (url, signal) => fetcher(url, signal));
  const json = async (url: string, signal?: AbortSignal) => JSON.parse((await bytes(await fetcher(url, signal), 3 * 1024 * 1024)).toString("utf8"));
  const clawCache = new Map<string, { data: any; expires: number }>();
  const claw = createClawHub((url, signal) => fetcher(url, signal), async (url, signal) => {
    const cache = clawCache.get(url); if (cache && cache.expires > Date.now()) return cache.data;
    const data = await json(url, signal);
    if (clawCache.size > 100) clawCache.delete(clawCache.keys().next().value!);
    clawCache.set(url, { data, expires: Date.now() + 60000 }); return data;
  });
  const skillDescriptions = new Map<string, string>();
  const skillTree = async (repository = "anthropics/skills", signal?: AbortSignal) => {
    const cache = cachedTrees.get(repository);
    if (cache && cache.expires > Date.now()) return cache.value;
    const tree = await json(repositoryApi(repository) + "/git/trees/HEAD?recursive=1", signal) as SkillTree;
    if (!tree || !/^[a-f0-9]{40}$/.test(tree.sha) || tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 20000 ||
        tree.tree.some(file => !file || typeof file.path !== "string" || typeof file.type !== "string" || typeof file.mode !== "string")) throw new Error("invalid Skill directory response");
    cachedTrees.set(repository, { value: tree, expires: Date.now() + 300000 }); return tree;
  };
  const skillFiles = (tree: SkillTree, name: string) => {
    const entries = tree.tree.filter(file => file.path.startsWith(`skills/${name}/`));
    if (entries.some(file => !["blob", "tree"].includes(file.type))) throw new Error("invalid Skill package files");
    const files = entries.filter(file => file.type === "blob");
    if (!files.some(file => file.path === `skills/${name}/SKILL.md`) || files.some(file => !safePath(file.path) || !["100644", "100755"].includes(file.mode)))
      throw new Error("invalid Skill package files");
    if (files.length > 200 || files.reduce((size, file) => size + (file.size ?? 0), 0) > 32 * 1024 * 1024)
      throw new Error("invalid Skill package size (maximum 200 files / 32 MB)");
    return files;
  };
  const mcpDetail = (server: any): MarketDetail => {
    if (server && (["remotes", "packages"].some(key => server[key] !== undefined && !Array.isArray(server[key])) ||
        server.packages?.some((pkg: any) => !pkg || ["runtimeArguments", "packageArguments", "environmentVariables"].some(key => pkg[key] !== undefined && !Array.isArray(pkg[key]))))) throw new Error("invalid MCP directory response");
    if (!server || typeof server.name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(server.name) ||
        typeof server.version !== "string" || server.version.length > 100 || typeof server.description !== "string") throw new Error("invalid MCP directory response");
    const name = server.name.split("/").at(-1)!.replace(/[^A-Za-z0-9_-]/g, "-");
    const item: MarketDetail = { catalogId: `mcp:${server.name}`, kind: "mcp", name, description: server.description.slice(0, 5000), version: server.version, publisher: server.name.split("/")[0],
      sourceUrl: publicUrl(server.repository?.url) ? server.repository.url : "https://registry.modelcontextprotocol.io" };
    const connectionName = server.name.replace(/[^A-Za-z0-9_-]/g, "-");
    const remote = server.remotes?.find((entry: any) => entry && entry.type === "streamable-http" && publicUrl(entry.url) && !entry.headers?.length);
    if (remote) { item.connection = { name: connectionName, transport: "http", url: remote.url }; return item; }
    const pkg = server.packages?.find((entry: any) => entry && entry.registryType === "npm" && entry.transport?.type === "stdio" &&
      (!entry.registryBaseUrl || entry.registryBaseUrl === "https://registry.npmjs.org") && (!entry.runtimeHint || entry.runtimeHint === "npx"));
    if (!pkg || typeof pkg.identifier !== "string" || !/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/.test(pkg.identifier) ||
        typeof pkg.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pkg.version) ||
        (pkg.runtimeArguments ?? []).some((arg: any) => !arg || !["-y", "--yes"].includes(arg.value))) {
      item.unsupported = "unsupported MCP transport, runtime arguments or authentication"; return item;
    }
    const args = ["--yes", `${pkg.identifier}@${pkg.version}`];
    for (const arg of pkg.packageArguments ?? []) {
      if (!arg || typeof arg.value !== "string" || /[{}\x00-\x1f]/.test(arg.value) || arg.value.length > 4096 ||
          !["named", "positional"].includes(arg.type) || arg.type === "named" && (typeof arg.name !== "string" || !/^--?[a-zA-Z0-9-]+$/.test(arg.name))) {
        item.unsupported = "unsupported MCP package parameters"; return item;
      }
      if (arg.type === "named") args.push(arg.name);
      args.push(arg.value);
    }
    const environment = pkg.environmentVariables ?? [];
    if (!Array.isArray(environment) || environment.some((env: any) => !env || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name))) throw new Error("invalid MCP environment metadata");
    item.environment = environment.map((env: any) => ({ name: env.name, description: typeof env.description === "string" ? env.description.slice(0, 2000) : undefined, required: env.isRequired === true }));
    item.connection = { name: connectionName, transport: "stdio", command: "npx", args }; return item;
  };
  const search = async (kind: MarketKind, query = "", cursor = "", source: string = kind === "plugin" ? "mandala-plugins" : kind === "theme" ? "mandala-themes" : kind === "language" ? "mandala-languages" : kind === "pet" ? "mandala-pets" : kind === "skill" ? "anthropic" : "mcp-registry", sort: string = "default", signal?: AbortSignal): Promise<{ items: MarketItem[]; nextCursor?: string; warnings?: string[] }> => {
    if (!["skill", "mcp", "theme", "language", "pet", "plugin"].includes(kind) || typeof query !== "string" || query.length > 200 || typeof cursor !== "string" || cursor.length > 1000) throw new Error("invalid market search");
    if (!marketSorts.includes(sort as MarketSort)) throw new Error("invalid market sort");
    const selected = (await sourceStore.read()).sources.find(item => item.id === source);
    if (!selected) throw new Error("invalid market source");
    if (selected.kind !== kind) return { items: [] };
    if (kind === "plugin") return { items: (await extensions.pluginCatalog(selected.url.slice("https://github.com/".length), signal)).filter(item => (item.name + " " + item.description).toLowerCase().includes(query.toLowerCase())) };
    if (isUiExtension(kind)) return { items: (await extensions.catalog(kind, signal)).filter(item => (item.name + " " + item.description).toLowerCase().includes(query.toLowerCase())) };
    if (source === "clawhub") return claw.search(query, cursor, sort as MarketSort, signal);
    if (kind === "skill") {
      const repository = source === "anthropic" ? "anthropics/skills" : selected.url.slice("https://github.com/".length);
      const tree = await skillTree(repository, signal);
      const warnings: string[] = [];
      const descriptionSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
      const entries = tree.tree.filter(file => /^skills\/[A-Za-z0-9_-]+\/SKILL\.md$/.test(file.path));
      // Read small, pinned manifests so browse cards show useful descriptions, not repeated repository names.
      if (entries.length > 200) throw new Error("invalid Skill directory size (maximum 200 skills)");
      for (let offset = 0; offset < entries.length; offset += 4) {
        if (descriptionSignal.aborted) { if (!warnings.length) warnings.push("Some Skill descriptions timed out; retry to load remaining descriptions."); break; }
        const manifests = await Promise.allSettled(entries.slice(offset, offset + 4).map(async file => {
          const key = repository + tree.sha + file.path; if (skillDescriptions.has(key)) return;
          const header = skillHeader((await bytes(await fetcher(`${repositoryRaw(repository)}/${tree.sha}/${file.path}`, descriptionSignal))).toString("utf8"));
          skillDescriptions.set(key, header.description);
        }));
        if (signal?.aborted) throw signal.reason;
        manifests.forEach(result => { if (result.status === "rejected" && warnings.length < 1) warnings.push(descriptionSignal.aborted ? "Some Skill descriptions timed out; retry to load remaining descriptions." : `Some Skill descriptions could not load: ${result.reason.message}`); });
        if (manifests.every(result => result.status === "rejected")) break;
      }
      return { ...(warnings.length ? { warnings } : {}), items: entries.map(file => {
        const name = file.path.split("/")[1];
        return { catalogId: source === "anthropic" ? `skill:anthropics/${name}` : `skill:${source}/${name}`, name, kind, description: skillDescriptions.get(repository + tree.sha + file.path) ?? "", version: tree.sha, publisher: selected.name,
          sourceUrl: `https://github.com/${repository}/tree/${tree.sha}/skills/${name}` };
      }).filter(item => (item.name + " " + item.description).toLowerCase().includes(query.toLowerCase())) };
    }
    const params = new URLSearchParams({ limit: "30", version: "latest" });
    if (query) params.set("search", query); if (cursor) params.set("cursor", cursor);
    const result = await json(`${registry}?${params}`, signal);
    if (!result || !Array.isArray(result.servers) || result.servers.length > 200) throw new Error("invalid MCP directory response");
    const items: MarketItem[] = []; let invalidEntries = 0;
    for (const entry of result.servers) {
      try {
        const meta = entry?._meta?.["io.modelcontextprotocol.registry/official"];
        if (meta?.status !== "active" || meta.isLatest === false) continue;
        const detail = mcpDetail(entry.server), updatedAt = typeof meta?.updatedAt === "string" ? Date.parse(meta.updatedAt) : NaN;
        if (Number.isFinite(updatedAt) && updatedAt > 0) detail.updatedAt = updatedAt;
        details.set(detail.catalogId, detail); items.push(detail);
      } catch { invalidEntries++; }
    }
    return { items: sortMarketItems(items, sort as MarketSort), ...(invalidEntries ? { warnings: [`Skipped ${invalidEntries} invalid MCP directory entries; retry or inspect the registry.`] } : {}), ...(typeof result.metadata?.nextCursor === "string" && result.metadata.nextCursor.length <= 1000 ? { nextCursor: result.metadata.nextCursor } : {}) };
  };
  const detail = async (catalogId: string, signal?: AbortSignal): Promise<MarketDetail> => {
    if (typeof catalogId !== "string") throw new Error("invalid market item");
    if (catalogId.startsWith("plugin:") || catalogId.startsWith("theme:") || catalogId.startsWith("language:") || catalogId.startsWith("pet:")) return extensions.detail(catalogId, signal);
    if (catalogId.startsWith("skill:clawhub/")) return claw.detail(catalogId, signal);
    const match = catalogId.match(/^skill:anthropics\/([A-Za-z0-9_-]+)$/);
    const custom = catalogId.match(/^skill:(github:[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_-]{1,100})$/);
    if (match || custom) {
      const source = (await sourceStore.read()).sources.find(entry => entry.id === (custom ? custom[1] : "anthropic"));
      if (!source) throw new Error("invalid market source");
      const repository = custom ? source.url.slice("https://github.com/".length) : "anthropics/skills";
      const tree = await skillTree(repository, signal), name = (custom ?? match)![custom ? 2 : 1], files = skillFiles(tree, name);
      const readme = (await bytes(await fetcher(`${repositoryRaw(repository)}/${tree.sha}/skills/${name}/SKILL.md`, signal))).toString("utf8");
      const header = skillHeader(readme);
      if (header.name !== name) throw new Error("invalid Skill name");
      const description = header.description;      return { catalogId, kind: "skill", name, description, version: tree.sha, sourceUrl: `https://github.com/${repository}/tree/${tree.sha}/skills/${name}`,
        readme, fileCount: files.length, publisher: source.name, requirements: header.requirements };
    }
    if (!/^mcp:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(catalogId)) throw new Error("invalid market item");
    if (!details.has(catalogId)) await search("mcp", catalogId.slice(4), "", "mcp-registry", "default", signal);
    const value = details.get(catalogId); if (!value) throw new Error("market item not found"); return value;
  };
  const installed = async (): Promise<InstalledMarketItem[]> => {
    const { config } = await readConfig(home);
    return (config.marketInstallations ?? []).map(item => {
      const field = item.kind === "skill" ? "skillIds" : "connectionIds";
      const targets = ([...config.agents.map(owner => ({ owner, kind: "agent" as const })), ...config.projects.map(owner => ({ owner, kind: "project" as const }))])
        .filter(({ owner }) => owner[field]?.includes(item.id)).map(({ owner, kind }) => ({ kind, id: owner.id, name: owner.name }));
      return { ...item, targets, missing: !(item.kind === "skill" ? config.skillLibrary : config.connections)?.some(entry => entry.id === item.id) };
    });
  };
  const install = (input: { catalogId: string; version: string; revision: string; targets: MarketTarget[]; environment?: Record<string, string> }) => exclusive(async () => {
    const { config, revision } = await readConfig(home);
    if (revision !== input.revision) throw new Error("configuration changed");
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100) throw new Error("invalid market targets");
    input.targets.forEach(target => targetOwner(config, target));
    const existing = config.marketInstallations?.find(item => item.catalogId === input.catalogId);
    const value = existing ?? await detail(input.catalogId);
    if (value.kind === "plugin" || isUiExtension(value.kind)) throw new Error("invalid capability installation; use extension installation");
    if (value.version !== input.version) throw new Error("market version changed; reopen details");
    const id = existing?.id ?? stableId(input.catalogId), field = value.kind === "skill" ? "skillIds" : "connectionIds";
    const packageId = value.kind === "skill" && !existing ? randomUUID() : undefined;
    const directory = packageId ? join(home, "market", "packages", packageId) : undefined;
    try {
      if (!existing) {
        const info = value as MarketDetail;
        if (info.unsupported) throw new Error(info.unsupported);
        const capabilityName = value.kind === "skill" ? value.name : value.catalogId.slice(4).replace(/[^A-Za-z0-9_-]/g, "-");
        if ((value.kind === "skill" ? config.skillLibrary : config.connections)?.some(entry => entry.name === capabilityName || entry.id === id)) throw new Error("market capability name conflict");
        if (value.kind === "skill") {
          await mkdir(directory!, { recursive: true, mode: 0o700 });
          if (value.catalogId.startsWith("skill:clawhub/")) {
            for (const file of await claw.download(info)) {
              const destination = join(directory!, file.path);
              await mkdir(dirname(destination), { recursive: true });
              await writeFile(destination, file.data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
            }
          } else {
          const repository = value.catalogId.startsWith("skill:github:") ? value.catalogId.slice("skill:github:".length).split("/").slice(0, 2).join("/") : "anthropics/skills";
          const tree = await skillTree(repository); if (tree.sha !== value.version) throw new Error("market version changed; reopen details");
          const files = skillFiles(tree, value.name);
          await mkdir(directory!, { recursive: true, mode: 0o700 });
          let size = 0;
          for (const file of files) {
            const data = await bytes(await fetcher(`${repositoryRaw(repository)}/${tree.sha}/${file.path}`)); size += data.length;
            if (size > 32 * 1024 * 1024) throw new Error("invalid Skill package size");
            const destination = join(directory!, file.path.slice(`skills/${value.name}/`.length));
            await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, data, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 });
          }
          const license = tree.tree.find(file => file.path === "LICENSE" && file.type === "blob" && file.mode === "100644");
          if (license) await writeFile(join(directory!, "REPOSITORY-LICENSE.txt"), await bytes(await fetcher(`${repositoryRaw(repository)}/${tree.sha}/LICENSE`)), { mode: 0o600 });
          }
          config.skillLibrary = [...(config.skillLibrary ?? []), { id, name: value.name, path: directory! }];
        } else {
          if (!info.connection) throw new Error("unsupported MCP connection");
          const env = input.environment ?? {};
          if (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([key, ref]) =>
            !info.environment?.some(entry => entry.name === key) || typeof ref !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)) ||
              info.environment?.some(entry => entry.required && !env[entry.name])) throw new Error("invalid MCP environment references");
          config.connections = [...(config.connections ?? []), { id, ...info.connection, ...(Object.keys(env).length ? { env } : {}) }];
        }
        config.marketInstallations = [...(config.marketInstallations ?? []), { id, catalogId: value.catalogId, kind: value.kind, name: value.name,
          description: value.description, version: value.version, sourceUrl: value.sourceUrl, installedAt: new Date().toISOString(), ...(packageId ? { packageId } : {}) }];
      } else if (!(value.kind === "skill" ? config.skillLibrary : config.connections)?.some(entry => entry.id === id)) throw new Error("market capability not found");
      for (const target of input.targets) {
        const owner = targetOwner(config, target); owner[field] = [...new Set([...(owner[field] ?? []), id])];
      }
      await writeConfig(home, config, revision);
      return (await installed()).find(item => item.id === id)!;
    } catch (error) { if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
  });
  const unlink = (id: string, target: MarketTarget, expectedRevision: string) => exclusive(async () => {
    const { config, revision } = await readConfig(home);
    if (revision !== expectedRevision) throw new Error("configuration changed");
    const item = config.marketInstallations?.find(entry => entry.id === id); if (!item) throw new Error("market installation not found");
    const field = item.kind === "skill" ? "skillIds" : "connectionIds", owner = targetOwner(config, target);
    const disabledField = item.kind === "skill" ? "disabledSkillIds" : "disabledConnectionIds";
    owner[field] = (owner[field] ?? []).filter(value => value !== id);
    if (owner[disabledField]) owner[disabledField] = owner[disabledField].filter(value => value !== id);
    await writeConfig(home, config, revision);
  });
  const uninstall = (id: string, expectedRevision: string) => exclusive(async () => {
    const { config, revision } = await readConfig(home);
    if (revision !== expectedRevision) throw new Error("configuration changed");
    const item = (await installed()).find(entry => entry.id === id); if (!item) throw new Error("market installation not found");
    if (item.targets.length) throw new Error("market capability is referenced; unlink before uninstall");
    config.marketInstallations = config.marketInstallations!.filter(entry => entry.id !== id);
    if (item.kind === "skill") config.skillLibrary = (config.skillLibrary ?? []).filter(entry => entry.id !== id);
    else config.connections = (config.connections ?? []).filter(entry => entry.id !== id);
    await writeConfig(home, config, revision);
    if (item.packageId) await rm(join(home, "market", "packages", item.packageId), { recursive: true, force: true });
  });
  return { extensions, search, detail, installed, install, unlink, uninstall, sources: sourceStore.read, saveSources: (input: MarketSourceUpdate) => exclusive(() => sourceStore.write(input)) };
}
export type Market = ReturnType<typeof createMarket>;
