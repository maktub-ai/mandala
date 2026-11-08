import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarket } from "../server/market";
import { readConfig, writeConfig } from "../server/config";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";

// All platform config, downloaded packages and reading samples stay in a new temporary home.
const home = await mkdtemp(join(tmpdir(), "mandala-market-smoke-"));
console.log("Temporary acceptance home: " + home);
console.log(execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());
const initial = await readConfig(home);
initial.config.agents.push({ id: "reader", name: "Market reader", instructions: "Use only the temporary acceptance sample and the installed Skill/MCP. Do not read personal files, credentials or other projects.", defaultCli: "codex", models: {}, skills: [], mcp: [] });
initial.config.projects.push({ id: "reading", name: "Personal reading sample", cwd: "", agentIds: ["reader"], resources: [], skills: [], mcp: [] });
await writeConfig(home, initial.config, initial.revision);
const market = createMarket(home);
const skill = await market.detail("skill:anthropics/brand-guidelines");
const install = async (catalogId: string, version: string, kind: "agent" | "project") => market.install({ catalogId, version, revision: (await readConfig(home)).revision,
  targets: [{ kind, id: kind === "agent" ? "reader" : "reading" }] });
const installedSkill = await install(skill.catalogId, skill.version, "agent");
const skillPath = (await readConfig(home)).config.skillLibrary![0].path;
const source = await readFile(join(skillPath, "SKILL.md"), "utf8");
if (!source.includes("#d97757") || !source.includes("Poppins")) throw new Error("Brand guidelines changed; update the acceptance assertions after review.");
const tools = await market.search("mcp", "io.github.upstash/context7");
const mcp = tools.items.find(item => item.catalogId === "mcp:io.github.upstash/context7");
if (!mcp) throw new Error("Context7 not found in the official registry");
const installedMcp = await install(mcp.catalogId, mcp.version, "project");
const clawSkill = await market.detail("skill:clawhub/steipete/github");
const installedClaw = await install(clawSkill.catalogId, clawSkill.version, "agent");
const config = (await readConfig(home)).config;
const clawPath = config.skillLibrary!.find(entry => entry.id === installedClaw.id)!.path;
if (!(await readFile(join(clawPath, "SKILL.md"), "utf8")).includes("gh CLI") && !(await readFile(join(clawPath, "SKILL.md"), "utf8")).includes("`gh`")) throw new Error("ClawHub sample changed; inspect the source.");
await writeFile(join(config.projects[0].cwd, "reading-sample.txt"), "Synthetic reading list: A Field Guide to CSS and Design.\n");
console.log("PASS real catalog downloads: brand-guidelines @ " + skill.version + "; context7 @ " + mcp.version + "; ClawHub steipete/github @ " + clawSkill.version);
const store = openStore(home), manager = createSessionManager(store, async () => (await readConfig(home)).config, undefined, undefined, home);
const report: Record<string, unknown> = { home, skillVersion: skill.version, mcpVersion: mcp.version, clawVersion: clawSkill.version };
try {
  const chat = await manager.create("reading", "reader", undefined, "codex");
  report.conversationId = chat.id;
  await manager.send(chat.id, "$github Read the installed github Skill and state which local CLI it describes. Do not execute GitHub commands or contact GitHub. $brand-guidelines Read the installed skill. Tell me the exact primary orange accent color and heading/body fonts from it. Then use the installed io-github-upstash-context7 MCP resolve-library-id tool to resolve the React documentation library. Report the returned library ID. Use no other MCP servers and do not read personal files.");
  const deadline = Date.now() + 180000;
  while (["running", "approval"].includes(store.getConversation(chat.id)!.status)) {
    if (manager.getApprovals(chat.id).length) throw new Error("Native approval is pending; inspect this temporary acceptance conversation.");
    if (Date.now() > deadline) { await manager.stop(chat.id); throw new Error("Timed out waiting for the real market acceptance reply"); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Capability inventory is read asynchronously after submission; wait for that readback separately.
  const verificationDeadline = Date.now() + 60000;
  while (!manager.getVerification(chat.id) && Date.now() < verificationDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  const events = store.listEvents(chat.id, 0), verification = manager.getVerification(chat.id);
  const output = events.filter(event => event.kind === "text").map(event => (event.data as { text?: string }).text ?? "").join("");
  report.status = store.getConversation(chat.id)!.status; report.verification = verification; report.output = output;
  report.tools = events.filter(event => event.kind === "tool").map(event => event.data);
  if (report.status !== "idle" || !output.includes("#d97757") || !output.includes("Poppins") || !output.includes("Lora"))
    throw new Error("Real installed Skill use was not verified");
  const loadedSkill = verification?.skills.find(entry => entry.name === "brand-guidelines");
  if (!verification || !loadedSkill || await realpath(loadedSkill.path) !== await realpath(join(home, "runtime", chat.id, "skills", "brand-guidelines", "SKILL.md")))
    throw new Error("Installed Skill was not acknowledged by the CLI");
  const loadedClaw = verification.skills.find(entry => entry.name === "github");
  if (!loadedClaw || await realpath(loadedClaw.path) !== await realpath(join(home, "runtime", chat.id, "skills", "github", "SKILL.md")) || !/\bgh\b/.test(output)) throw new Error("Real ClawHub Skill loading and use were not verified");
  const connection = config.connections!.find(entry => entry.id === installedMcp.id)!;
  if (verification.mcp[connection.name] !== "connected" || !JSON.stringify(report.tools).includes("resolve-library-id") || !/\/[^\s]+react/i.test(output))
    throw new Error("Real installed MCP tool use was not verified");
  console.log("PASS real Codex Anthropic + ClawHub Skill loading and answer; MCP connected and resolve-library-id invoked");
  await market.unlink(installedSkill.id, { kind: "agent", id: "reader" }, (await readConfig(home)).revision);
  await market.unlink(installedMcp.id, { kind: "project", id: "reading" }, (await readConfig(home)).revision);
  await market.unlink(installedClaw.id, { kind: "agent", id: "reader" }, (await readConfig(home)).revision);
  await market.uninstall(installedClaw.id, (await readConfig(home)).revision);
  await market.uninstall(installedSkill.id, (await readConfig(home)).revision);
  await market.uninstall(installedMcp.id, (await readConfig(home)).revision);
  if ((await market.installed()).length) throw new Error("Uninstall readback failed");
  console.log("PASS unlink/uninstall readback");
} catch (error) {
  report.error = (error as Error).message; throw error;
} finally {
  await writeFile(join(home, "acceptance.json"), JSON.stringify(report, null, 2)); await manager.close(); store.close();
  console.log("Acceptance evidence: " + join(home, "acceptance.json"));
}
