import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, validateConfig, writeConfig } from "../server/config";
import { conversationContext } from "../server/conversation-context";
import { prepareCapabilityRuntime } from "../server/omp";
import { capabilitySignature } from "../server/capabilities";
import type { Config } from "../shared/types";
import { validateManagedSkillContent } from "../shared/skills";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-managed-skills-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const content = "---\nname: review\ndescription: Review a change\n---\nRead the change carefully.";
const fixture = (): Config => ({ version: 2,
  agents: [{ id: "a", name: "Reviewer", defaultCli: "codex", instructions: "", models: {}, mcp: [], skills: [], skillIds: ["review"], connectionIds: ["docs"] },
    { id: "b", name: "Writer", defaultCli: "omp", instructions: "", models: {}, mcp: [], skills: [], skillIds: ["review"], connectionIds: ["docs"] }],
  projects: [{ id: "p", name: "Project", cwd: home, agentIds: ["a", "b"], resources: [], mcp: [], skills: [] }],
  skillLibrary: [{ id: "review", name: "review", path: "", content }],
  connections: [{ id: "docs", name: "docs", transport: "http", url: "https://example.test/mcp" }],
});

it("persists shared skill content and assignment pauses without changing another agent", async () => {
  const config = fixture();
  config.agents[0].disabledSkillIds = ["review"];
  config.agents[0].disabledConnectionIds = ["docs"];
  await writeConfig(home, config, (await readConfig(home)).revision);
  const saved = await readConfig(home);
  expect(saved.config.skillLibrary).toMatchObject(config.skillLibrary!);
  expect(saved.config.agents[0]).toMatchObject({ skillIds: ["review"], disabledSkillIds: ["review"], connectionIds: ["docs"], disabledConnectionIds: ["docs"] });
  const paused = conversationContext(saved.config, { projectId: "p", agentId: "a" }, home);
  const active = conversationContext(saved.config, { projectId: "p", agentId: "b" }, home);
  expect(paused.agent.skills).toEqual([]);
  expect(paused.agent.mcp).toEqual([]);
  expect(active.agent.skills).toEqual([{ name: "review", path: "", content }]);
  expect(active.agent.mcp).toHaveLength(1);
  saved.config.agents[0].disabledSkillIds = [];
  await writeConfig(home, saved.config, saved.revision);
  expect(conversationContext((await readConfig(home)).config, { projectId: "p", agentId: "a" }, home).agent.skills).toHaveLength(1);
});

it.each(["agents", "projects"] as const)("rejects invalid disabled references on %s even when their assignments are paused", (kind) => {
  const config = fixture();
  const owner = config[kind][0];
  owner.skillIds = ["review"];
  owner.connectionIds = ["docs"];
  for (const key of ["disabledSkillIds", "disabledConnectionIds"] as const) {
    for (const refs of [["missing"], [key === "disabledSkillIds" ? "review" : "docs", key === "disabledSkillIds" ? "review" : "docs"], "review", null]) {
      const invalid = structuredClone(config);
      (invalid[kind][0] as any)[key] = refs;
      expect(() => validateConfig(invalid)).toThrow();
    }
  }
  owner.disabledSkillIds = ["review"];
  config.skillLibrary = [];
  expect(() => validateConfig(config)).toThrow();
});

it("does not let pausing hide duplicate assignments or duplicate capability names", () => {
  const config = fixture();
  config.agents[0].skillIds = ["review", "review"];
  config.agents[0].disabledSkillIds = ["review"];
  expect(() => validateConfig(config)).toThrow();
  config.skillLibrary!.push({ id: "review-other", name: "review", path: "", content });
  config.agents[0].skillIds = ["review", "review-other"];
  expect(() => validateConfig(config)).toThrow();
});

it.each([
  { content: "" }, { content: " \n " }, { content: 12 }, { content: null }, { content: "x".repeat(200001) },
  { content, path: "/tmp/ambiguous-source" }, { content: undefined, path: "relative/path" }, { name: "../escape" },
])("rejects invalid managed content or ambiguous sources: %j", (patch) => {
  const config = fixture(); Object.assign(config.skillLibrary![0], patch);
  expect(() => validateConfig(config)).toThrow("invalid configuration");
});

it.each([
  ["Read the change.", "invalid Skill metadata"],
  ["---\nname: other\ndescription: Review\n---\nRead.", "Skill metadata name must match"],
  ["---\nname: review\n---\nRead.", "invalid Skill description"],
  ["---\nname: review\nname: other\ndescription: Review\n---\nRead.", "invalid Skill metadata"],
  ["---\nname: &name review\ndescription: *name\n---\nRead.", "invalid Skill metadata"],
])("requires usable native metadata without rewriting stored content: %s", (body, message) => {
  const config = fixture(); config.skillLibrary![0].content = body;
  expect(() => validateConfig(config)).toThrow(message);
  expect(validateManagedSkillContent("review", body)).toContain(message);
});

it("uses the same content limits and metadata checks in the browser validator", () => {
  expect(validateManagedSkillContent("review", content)).toBeUndefined();
  expect(validateManagedSkillContent("../review", content)).toBe("invalid Skill name");
  for (const value of ["", " ", null, 12, "x".repeat(200001)])
    expect(validateManagedSkillContent("review", value)).toBe("Skill content must contain 1 to 200000 characters");
});

it("checks a bound caller's authorization inside the write queue and immediately before replacing configuration", async () => {
  const { revision } = await readConfig(home);
  let checks = 0;
  await expect(writeConfig(home, fixture(), revision, () => {
    if (++checks === 2) throw new Error("Invocation expired");
  })).rejects.toThrow("Invocation expired");
  expect(checks).toBe(2);
  expect((await readConfig(home)).revision).toBe(revision);
  expect((await readdir(home)).some(name => /^config-.*\.tmp$/.test(name))).toBe(false);
  await expect(writeConfig(home, fixture(), revision, () => { throw new Error("Invocation expired"); })).rejects.toThrow("Invocation expired");
  expect((await readConfig(home)).revision).toBe(revision);
});

it("rejects a queued write if its caller has expired before the write begins", async () => {
  const { revision } = await readConfig(home);
  let active = true;
  const first = writeConfig(home, fixture(), revision);
  const queued = writeConfig(home, { ...fixture(), skillLibrary: [] }, revision, () => {
    if (!active) throw new Error("Invocation expired while queued");
  });
  active = false;
  const results = await Promise.allSettled([first, queued]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "Invocation expired while queued" } });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
});

it("stages managed SKILL.md beside legacy packages and refreshes only the isolated execution directory", async () => {
  const source = join(home, "legacy-source");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "Legacy instructions");
  await writeFile(join(source, "references", "guide.md"), "Legacy guide");
  const skills = [{ name: "review", path: "", content }, { name: "legacy", path: source }];
  const root = await prepareCapabilityRuntime(home, "conversation", [], skills);
  expect(await readFile(join(root, "skills", "review", "SKILL.md"), "utf8")).toBe(content);
  expect(await readdir(join(root, "skills", "review"))).toEqual(["SKILL.md"]);
  expect(await readFile(join(root, "skills", "legacy", "references", "guide.md"), "utf8")).toBe("Legacy guide");
  const context = conversationContext(fixture(), { projectId: "p", agentId: "a" }, home);
  const before = capabilitySignature(context.project, context.agent);
  context.agent.skills[0].content += "\nUpdated instructions.";
  expect(capabilitySignature(context.project, context.agent)).not.toBe(before);
  await prepareCapabilityRuntime(home, "conversation", [], context.agent.skills);
  expect(await readFile(join(root, "skills", "review", "SKILL.md"), "utf8")).toContain("Updated instructions.");
  expect(await readdir(join(root, "skills"))).toEqual(["review"]);
  expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe("Legacy instructions");
});
