import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, validateConfig, writeConfig } from "../server/config";
import { openStore } from "../server/store";
import type { Config } from "../shared/types";
import { isValidSshHost, workspaceExecutionLocation } from "../shared/execution-machines";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-machines-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const remoteConfig = (): Config => ({
  version: 2, agents: [], executionMachines: [{ id: "linux", name: "Linux", host: "dev@build-host" }],
  projects: [{ id: "p", name: "Project", cwd: "/srv/mandala/work", resources: [], agentIds: [], mcp: [], skills: [],
    workspaces: [{ id: "remote", name: "Remote", machineId: "linux", cwd: "/srv/mandala/work", resources: [
      { id: "source", label: "Source", kind: "local", location: "/srv/mandala/source" },
    ] }] }],
});

it.each(["", "-oProxyCommand=evil", "host name", "host\n", "host\u0000", "host;evil", "user@-host", "ssh://host"])("rejects unsafe SSH target %j", host => {
  const config = remoteConfig();
  config.executionMachines![0].host = host;
  expect(() => validateConfig(config)).toThrow("invalid");
});

it("rejects duplicate machine IDs and unknown workspace machines", () => {
  const config = remoteConfig();
  config.executionMachines!.push({ id: "linux", name: "Other", host: "other-host" });
  expect(() => validateConfig(config)).toThrow("invalid");
  config.executionMachines!.pop();
  config.projects[0].workspaces![0].machineId = "missing";
  expect(() => validateConfig(config)).toThrow("invalid");
});

it("rejects duplicate SSH targets", () => {
  const config = remoteConfig();
  config.executionMachines!.push({ id: "other", name: "Other", host: "dev@build-host" });
  expect(() => validateConfig(config)).toThrow("invalid");
});

it.each(["build-host", "alice@build.example.test", "192.0.2.1", "alice@2001:db8::1", "alice@[2001:db8::1]"])("accepts OpenSSH target %j", host => {
  expect(isValidSshHost(host)).toBe(true);
  const config = remoteConfig();
  config.executionMachines![0].host = host;
  expect(() => validateConfig(config)).not.toThrow();
});

it("snapshots machine identity and an explicit directory without retaining mutable config references", () => {
  const config = remoteConfig(), workspace = config.projects[0].workspaces![0];
  const location = workspaceExecutionLocation(config, workspace, "/srv/branch");
  config.executionMachines![0].name = "Renamed";
  config.executionMachines![0].host = "different-host";
  workspace.cwd = "/srv/moved";
  expect(location).toEqual({ machineId: "linux", machineName: "Linux", host: "dev@build-host", cwd: "/srv/branch" });
  expect(workspaceExecutionLocation(config, { ...workspace, machineId: undefined })).toBeUndefined();
  expect(workspaceExecutionLocation(config, undefined)).toBeUndefined();
  expect(() => workspaceExecutionLocation(config, { ...workspace, machineId: "missing" })).toThrow("invalid execution location");
  expect(() => workspaceExecutionLocation(config, workspace, "relative")).toThrow("invalid execution location");
});

it.each(["relative", "/srv/source\u0000", "/srv/source\n"])("rejects invalid remote local-resource path %j", location => {
  const config = remoteConfig();
  config.projects[0].workspaces![0].resources[0].location = location;
  expect(() => validateConfig(config)).toThrow("invalid");
});

it.each(["", "relative/work", "~/work", "C:\\work", "/srv/work\u0000"])("requires a remote absolute POSIX directory %j", cwd => {
  const config = remoteConfig();
  config.projects[0].workspaces![0].cwd = cwd;
  expect(() => validateConfig(config)).toThrow("invalid");
});

it("saves remote directories and resources without requiring local existence", async () => {
  const { revision } = await readConfig(home);
  const config = remoteConfig();
  await writeConfig(home, config, revision);
  expect((await readConfig(home)).config.projects[0].workspaces![0]).toEqual(config.projects[0].workspaces![0]);
  expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).executionMachines).toEqual(config.executionMachines);
  await expect(stat(join(home, "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains legacy local default directory creation", async () => {
  const config: Config = { version: 2, agents: [], projects: [
    { id: "p", name: "Project", cwd: "", resources: [], agentIds: [], mcp: [], skills: [] },
  ] };
  await writeConfig(home, config, (await readConfig(home)).revision);
  expect((await stat(join(home, "workspaces", "p"))).isDirectory()).toBe(true);
  expect((await readConfig(home)).config.executionMachines).toBeUndefined();
});

it("persists the pinned execution location and prevents update patches from relocating it", () => {
  let store = openStore(home);
  const executionLocation = { machineId: "linux", machineName: "Linux", host: "dev@build-host", cwd: "/srv/mandala/work" };
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null, executionLocation });
    store.updateConversation(chat.id, { title: "Continue", executionLocation: { ...executionLocation, host: "other-host" } } as never);
    store.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)?.executionLocation).toEqual(executionLocation);
    expect(store.getConversation(chat.id)?.title).toBe("Continue");
    const local = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    expect(store.getConversation(local.id)?.executionLocation).toBeUndefined();
  } finally { store.close(); }
});
