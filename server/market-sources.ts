import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { githubPluginSource, githubSkillSource, marketSources, type MarketSource, type MarketSourceSnapshot, type MarketSourceUpdate } from "../shared/market";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validate = (sources: MarketSource[], enabled: string[]) => {
  if (!Array.isArray(sources) || sources.length > 10 || !Array.isArray(enabled)) throw new Error("invalid market sources");
  const ids = new Set(marketSources.map(source => source.id as string)), urls = new Set(marketSources.map(source => source.url as string));
  const normalized = sources.map(source => {
    if (!source || !(source.adapter === "github-skills" && source.kind === "skill" || source.adapter === "github-plugins" && source.kind === "plugin")) throw new Error("invalid market source adapter");
    const entry = (source.kind === "plugin" ? githubPluginSource : githubSkillSource)(source.name, source.url);
    if (entry.id !== source.id || ids.has(entry.id) || urls.has(entry.url)) throw new Error("invalid duplicate market source");
    ids.add(entry.id); urls.add(entry.url); return entry;
  });
  if (enabled.length > ids.size || new Set(enabled).size !== enabled.length || enabled.some(id => !ids.has(id))) throw new Error("invalid enabled market sources");
  return normalized;
};
export function createMarketSources(home: string) {
  const directory = join(home, "market"), path = join(directory, "sources.json");
  const read = async (): Promise<MarketSourceSnapshot> => {
    let text = "";
    try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!text) return { sources: [...marketSources], enabled: null, revision: hash("") };
    if (text.length > 100000) throw new Error("invalid market sources size");
    const value = JSON.parse(text), custom = validate(value.sources, value.enabled);
    return { sources: [...marketSources, ...custom], enabled: value.enabled, revision: hash(text) };
  };
  const write = async (input: MarketSourceUpdate): Promise<MarketSourceSnapshot> => {
    if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)) throw new Error("invalid market source revision");
    const sources = validate(input.sources, input.enabled);
    if ((await read()).revision !== input.revision) throw new Error("market sources changed");
    const text = JSON.stringify({ sources, enabled: input.enabled }, null, 2), temporary = path + "." + randomUUID();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      if ((await read()).revision !== input.revision) throw new Error("market sources changed");
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return { sources: [...marketSources, ...sources], enabled: input.enabled, revision: hash(text) };
  };
  return { read, write };
}
