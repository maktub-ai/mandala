import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const location = vi.hoisted(() => ({ home: "", codexMcp: [] as unknown }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => location.home }));
vi.mock("node:child_process", async importOriginal => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: async () => ({ stdout: JSON.stringify(location.codexMcp), stderr: "" }) });
  return { ...await importOriginal<typeof import("node:child_process")>(), execFile };
});
import { discoverNative, discoverNativeSkills } from "../server/capabilities";
let home: string, cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mana-native-skills-"));
  location.home = home;
  cwd = join(home, "project"); await mkdir(cwd);
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  location.codexMcp = [];
});

it("fingerprints the effective Codex MCP configuration without exposing transport credentials", async () => {
  location.codexMcp = [{ name: "same-name", enabled: true, transport: { type: "stdio", command: "reader-one", args: ["--secret", "SYNTHETIC_ARG_SECRET"], env: { TOKEN: "SYNTHETIC_TOKEN_ONE" } } }];
  const first = (await discoverNative("codex", cwd)).mcp[0];
  expect(first.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toMatch(/SYNTHETIC_ARG_SECRET|SYNTHETIC_TOKEN_ONE|reader-one/);
  location.codexMcp = [{ name: "same-name", enabled: true, transport: { env: { TOKEN: "SYNTHETIC_TOKEN_ONE" }, args: ["--secret", "SYNTHETIC_ARG_SECRET"], command: "reader-one", type: "stdio" } }];
  expect((await discoverNative("codex", cwd)).mcp[0].configurationFingerprint).toBe(first.configurationFingerprint);
  location.codexMcp = [{ name: "same-name", enabled: true, transport: { type: "stdio", command: "reader-two", args: ["--secret", "SYNTHETIC_ARG_SECRET"], env: { TOKEN: "SYNTHETIC_TOKEN_TWO" } } }];
  const changed = (await discoverNative("codex", cwd)).mcp[0];
  expect(changed.configurationFingerprint).not.toBe(first.configurationFingerprint);
  expect(JSON.stringify(changed)).not.toMatch(/SYNTHETIC_TOKEN_TWO|reader-two/);
});

it("fingerprints OMP MCP definitions so changing a same-name endpoint invalidates identity", async () => {
  const path = join(cwd, ".mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: { "same-name": { url: "https://synthetic-one.invalid", headers: { Authorization: "SYNTHETIC_PRIVATE_TOKEN" } } } }));
  const first = (await discoverNative("omp", cwd)).mcp[0];
  expect(first.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toMatch(/synthetic-one.invalid|SYNTHETIC_PRIVATE_TOKEN/);
  await writeFile(path, JSON.stringify({ mcpServers: { "same-name": { url: "https://synthetic-two.invalid", headers: { Authorization: "SYNTHETIC_PRIVATE_TOKEN" } } } }));
  expect((await discoverNative("omp", cwd)).mcp[0].configurationFingerprint).not.toBe(first.configurationFingerprint);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
it("discovers shared, nested and linked native skills without merging same-name origins or changing files", async () => {
  const shared = join(home, ".agents", "skills", "shared-review");
  const nested = join(home, ".codex", "skills", ".system", "review");
  const project = join(cwd, ".agents", "skills", "review");
  for (const root of [shared, nested, project]) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "SKILL.md"), "---\nname: review\n---\nPersonal fixture only.\n");
  }
  await mkdir(join(cwd, ".omp", "skills"), { recursive: true });
  await symlink(shared, join(cwd, ".omp", "skills", "linked-review"));
  await symlink(join(home, ".codex", "skills"), join(home, ".codex", "skills", ".system", "cycle"));
  const codex = await discoverNativeSkills("codex", cwd);
  expect(codex).toEqual(expect.arrayContaining([
    { name: "review", source: "native", path: join(shared, "SKILL.md"), scope: "user" },
    { name: "review", source: "native", path: join(nested, "SKILL.md"), scope: "user" },
    { name: "review", source: "native", path: join(project, "SKILL.md"), scope: "directory" },
  ]));
  const omp = await discoverNativeSkills("omp", cwd);
  expect(omp).toContainEqual({ name: "review", source: "native", path: join(cwd, ".omp", "skills", "linked-review", "SKILL.md"), scope: "directory" });
  expect((await discoverNative("omp", cwd)).skills).toContainEqual({ name: "review", source: "native", path: join(cwd, ".omp", "skills", "linked-review", "SKILL.md"), scope: "directory" });
  expect(await readFile(join(shared, "SKILL.md"), "utf8")).toBe("---\nname: review\n---\nPersonal fixture only.\n");
});

it("discovers OMP project Skills from Claude and Codex sources and root MCP configuration", async () => {
  for (const source of [".claude", ".codex"]) {
    const directory = join(cwd, source, "skills", "project-review");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: project-review\ndescription: Review a personal sample.\n---\nFixture only.\n");
  }
  const mcpPath = join(cwd, ".mcp.json");
  const original = JSON.stringify({ mcpServers: { "project-reader": { command: "synthetic-reader" } } });
  await writeFile(mcpPath, original);
  const skills = await discoverNativeSkills("omp", cwd);
  expect(skills).toEqual(expect.arrayContaining([".claude", ".codex"].map(source => ({
    name: "project-review", source: "native", path: join(cwd, source, "skills", "project-review", "SKILL.md"), scope: "directory",
  }))));
  expect((await discoverNative("omp", cwd)).mcp).toContainEqual(expect.objectContaining({ name: "project-reader", source: "native", path: mcpPath, configurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(await readFile(mcpPath, "utf8")).toBe(original);
});
