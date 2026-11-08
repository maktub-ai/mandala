import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarket } from "../server/market";
import { readConfig, writeConfig } from "../server/config";
import { marketZip } from "./fixtures/market-zip";
let home: string;
const content = '---\nname: sample\ndescription: |-\n  A multiline skill description\n  for real catalog cards.\nmetadata:\n  openclaw:\n    requires:\n      bins: [gh]\n      env: [DEMO_TOKEN]\n---\n# Synthetic sample\nRead references/guide.md.';
const files = [{ path: "SKILL.md", content }, { path: "references/guide.md", content: "Synthetic guide" }];
const manifest = files.map(file => ({ path: file.path, size: Buffer.byteLength(file.content), sha256: createHash("sha256").update(file.content).digest("hex") }));
const fetcher = vi.fn(async (input: string) => {
  const url = new URL(input);
  if (url.pathname.endsWith("/download")) return new Response(marketZip([...files, { path: "_meta.json", content: '{"version":"1.0.0"}' }]));
  if (url.pathname.endsWith("/versions/1.0.0")) return Response.json({ version: { version: "1.0.0", files: manifest, security: { status: "clean" } } });
  if (url.pathname.endsWith("/file")) return new Response(content);
  if (url.pathname.endsWith("/skills/sample")) return Response.json({ skill: { slug: "sample", summary: "Synthetic sample" }, owner: { handle: "example" }, latestVersion: { version: "1.0.0" } });
  if (url.pathname.endsWith("/search")) return Response.json({ results: [{ slug: "sample", ownerHandle: "example", summary: "Synthetic sample", version: null }] });
  return Response.json({ items: [{ slug: "sample", ownerHandle: "example", summary: "Synthetic sample", latestVersion: { version: "1.0.0" } }], nextCursor: "next" });
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mana-clawhub-")); const initial = await readConfig(home);
  initial.config.agents.push({ id: "a", name: "Synthetic reader", defaultCli: "codex", instructions: "", models: {}, skills: [], mcp: [] });
  await writeConfig(home, initial.config, initial.revision); fetcher.mockClear();
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("lists and searches owner-qualified ClawHub identities, including search entries without versions", async () => {
  const market = createMarket(home, fetcher);
  const listed = await market.search("skill", "", "", "clawhub");
  expect(listed.items[0]).toMatchObject({ catalogId: "skill:clawhub/example/sample", sourceUrl: "https://clawhub.ai/example/skills/sample", version: "1.0.0" });
  expect(listed.nextCursor).toBe("next");
  expect((await market.search("skill", "sample", "", "clawhub")).items[0].catalogId).toBe(listed.items[0].catalogId);
  expect(fetcher.mock.calls.some(([url]) => url.includes("nonSuspiciousOnly=true"))).toBe(true);
});
it("installs all pinned files with hashes, preserves requirements and removes them after unlink/uninstall", async () => {
  const market = createMarket(home, fetcher), detail = await market.detail("skill:clawhub/example/sample");
  expect(detail.description).toBe("A multiline skill description\nfor real catalog cards.");
  expect(detail.requirements).toEqual({ binaries: ["gh"], environment: ["DEMO_TOKEN"], platforms: [] });
  const installed = await market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] });
  const path = (await readConfig(home)).config.skillLibrary![0].path;
  expect(await readFile(join(path, "references/guide.md"), "utf8")).toBe(files[1].content);
  expect(fetcher.mock.calls.filter(([url]) => /versions|file|download/.test(url)).every(([url]) => url.includes("owner=example"))).toBe(true);
  await market.unlink(installed.id, { kind: "agent", id: "a" }, (await readConfig(home)).revision);
  await market.uninstall(installed.id, (await readConfig(home)).revision);
  expect(await readdir(join(home, "market/packages"))).toEqual([]);
});
it.each([
  [...files, { path: "../escape", content: "bad" }],
  files.map(file => ({ ...file, mode: 0o120777 })),
  files.map(file => ({ ...file, content: "tampered" })),
  files.slice(0, 1),
].map(archiveFiles => ({ archiveFiles })))("rejects malformed archives and leaves config and package directory unchanged (%#)", async ({ archiveFiles }) => {
  const market = createMarket(home, url => url.includes("/download?") ? Promise.resolve(new Response(marketZip(archiveFiles))) : fetcher(url));
  const detail = await market.detail("skill:clawhub/example/sample");
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow(/invalid/);
  expect((await readConfig(home)).config.marketInstallations).toBeUndefined();
  expect(await readdir(join(home, "market/packages"))).toEqual([]);
});
it("never installs GitHub handoff descriptors or blocked versions as if they were skill archives", async () => {
  const market = createMarket(home, url => url.includes("/download?") ? Promise.resolve(Response.json({ kind: "public-github", url: "https://example.org" })) : fetcher(url));
  const detail = await market.detail("skill:clawhub/example/sample");
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow(/unsupported/);
  expect((await readConfig(home)).config.marketInstallations).toBeUndefined();
  const blocked = createMarket(home, url => url.includes("/versions/") ? Promise.resolve(Response.json({ version: { version: "1.0.0", files: manifest, security: { status: "malicious" } } })) : fetcher(url));
  expect((await blocked.detail(detail.catalogId)).unsupported).toBeTruthy();
});
it("rejects invalid sources and incompatible source/type combinations without fetching", async () => {
  const market = createMarket(home, fetcher);
  await expect(market.search("skill", "", "", "unknown")).rejects.toThrow(/invalid/);
  expect((await market.search("mcp", "", "", "clawhub")).items).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("honors Retry-After without hammering a source and caches public catalog responses", async () => {
  const limited = vi.fn(async () => new Response("Rate limited", { status: 429, headers: { "Retry-After": "60" } }));
  const market = createMarket(home, limited);
  await expect(market.search("skill", "", "", "clawhub")).rejects.toThrow("429");
  await expect(market.search("skill", "again", "", "clawhub")).rejects.toThrow("429");
  expect(limited).toHaveBeenCalledTimes(1);
  const cached = createMarket(home, fetcher);
  await cached.search("skill", "", "", "clawhub");
  const before = fetcher.mock.calls.length;
  await cached.search("skill", "", "", "clawhub");
  expect(fetcher.mock.calls.length).toBe(before);
});
it("rejects a publisher mismatch instead of installing another owner's same-name Skill", async () => {
  const market = createMarket(home, url => url.endsWith("/skills/sample?owner=example") ? Promise.resolve(Response.json({ skill: { slug: "sample" }, owner: { handle: "other" }, latestVersion: { version: "1.0.0" } })) : fetcher(url));
  await expect(market.detail("skill:clawhub/example/sample")).rejects.toThrow(/identity/);
  expect((await readConfig(home)).config.marketInstallations).toBeUndefined();
});
it("accepts a listed _meta.json that the registry replaces with generated download metadata", async () => {
  const publishedMeta = '{"published":"synthetic"}';
  const listedFiles = [...manifest, { path: "_meta.json", size: Buffer.byteLength(publishedMeta), sha256: createHash("sha256").update(publishedMeta).digest("hex") }];
  const market = createMarket(home, url => url.includes("/versions/")
    ? Promise.resolve(Response.json({ version: { version: "1.0.0", files: listedFiles, security: { status: "clean" } } })) : fetcher(url));
  const detail = await market.detail("skill:clawhub/example/sample");
  expect(detail.fileCount).toBe(2);
  const installed = await market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] });
  const path = (await readConfig(home)).config.skillLibrary![0].path;
  expect(await readFile(join(path, "references/guide.md"), "utf8")).toBe(files[1].content);
  expect(await readdir(path)).toEqual(["SKILL.md", "references"]);
  await market.unlink(installed.id, { kind: "agent", id: "a" }, (await readConfig(home)).revision);
  await market.uninstall(installed.id, (await readConfig(home)).revision);
  expect(await readdir(join(home, "market/packages"))).toEqual([]);
});
it.each([
  "# Synthetic UI guide\n\n**Name:** sample\n**Description:** A UI guide without YAML frontmatter.",
  "---\nname: sample\ndescription: UI: guide\n---\n# Synthetic UI guide",
  "---\nname: sample\n---\n# Synthetic UI guide",
  "---\nname: invalid skill name\ndescription: A synthetic UI guide\n---\n# Synthetic UI guide",
])("keeps incompatible Skill contents viewable while refusing installation (%#)", async readme => {
  const info = { path: "SKILL.md", size: Buffer.byteLength(readme), sha256: createHash("sha256").update(readme).digest("hex") };
  const market = createMarket(home, url => url.includes("/versions/")
    ? Promise.resolve(Response.json({ version: { version: "1.0.0", files: [info] } }))
    : url.includes("/file?") ? Promise.resolve(new Response(readme)) : fetcher(url));
  const detail = await market.detail("skill:clawhub/example/sample");
  expect(detail).toMatchObject({ name: "sample", description: "Synthetic sample", readme, fileCount: 1, unsupported: "unsupported ClawHub Skill metadata" });
  await expect(market.install({ catalogId: detail.catalogId, version: detail.version, revision: (await readConfig(home)).revision, targets: [{ kind: "agent", id: "a" }] })).rejects.toThrow(/unsupported/);
  expect((await readConfig(home)).config.marketInstallations).toBeUndefined();
  expect(fetcher.mock.calls.some(([url]) => url.includes("/download?"))).toBe(false);
});
it("rejects tampered readmes before interpreting unsupported metadata", async () => {
  const market = createMarket(home, url => url.includes("/file?") ? Promise.resolve(new Response("# Tampered readme without metadata")) : fetcher(url));
  await expect(market.detail("skill:clawhub/example/sample")).rejects.toThrow(/integrity/);
});
it("preserves native popularity fields for browse, unified search and details without inventing missing counts", async () => {
  const stats = { stars: 4, downloads: 2904, installs: 80, comments: 0 };
  const listing = { slug: "sample", ownerHandle: "example", summary: "Synthetic sample", latestVersion: { version: "1.0.0" }, stats, updatedAt: 1778486278647 };
  const market = createMarket(home, url => url.includes("/search?")
    ? Promise.resolve(Response.json({ results: [{ ...listing, stats: undefined, downloads: 2904, metrics: { bookmarks: 0 }, native: { skill: { stats } } }] }))
    : url.includes("/skills?") ? Promise.resolve(Response.json({ items: [listing] }))
    : url.endsWith("/skills/sample?owner=example") ? Promise.resolve(Response.json({ skill: listing, owner: { handle: "example" }, latestVersion: listing.latestVersion })) : fetcher(url));
  expect((await market.search("skill", "", "", "clawhub")).items[0]).toMatchObject({ stats, updatedAt: listing.updatedAt });
  expect((await market.search("skill", "sample", "", "clawhub")).items[0].stats).toEqual(stats);
  expect((await market.detail("skill:clawhub/example/sample")).stats).toEqual(stats);
  const sparse = createMarket(home, async () => Response.json({ items: [{ ...listing, stats: { stars: -1, downloads: "2904", installs: 0, comments: null }, updatedAt: "unknown" }] }));
  const item = (await sparse.search("skill", "", "", "clawhub")).items[0];
  expect(item.stats).toEqual({ installs: 0 }); expect(item.updatedAt).toBeUndefined();
});
it("uses native ClawHub ordering and keeps pagination on that ordering, while sorting keyword matches locally", async () => {
  const results = [
    { slug: "first", ownerHandle: "example", stats: { stars: 2, downloads: 100 }, updatedAt: 1700000000000 },
    { slug: "second", ownerHandle: "example", stats: { stars: 10, downloads: 5 }, updatedAt: 1750000000000 },
    { slug: "missing", ownerHandle: "example" },
  ];
  const source = vi.fn(async (url: string) => Response.json(url.includes("/search?") ? { results } : { items: results, nextCursor: "page-2" }));
  const market = createMarket(home, source);
  await market.search("skill", "", "", "clawhub", "stars");
  await market.search("skill", "", "page-2", "clawhub", "stars");
  expect(new URL(source.mock.calls[0][0]).searchParams.get("sort")).toBe("stars");
  expect(new URL(source.mock.calls[1][0]).searchParams.get("cursor")).toBe("page-2");
  expect(new URL(source.mock.calls[1][0]).searchParams.get("sort")).toBe("stars");
  expect((await market.search("skill", "ui", "", "clawhub", "stars")).items.map(item => item.name)).toEqual(["second", "first", "missing"]);
  expect((await market.search("skill", "ui", "", "clawhub", "downloads")).items.map(item => item.name)).toEqual(["first", "second", "missing"]);
  expect((await market.search("skill", "ui", "", "clawhub", "updated")).items.map(item => item.name)).toEqual(["second", "first", "missing"]);
  expect((await market.search("skill", "ui", "", "clawhub")).items.map(item => item.name)).toEqual(["first", "second", "missing"]);
  await expect(market.search("skill", "", "", "clawhub", "unknown")).rejects.toThrow(/invalid/);
});

it("does not cache a cancelled catalog read and lets a later retry populate the cache", async () => {
  let signalSeen: AbortSignal | undefined;
  let attempts = 0;
  const market = createMarket(home, async (url, signal) => {
    if (++attempts > 1) return fetcher(url);
    signalSeen = signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const aborted = market.search("skill", "", "", "clawhub", "default", controller.signal).catch(error => error);
  await vi.waitFor(() => expect(signalSeen).toBe(controller.signal));
  controller.abort();
  expect((await aborted).name).toBe("AbortError");
  expect((await market.search("skill", "", "", "clawhub")).items).toHaveLength(1);
  await market.search("skill", "", "", "clawhub");
  expect(attempts).toBe(2);
});
