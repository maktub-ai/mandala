import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfig } from "../server/config";
import { conversationContext } from "../server/conversation-context";
import { prepareCapabilityRuntime } from "../server/omp";

let home: string, cache: string, plugin: string, savedPath: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mandala-plugin-upgrade-"));
  const codexHome = join(home, "codex");
  vi.stubEnv("CODEX_HOME", codexHome);
  cache = join(codexHome, "plugins", "cache");
  plugin = join(cache, "market", "analytics");
  savedPath = join(plugin, "1.2.0", "skills", "quality");
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 2,
    projects: [{ id: "p", name: "Project", cwd: home, agentIds: ["a"], resources: [], mcp: [], skills: [], skillIds: ["bound"] }],
    agents: [{ id: "a", name: "Reviewer", defaultCli: "omp", instructions: "", models: {}, mcp: [], skills: [], skillIds: ["bound"] }],
    skillLibrary: [{ id: "bound", name: "quality", path: savedPath }],
  }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

async function install(version: string, root = plugin, name = "analytics") {
  const dir = join(root, version, "skills", "quality");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, version, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, version, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version }));
  await writeFile(join(dir, "SKILL.md"), "Quality instructions " + version);
  await writeFile(join(dir, "example.csv"), version);
  return dir;
}
const binding = async () => (await readConfig(home)).config.skillLibrary![0].path;

it("loads existing project and agent bindings after successive cache replacements", async () => {
  const initial = await readFile(join(home, "config.json"), "utf8");
  for (const version of ["1.2.2", "1.3.0"]) {
    await install(version);
    const { config } = await readConfig(home);
    const { agent, project } = conversationContext(config, { agentId: "a", projectId: "p" }, home);
    const runtime = await prepareCapabilityRuntime(home, "inquiry", [], agent.skills);
    expect(await readFile(join(runtime, "skills", "quality", "SKILL.md"), "utf8")).toBe("Quality instructions " + version);
    expect(await readFile(join(runtime, "skills", "quality", "example.csv"), "utf8")).toBe(version);
    expect(project.skills).toEqual(agent.skills);
    expect(agent.skillIds).toEqual(["bound"]);
    await rm(join(plugin, version), { recursive: true });
  }
  expect(await readFile(join(home, "config.json"), "utf8")).toBe(initial);
});

it("follows the plugin's latest link when multiple versions exist", async () => {
  await install("1.2.1");
  const current = await install("1.2.2");
  expect(await binding()).toBe(savedPath);
  await symlink("1.2.2", join(plugin, "latest"), "dir");
  expect(await binding()).toBe(current);
  await rm(join(current, "SKILL.md"));
  expect(await binding()).toBe(savedPath);
});

it("keeps a working binding and leaves ordinary user skill paths alone", async () => {
  await install("1.2.0");
  await install("1.2.2");
  await symlink("1.2.2", join(plugin, "latest"), "dir");
  expect(await binding()).toBe(savedPath);
  const file = join(home, "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const external = join(home, ".agents", "skills", "quality");
  config.skillLibrary[0].path = external;
  await writeFile(file, JSON.stringify(config));
  expect(await binding()).toBe(external);
});

it("does not borrow another plugin, marketplace, or a package outside the plugin directory", async () => {
  await install("1.2.2", join(cache, "other", "analytics"));
  await install("1.2.2", join(cache, "market", "other"), "other");
  expect(await binding()).toBe(savedPath);
  await install("1.2.2", plugin, "different");
  expect(await binding()).toBe(savedPath);
  await symlink(join(cache, "other", "analytics", "1.2.2"), join(plugin, "latest"), "dir");
  expect(await binding()).toBe(savedPath);
});
