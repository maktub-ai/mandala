import { afterEach, expect, it, vi } from "vitest";
import { configuredRuntime, resolveRuntime, runtimeSignature, validateRuntimeArgs, validateRuntimeEnv } from "../server/runtime";
import { startCodex } from "../server/codex";
import { startOmp } from "../server/omp";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderChineseMarkup } from "./helpers/render-ui";
import RuntimeSettingsEditor from "../src/RuntimeSettingsEditor";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import type { Config } from "../shared/types";

afterEach(() => vi.unstubAllEnvs());

it("explains Agent parameters by default without presenting Project override rules", () => {
  const markup = renderChineseMarkup(createElement(RuntimeSettingsEditor, { onChange() {} }));
  expect(markup).toContain("参数与环境变量随此 智能体 使用，按所选 CLI 分别加载。");
  expect(markup).not.toContain("Project 启动参数整组覆盖 Agent");
  expect(markup).not.toContain("空参数列表清除 Agent 参数");
  expect(markup).toContain("沿用原生设置");
});

it.each(["HOME", "CODEX_HOME", "OMP_PROFILE", "PI_CODING_AGENT_DIR", "NODE_OPTIONS"])("rejects the reserved runtime environment key %s", (key) => {
  expect(() => validateRuntimeEnv({ [key]: "${PRIVATE_ENV_REFERENCE}" })).toThrow(`Reserved runtime environment variable: ${key}`);
  for (const cli of ["codex", "omp"] as const)
    expect(() => resolveRuntime(cli, { [cli]: { env: { [key]: "${PRIVATE_ENV_REFERENCE}" } } }))
      .toThrow(`Reserved runtime environment variable: ${key}`);
});

it("keeps ordinary service environment references available without storing their values", () => {
  vi.stubEnv("MANA_SERVICE_KEY", "synthetic-service-secret");
  const env = { SERVICE_API_KEY: "${MANA_SERVICE_KEY}" };
  expect(() => validateRuntimeEnv(env)).not.toThrow();
  expect(resolveRuntime("codex", { codex: { env } }).env.SERVICE_API_KEY).toBe("synthetic-service-secret");
  expect(env.SERVICE_API_KEY).toBe("${MANA_SERVICE_KEY}");
});

it("reads each CLI's Agent configuration without introducing another runtime layer", () => {
  const agent = { codex: { args: ["--strict-config"], env: { SERVICE: "${AGENT_VALUE}" } } };
  expect(configuredRuntime("codex", agent)).toEqual({ fullAccess: true, args: ["--strict-config"], env: { SERVICE: "${AGENT_VALUE}" } });
  expect(configuredRuntime("omp", agent)).toEqual({ args: [], env: {} });
});

it("resolves environment references only in memory while the signature contains references", () => {
  vi.stubEnv("MANA_TEST_KEY", "synthetic-secret-value");
  const runtime = { codex: { env: { SERVICE_KEY: "${MANA_TEST_KEY}" } } };
  expect(resolveRuntime("codex", runtime)).toEqual({ fullAccess: true, extraArgs: [], env: { SERVICE_KEY: "synthetic-secret-value" } });
  expect(runtimeSignature("codex", runtime)).toContain("${MANA_TEST_KEY}");
  expect(runtimeSignature("codex", runtime)).not.toContain("synthetic-secret-value");
  expect(runtime.codex.env.SERVICE_KEY).toBe("${MANA_TEST_KEY}");
});

it("reports only the missing environment variable name", () => {
  vi.stubEnv("MANA_MISSING_KEY", undefined);
  expect(() => resolveRuntime("omp", { omp: { env: { SERVICE_KEY: "${MANA_MISSING_KEY}" } } }))
    .toThrow("Missing environment variable: MANA_MISSING_KEY");
});

it.each([
  ["codex", ["--listen=ws://0.0.0.0:9999"]],
  ["codex", ["-c", "model=other"]],
  ["codex", ["--code-mode-host", "https://example.test"]],
  ["codex", ["--help"]],
  ["omp", ["--mode=json"]],
  ["omp", ["--cwd", "/tmp"]],
  ["omp", ["-rprivate-session"]],
  ["omp", ["--api-key=literal-private-value"]],
  ["omp", ["--auto-approve"]],
  ["omp", ["--", "run a task"]],
  ["omp", ["run a task"]],
] as const)("rejects arguments that bypass managed %s execution", (cli, args) => {
  expect(() => validateRuntimeArgs(cli, [...args])).toThrow();
});

it("allows native flags and their supported values without claiming parser validation", () => {
  expect(() => validateRuntimeArgs("codex", ["--strict-config", "--unknown-native-option=value"])).not.toThrow();
  expect(() => validateRuntimeArgs("codex", ["--profile", "personal"])).not.toThrow();
  expect(() => validateRuntimeArgs("omp", ["--thinking", "high", "--no-pty", "--unknown-native-option=value"])).not.toThrow();
});
it.each([
  { args: ["--enable"], flag: "--enable" }, { args: ["--enable", "--disable"], flag: "--enable" },
  { args: ["--profile"], flag: "--profile" }, { args: ["--profile", ""], flag: "--profile" },
  { args: ["--profile="], flag: "--profile" }, { args: ["-p"], flag: "-p" },
])("rejects a known flag whose value is missing", ({ args, flag }) => {
  expect(() => validateRuntimeArgs("codex", args)).toThrow(`Missing value for runtime argument: ${flag}`);
});
it.each([null, "--strict-config", [42], ["--thinking\0high"]])("rejects malformed runtime argument arrays", (value) => {
  expect(() => validateRuntimeArgs("codex", value as unknown as string[])).toThrow("Invalid CLI runtime arguments");
});

it("does not expose a reserved argument value in its validation error", () => {
  try { validateRuntimeArgs("omp", ["--api-key=literal-private-value"]); }
  catch (error) {
    expect((error as Error).message).toContain("--api-key");
    expect((error as Error).message).not.toContain("literal-private-value");
    return;
  }
  throw new Error("expected a reserved argument error");
});
it.each(["codex", "omp"] as const)("surfaces %s native parser errors without retaining resolved environment values", async (cli) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-parser-error-"));
  const executable = join(dir, cli);
  await writeFile(executable, `#!/usr/bin/env node
process.stderr.write("Unknown option: --unexpected-native-option; " + process.env.MANA_TEST_VALUE);
process.exit(2);
`);
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  const exits: string[] = [];
  try {
    let message = "";
    try {
      await (cli === "codex" ? startCodex : startOmp)({ cwd: dir, extraArgs: ["--unexpected-native-option"],
        env: { MANA_TEST_VALUE: "synthetic-private-value" }, onEvent() {}, onApproval() {}, onExit: (reason) => exits.push(reason) });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Unknown option: --unexpected-native-option");
    expect(message).not.toContain("synthetic-private-value");
    expect(exits.join("\n")).not.toContain("synthetic-private-value");
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});


it.each(["codex", "omp"] as const)("passes each Agent's %s runtime unchanged when switching Projects", async (cli) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-agent-runtime-"));
  const capture = join(dir, "launches.jsonl");
  const executable = join(dir, cli);
  const captureSource = `require("node:fs").appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
    args: process.argv.slice(2), owner: process.env.MEMORY_OWNER, shared: process.env.SHARED,
    inherited: process.env.MANA_RUNTIME_INHERITED }) + "\\n");`;
  const protocol = cli === "codex" ? `import(${JSON.stringify(resolve("tests/fixtures/fake-cli.mjs"))});` : `
    const { createInterface } = require("node:readline");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      send({ type: "response", id: request.id, success: true, data: { sessionFile: "runtime-fixture-session" } });
    });`;
  await writeFile(executable, `#!/usr/bin/env node
${captureSource}
${protocol}`);
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", dir + ":" + process.env.PATH);
  vi.stubEnv("MANA_OWNER_A", "synthetic-owner-a");
  vi.stubEnv("MANA_OWNER_B", "synthetic-owner-b");
  vi.stubEnv("MANA_AGENT_SHARED", "agent-value");
  vi.stubEnv("MANA_PROJECT_SHARED", "project-value");
  vi.stubEnv("MANA_RUNTIME_INHERITED", "unchanged-native-environment");
  const args = (value: string) => cli === "codex" ? ["--profile", value] : ["--thinking", value];
  const config: Config = { version: 2,
    agents: ["a", "b"].map((id) => ({ id, name: id, instructions: "Synthetic fixture", defaultCli: cli,
      models: {}, mcp: [], skills: [], runtime: { [cli]: { args: args(id === "a" ? "high" : "low"),
        env: { MEMORY_OWNER: id === "a" ? "${MANA_OWNER_A}" : "${MANA_OWNER_B}", SHARED: "${MANA_AGENT_SHARED}" } } } })),
    projects: ["base", "override"].map((id) => ({ id, name: id, cwd: dir, agentIds: ["a", "b"], resources: [], mcp: [], skills: [],
      ...(id === "override" ? { runtime: { [cli]: { args: args("medium"), env: { SHARED: "${MANA_PROJECT_SHARED}" } } } } : {}) })),
  };
  const store = openStore(dir);
  const manager = createSessionManager(store, async () => config, startCodex, startOmp, dir);
  try {
    for (const [projectId, agentId] of [["base", "a"], ["base", "b"], ["override", "a"]]) {
      // Independent runtime probes must not compete for one still-active workspace write claim.
      const chat = await manager.create(projectId, agentId, undefined, cli, { workspaceId: null });
      await manager.send(chat.id, "Synthetic parameter verification");
    }
    const launches = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(launches.map((launch) => [launch.owner, launch.shared, launch.inherited])).toEqual([
      ["synthetic-owner-a", "agent-value", "unchanged-native-environment"],
      ["synthetic-owner-b", "agent-value", "unchanged-native-environment"],
      ["synthetic-owner-a", "agent-value", "unchanged-native-environment"],
    ]);
    for (const [index, value] of ["high", "low", "high"].entries()) {
      if (cli === "codex") expect(launches[index].args).toEqual([...args(value), "app-server", "--stdio"]);
      else expect(launches[index].args.slice(-2)).toEqual(args(value));
    }
    expect(config.agents[0].runtime?.[cli]?.env?.MEMORY_OWNER).toBe("${MANA_OWNER_A}");
    expect(runtimeSignature(cli, config.agents[0].runtime)).not.toContain("synthetic-owner-a");
  } finally {
    manager.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('routes full access only to Codex and includes it in the runtime signature',()=>{
 const runtime={codex:{fullAccess:true}} as any;
 expect(resolveRuntime('codex',runtime)).toMatchObject({fullAccess:true});
 expect(resolveRuntime('omp',runtime)).not.toHaveProperty('fullAccess');
 expect(runtimeSignature('codex',{codex:{fullAccess:false}})).not.toBe(runtimeSignature('codex'));
 expect(runtimeSignature('codex',runtime)).toBe(runtimeSignature('codex'));
 const markup=renderChineseMarkup(createElement(RuntimeSettingsEditor,{value:runtime,onChange(){}}));
 expect(markup).toContain('文件和网络权限');expect(markup).toContain('完整访问');
});

it('defaults every existing or new Codex Agent to full access without per-Agent configuration',()=>{
 for(const runtime of [undefined,{}, {codex:{args:[]}}])expect(resolveRuntime('codex',runtime)).toMatchObject({fullAccess:true});
 expect(resolveRuntime('codex',{codex:{fullAccess:false}})).toMatchObject({fullAccess:false});
 const markup=renderChineseMarkup(createElement(RuntimeSettingsEditor,{onChange(){}}));
 expect(markup).toContain('平台默认：完整访问');expect(markup).toContain('data-value="full"');
});

it.each(['codex','omp'] as const)('managed %s policy retains host controls and excludes global execution defaults from its signature',async cli=>{
 const {executionRuntimePolicy}=await import('../server/runtime');
 const agent={systemRole:'mandala' as const,runtime:{[cli]:{args:[],approvalMode:'default' as const,...cli==='codex'?{fullAccess:false}:{}}}};
 const defaults={ [cli]:{args:['--unsafe'],approvalMode:'auto' as const,fullAccess:true,gateway:'native' as const,env:{AUTH_ROUTE:'${MANAGED_CONNECTION}'}}};
 vi.stubEnv('MANAGED_CONNECTION','fixture-secret');
 const policy=executionRuntimePolicy(cli,agent,defaults);
 expect(resolveRuntime(cli,policy)).toMatchObject({extraArgs:[],env:{AUTH_ROUTE:'fixture-secret'},gateway:'native',...cli==='codex'?{fullAccess:false}:{}});
 expect(configuredRuntime(cli,policy).approvalMode).toBe('default');
 const signature=runtimeSignature(cli,policy);
 expect(signature).not.toContain('fixture-secret');
 expect(runtimeSignature(cli,executionRuntimePolicy(cli,agent,{[cli]:{...defaults[cli],args:['--another'],approvalMode:'default',fullAccess:false}}))).toBe(signature);
 expect(runtimeSignature(cli,executionRuntimePolicy(cli,agent,{[cli]:{...defaults[cli],env:{AUTH_ROUTE:'${OTHER_CONNECTION}'}}}))).not.toBe(signature);
});
