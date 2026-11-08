import { arabicEntry, arabicFiles, legacyArabicCatalog } from '../../fixtures/language-plugin';
import { studioCatalog, pluginFiles } from '../../fixtures/data-plugin';
import { defaultPreferences, exportThemePackage } from '../../../src/themes';
import { createHash } from "node:crypto";
import { marketZip } from "../../fixtures/market-zip";
export async function marketSource(url: string): Promise<Response> {
  if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-plugins/main/catalog.json') return Response.json({ ...studioCatalog, items: [...studioCatalog.items, arabicEntry] });
  if (url === 'https://raw.githubusercontent.com/example/plugins/main/catalog.json') return Response.json(studioCatalog);
  if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-plugins/main/catalogs/languages.json') return Response.json(legacyArabicCatalog);
  const languagePrefix = `https://raw.githubusercontent.com/maktub-ai/mandala-plugins/${arabicEntry.package.revision}/`;
  if (url.startsWith(languagePrefix)) return new Response(arabicFiles[url.slice(languagePrefix.length)] ?? '', { status: arabicFiles[url.slice(languagePrefix.length)] ? 200 : 404 });
  if (url.startsWith('https://raw.githubusercontent.com/example/studio/')) return new Response(pluginFiles[url.split('/').at(-1)!] ?? '', { status: pluginFiles[url.split('/').at(-1)!] ? 200 : 404 });
  if (url.includes('mandala-themes/')) {
    const raw = exportThemePackage(defaultPreferences(), 'light');
    if (url.endsWith('/catalog.json')) return Response.json({ format: 'mandala-catalog', version: 1, kind: 'theme', items: [{ id: 'paper', name: 'Community Paper', description: 'Community extension fixture', version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.1', package: { repository: 'maktub-ai/mandala-themes', revision: 'b'.repeat(40), path: 'packages/example.json', sha256: createHash('sha256').update(raw).digest('hex') } }] });
    return new Response(raw);
  }

  if (url.includes('mandala-pets/')) {
    const dot = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString('base64');
    const raw = JSON.stringify({ format: 'mandala-pet', version: 1, name: 'Community Dot', tint: true, states: { idle: dot, working: dot, waiting: dot, error: dot } });
    if (url.endsWith('/catalog.json')) return Response.json({ format: 'mandala-catalog', version: 1, kind: 'pet', items: [{ id: 'dot', name: 'Community Dot', description: 'Community pet fixture', version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.1', package: { repository: 'maktub-ai/mandala-pets', revision: 'b'.repeat(40), path: 'packages/dot.json', sha256: createHash('sha256').update(raw).digest('hex') } }] });
    return new Response(raw);
  }
  const sha = "a".repeat(40);
  if (url.includes("clawhub.ai")) {
    const parsed = new URL(url);
    const headerless = parsed.pathname.includes("/synthetic-headerless") || parsed.searchParams.get("slug") === "synthetic-headerless" || parsed.searchParams.get("q")?.includes("synthetic-headerless");
    const slug = headerless ? "synthetic-headerless" : "synthetic-claw";
    const content = headerless ? "# Synthetic headerless guide\n\nA synthetic UI guide without YAML metadata." : "---\nname: synthetic-claw\ndescription: Synthetic ClawHub workflow\n---\nRead the synthetic reference before answering.";
    const file = { path: "SKILL.md", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    if (parsed.pathname.endsWith("/download")) return new Response(marketZip([{ path: "SKILL.md", content }]));
    if (parsed.pathname.includes("/versions/")) return Response.json({ version: { version: "1.0.0", files: [file], security: { status: "clean" } } });
    if (parsed.pathname.endsWith("/file")) return new Response(content);
    if (parsed.pathname.endsWith(`/skills/${slug}`)) return Response.json({ skill: { slug, summary: "Synthetic ClawHub workflow", stats: { stars: 3, downloads: 120, installs: 20, comments: 2 }, updatedAt: 1700000000000 }, latestVersion: { version: "1.0.0" }, owner: { handle: "example" } });
    const item = { slug, stats: { stars: 3, downloads: 120, installs: 20, comments: 2 }, updatedAt: 1700000000000, summary: "Synthetic ClawHub workflow", ownerHandle: "example", latestVersion: { version: "1.0.0" } };
    if (parsed.pathname.endsWith("/search") && parsed.searchParams.get("q") === "popularity") return Response.json({ results: [item, { ...item, slug: "synthetic-popular", stats: { stars: 60, downloads: 25, installs: 5 }, updatedAt: 1750000000000 }, { ...item, slug: "synthetic-no-stats", stats: undefined, updatedAt: undefined }] });
    return Response.json(parsed.pathname.endsWith("/search") ? { results: parsed.searchParams.get("q")?.includes(slug) ? [item] : [] } : { items: [item] });
  }
  if (url.includes("git/trees")) return Response.json({ sha, truncated: false, tree: [
    { path: "skills/synthetic-reading/SKILL.md", type: "blob", mode: "100644", size: 120 },
    { path: "skills/synthetic-reading/references/check.md", type: "blob", mode: "100644", size: 80 },
  ] });
  if (url.includes("registry.modelcontextprotocol.io") && new URL(url).searchParams.get("search") && !new URL(url).searchParams.get("search")!.includes("synthetic-tools")) return Response.json({ servers: [], metadata: {} });
  if (url.includes("registry.modelcontextprotocol.io")) return Response.json({ servers: [{ server: {
    name: "org.example/synthetic-tools", description: "Synthetic MCP for repeatable market UI acceptance", version: "1.0.0",
    packages: [{ registryType: "npm", identifier: "@example/synthetic-tools", version: "1.0.0", transport: { type: "stdio" },
      environmentVariables: [{ name: "SYNTHETIC_KEY", description: "Use an environment variable reference", isRequired: true, isSecret: true }] }],
  }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } }], metadata: {} });
  return new Response(url.endsWith("SKILL.md") ? "---\nname: synthetic-reading\ndescription: Synthetic reading workflow\n---\nRead references/check.md before answering." : "Synthetic reference.");
}
