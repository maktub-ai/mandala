import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { createHttpServer } from "../server/http";
import { createMarket } from "../server/market";
import { readConfig, writeConfig } from "../server/config";
import { openStore, type Store } from "../server/store";
import { createSessionManager, type SessionManager } from "../server/sessions";
import { conversationContext } from "../server/conversation-context";
import { capabilitySignature } from "../server/capabilities";
vi.mock("../server/capabilities", async importOriginal => ({ ...await importOriginal<typeof import("../server/capabilities")>(), discoverNative: async () => ({ mcp: [], skills: [] }) }));
let home: string, server: Server, store: Store, manager: SessionManager, url: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mana-market-http-")); store = openStore(home);
  manager = createSessionManager(store, async () => (await readConfig(home)).config);
  const initial = await readConfig(home);
  initial.config.agents.push({ id: "a", name: "Reader", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] });
  await writeConfig(home, initial.config, initial.revision);
  const market = createMarket(home, async () => Response.json({ servers: [{ server: { name: "org.example/demo", version: "1.0.0", description: "Synthetic server", remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp" }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } }] }));
  server = createHttpServer({requireIdentity:false, home, store, manager, market }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await manager.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(home, { recursive: true, force: true }); });
const post = (path: string, data: unknown, origin = url) => fetch(url + "/api/market" + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(data) });
it("exposes the real service installation/link/unlink/uninstall lifecycle and origin guard", async () => {
  const result = await (await fetch(url + "/api/market/search?kind=mcp&query=demo")).json();
  expect(result.items[0].catalogId).toBe("mcp:org.example/demo");
  const detail = await (await fetch(url + "/api/market/detail?catalogId=" + encodeURIComponent(result.items[0].catalogId))).json();
  const revision = (await readConfig(home)).revision;
  expect((await post("/install", { catalogId: detail.catalogId, version: detail.version, revision, targets: [{ kind: "agent", id: "a" }] }, "https://foreign.example")).status).toBe(403);
  const response = await post("/install", { catalogId: detail.catalogId, version: detail.version, revision, targets: [{ kind: "agent", id: "a" }] });
  expect(response.status).toBe(201); const installed = await response.json();
  expect((await (await fetch(url + "/api/market/installed")).json())[0].targets[0].name).toBe("Reader");
  expect((await post(`/installed/${installed.id}/uninstall`, { revision: (await readConfig(home)).revision })).status).toBe(409);
  expect((await post(`/installed/${installed.id}/unlink`, { target: { kind: "agent", id: "a" }, revision: (await readConfig(home)).revision })).status).toBe(200);
  expect((await post(`/installed/${installed.id}/uninstall`, { revision: (await readConfig(home)).revision })).status).toBe(200);
  expect((await readConfig(home)).config.connections).toEqual([]);
});
it("rejects invalid input, stale revisions, and path traversal metadata", async () => {
  expect((await fetch(url + "/api/market/search?kind=bad")).status).toBe(400);
  expect((await fetch(url + "/api/market/search?kind=mcp&sort=unknown")).status).toBe(400);
  expect((await fetch(url + "/api/market/search?kind=skill&source=unknown")).status).toBe(400);
  expect(await (await fetch(url + "/api/market/search?kind=mcp&source=clawhub")).json()).toEqual({ items: [] });
  expect((await post("/install", null)).status).toBe(400);
  expect((await post("/install", { catalogId: "mcp:org.example/demo", version: "1.0.0", revision: "old", targets: [{ kind: "agent", id: "a" }] })).status).toBe(409);
  const initial = await readConfig(home);
  expect((await fetch(url + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: initial.revision,
    config: { ...initial.config, marketInstallations: [{ id: "market-" + "a".repeat(20), catalogId: "skill:anthropics/sample", kind: "skill", name: "sample", description: "", version: "1", sourceUrl: "https://github.com", installedAt: new Date().toISOString(), packageId: "../../outside" }] } }) })).status).toBe(400);
});
it("shows a loaded market Skill as effective when the CLI returns an equivalent filesystem path", async () => {
  const chat = store.createConversation({ projectId: "", agentId: "a", cli: "codex", model: null });
  const root = join(home, "runtime", chat.id, "skills", "sample");
  await mkdir(root, { recursive: true }); await writeFile(join(root, "SKILL.md"), "---\nname: sample\n---\nSynthetic skill");
  const alias = join(home, "skill-alias"); await symlink(root, alias);
  const snapshot = await readConfig(home);
  snapshot.config.skillLibrary = [{ id: "sample-skill", name: "sample", path: root }]; snapshot.config.agents[0].skillIds = ["sample-skill"];
  await writeConfig(home, snapshot.config, snapshot.revision);
  const context = conversationContext(snapshot.config, chat, home);
  vi.spyOn(manager, "getVerification").mockReturnValue({ mcp: {}, skills: [{ name: "sample", path: join(alias, "SKILL.md") }], loadedSignature: capabilitySignature(context.project, context.agent) });
  const response = await (await fetch(url + `/api/effective?projectId=&agentId=a&cli=codex&conversationId=${chat.id}`)).json();
  expect(response.skills[0].status).toBe("effective");
});

it("roundtrips source settings through the protected service route and rejects invalid adapters and stale writes", async () => {
  const initial = await (await fetch(url + "/api/market/sources")).json();
  const source = { id: "github:example/skills", name: "Example", url: "https://github.com/example/skills", kind: "skill", adapter: "github-skills" };
  const put = (data: unknown, origin = url) => fetch(url + "/api/market/sources", { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(data) });
  const input = { revision: initial.revision, sources: [source], enabled: [source.id] };
  expect((await put(input, "https://foreign.example")).status).toBe(403);
  const saved = await (await put(input)).json();
  expect(saved.sources.at(-1)).toEqual(source);
  expect(await (await fetch(url + "/api/market/sources")).json()).toEqual(saved);
  const stale = await put(input);
  expect(stale.status).toBe(409);
  expect((await stale.json()).error).toBe("market sources changed");
  expect((await put({ ...input, revision: saved.revision, sources: [{ ...source, adapter: "website" }] })).status).toBe(400);
});

it("cancels the upstream catalog read when its local HTTP client disconnects", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const boundedMarket = createMarket(home, async (_url, signal) => {
    upstreamSignal = signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const isolated = createHttpServer({ requireIdentity: false, home, store, manager, market: boundedMarket });
  isolated.listen(0, "127.0.0.1"); await once(isolated, "listening");
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${(isolated.address() as { port: number }).port}/api/market/search?kind=mcp`, { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(upstreamSignal).toBeInstanceOf(AbortSignal));
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(upstreamSignal!.aborted).toBe(true));
  } finally {
    isolated.closeAllConnections();
    await new Promise<void>(resolve => isolated.close(() => resolve()));
  }
});
it('protects extension mutations with the same origin guard and validates their bodies', async () => {
  const initial = await (await fetch(url + '/api/market/extensions')).json();
  expect(initial.items).toEqual([]);
  expect((await post('/extensions/uninstall', { catalogId: 'theme:paper', revision: initial.revision }, 'https://foreign.example')).status).toBe(403);
  expect((await post('/extensions/install', { catalogId: 'theme:paper', revision: initial.revision })).status).toBe(400);
  expect((await post('/extensions/uninstall', { catalogId: 'theme:paper', revision: 'stale' })).status).toBe(409);
  expect((await post('/extensions/uninstall', null)).status).toBe(400);
  expect(await (await fetch(url + '/api/market/extensions')).json()).toEqual(initial);
});
