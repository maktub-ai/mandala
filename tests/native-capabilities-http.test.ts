import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { readConfig, writeConfig } from "../server/config";
import { createHttpServer } from "../server/http";
import { createSessionManager, type SessionManager } from "../server/sessions";
import { openStore, type Store } from "../server/store";

const location = vi.hoisted(() => ({ userHome: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => location.userHome }));
let root: string, home: string, project: string, skillPath: string, log: string, url: string;
let server: Server, manager: SessionManager, store: Store;
const skillText = "---\nname: project-review\ndescription: Project-only review\n---\nRead this project.";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mana-native-http-")));
  home = join(root, "app"); project = join(root, "project"); log = join(root, "discovery-cwd.txt");
  location.userHome = join(root, "user");
  const bin = join(root, "bin");
  await mkdir(bin);
  skillPath = join(project, ".agents", "skills", "review", "SKILL.md");
  await mkdir(join(project, ".agents", "skills", "review"), { recursive: true });
  await writeFile(skillPath, skillText);
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.slice(2).join(" ") !== "mcp list --json") process.exit(2);
fs.writeFileSync(process.env.MANA_TEST_DISCOVERY_CWD, process.cwd());
process.stdout.write(JSON.stringify([{ name: "environment-reader", enabled: true }]));
`);
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  vi.stubEnv("CODEX_HOME", join(location.userHome, ".codex"));
  vi.stubEnv("MANA_TEST_DISCOVERY_CWD", log);
  const snapshot = await readConfig(home);
  snapshot.config.agents.push({ id: "a", name: "Reviewer", instructions: "", models: {}, defaultCli: "codex", mcp: [], skills: [] });
  snapshot.config.projects.push({ id: "p", name: "Project", cwd: project, resources: [], agentIds: ["a"], mcp: [], skills: [] });
  await writeConfig(home, snapshot.config, snapshot.revision);
  store = openStore(home);
  manager = createSessionManager(store, async () => (await readConfig(home)).config, undefined, undefined, home);
  server = createHttpServer({ requireIdentity: false, home, store, manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  await manager?.close(); store?.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("runs native MCP discovery without a selected project from an existing neutral app directory", async () => {
  await expect(stat(join(home, "workspaces", "conversations", "preview"))).rejects.toThrow();
  const response = await fetch(url + "/api/capabilities?cli=codex&agentId=a");
  expect(response.status).toBe(200);
  const inventory = await response.json();
  expect(inventory.mcp).toContainEqual(expect.objectContaining({ name: "environment-reader", source: "native" }));
  const cwd = await readFile(log, "utf8");
  expect((await stat(cwd)).isDirectory()).toBe(true);
  expect(cwd.startsWith(resolve(home) + "/")).toBe(true);
  expect(cwd).not.toBe(project);
  expect(cwd).not.toBe(process.cwd());
  expect(inventory.skills).toEqual([]);
  expect(await readFile(skillPath, "utf8")).toBe(skillText);
});

it("keeps an explicitly selected project as the discovery context and only reads its native skills", async () => {
  const response = await fetch(url + "/api/capabilities?cli=codex&agentId=a&projectId=p");
  const inventory = await response.json();
  expect(response.status).toBe(200);
  expect(inventory.mcp).toContainEqual(expect.objectContaining({ name: "environment-reader" }));
  expect(await readFile(log, "utf8")).toBe(project);
  expect(inventory.skills).toContainEqual({ name: "project-review", source: "native", scope: "directory", path: skillPath });
  expect(await readFile(skillPath, "utf8")).toBe(skillText);
});
