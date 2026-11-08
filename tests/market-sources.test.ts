import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarket } from "../server/market";
import { githubSkillSource, marketSourceOf, type MarketSource } from "../shared/market";
import { readConfig, writeConfig } from "../server/config";
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "market-sources-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const repository = "https://github.com/example/reading-skills";
const source = () => githubSkillSource("Reading skills", repository);
const sha = "a".repeat(40);
const manifest = "---\nname: sample\ndescription: Custom source workflow\n---\nUse references/guide.md";
const fetcher = async (url: string) => url.includes("git/trees") ? Response.json({ sha, tree: ["skills/sample/SKILL.md", "skills/sample/references/guide.md"].map(path => ({ path, type: "blob", mode: "100644", size: 100 })) }) : new Response(url.endsWith("SKILL.md") ? manifest : "Pinned guide");
it("persists custom sources and enabled preferences with conflict detection, then browses and installs pinned resources after reopening", async () => {
  const market = createMarket(home, fetcher), first = await market.sources();
  const added = source();
  const saved = await market.saveSources({ revision: first.revision, sources: [added], enabled: [added.id] });
  expect(saved.sources.at(-1)).toEqual(added);
  expect(saved.enabled).toEqual([added.id]);
  await expect(market.saveSources({ revision: first.revision, sources: [], enabled: [] })).rejects.toThrow("market sources changed");
  const reopened = createMarket(home, fetcher);
  expect(await reopened.sources()).toEqual(saved);
  const result = await reopened.search("skill", "workflow", "", added.id);
  expect(result.items).toHaveLength(1);
  expect(marketSourceOf(result.items[0].catalogId)).toBe(added.id);
  const detail = await reopened.detail(result.items[0].catalogId);
  expect(detail).toMatchObject({ description: "Custom source workflow", version: sha, fileCount: 2 });
  const current = await readConfig(home);
  current.config.agents.push({ id: "a", name: "Reader", instructions: "", defaultCli: "codex", models: {}, skills: [], mcp: [] });
  await writeConfig(home, current.config, current.revision);
  const installation = await reopened.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{kind: "agent", id: "a"}] });
  const path = (await readConfig(home)).config.skillLibrary![0].path;
  expect(await readFile(join(path, "references/guide.md"), "utf8")).toBe("Pinned guide");
  expect((await createMarket(home, fetcher).installed())[0].id).toBe(installation.id);
});
it.each([
  "http://github.com/example/repo", "https://user:secret@github.com/example/repo", "https://github.com.evil.test/example/repo", "https://127.0.0.1/example/repo", "https://github.com:8443/example/repo", "https://github.com/example/repo?token=private", "https://github.com/example/repo#main", "https://github.com/example/repo/tree/main", "https://github.com/example/..", "https://github.com/example/%2e%2e", "https://github.com/example/repo.git",
])("rejects unsupported source URLs before storing or requesting anything: %s", async url => {
  expect(() => githubSkillSource("Example", url)).toThrow("invalid GitHub Skills repository");
  const market = createMarket(home, () => { throw new Error("must not fetch"); });
  const original = await market.sources();
  await expect(market.saveSources({revision: (await market.sources()).revision, sources: [{...source(), url}], enabled: []})).rejects.toThrow(/invalid/);
  expect(await market.sources()).toEqual(original);
});
it("rejects duplicate repositories, forged ids, unknown adapters and too many sources", async () => {
 const market = createMarket(home, fetcher), initial = await market.sources();
 for(const sources of [[source(), source()], [{...source(), id: "clawhub"}], [{...source(), adapter: "website"}], [githubSkillSource("Anthropic duplicate", "https://github.com/anthropics/skills")], Array.from({length:11},(_,i)=>githubSkillSource(`Repo ${i}`, `https://github.com/example/repo-${i}`))]) {
  await expect(market.saveSources({revision:initial.revision,sources: sources as MarketSource[],enabled:[]})).rejects.toThrow(/invalid/);
 }
});
it("keeps custom repositories restricted to their configured identity and rejects removed sources", async () => {
 const market=createMarket(home,fetcher), initial=await market.sources(), added=source();
 await expect(market.detail("skill:github:example/reading-skills/sample")).rejects.toThrow(/invalid/);
 const saved=await market.saveSources({revision:initial.revision,sources:[added],enabled:[added.id]});
 await market.saveSources({revision:saved.revision,sources:[],enabled:[]});
 await expect(market.search("skill","","",added.id)).rejects.toThrow(/invalid/);
});
