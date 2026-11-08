import { test, expect } from "@playwright/test";
import { chooseOption } from "./helpers/select";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("project resources show directory skills as read-only observations without copying them", async ({ page, request }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "mana-native-browser-"));
  const cwd = join(root, "notes"), skill = join(cwd, ".omp", "skills", "local-review");
  mkdirSync(skill, { recursive: true });
  const original = "---\nname: personal-review\n---\nPersonal fixture only.\n";
  writeFileSync(join(skill, "SKILL.md"), original);
  const archive = join(root, "archive");
  mkdirSync(archive);
  const { revision } = await (await request.get("/api/config")).json();
  const config = { version: 2, projects: [{ id: "skills", name: "Personal skills", cwd,
    workspaces: [{ id: "notes", name: "Notes", cwd, resources: [] }, { id: "archive", name: "Archive", cwd: archive, resources: [] }],
    agentIds: ["reader"], resources: [], mcp: [], skills: [{ name: "personal-review", path: "/tmp/project-review" }] }],
    agents: [{ id: "reader", name: "Reader", defaultCli: "omp", instructions: "", models: {}, mcp: [], skills: [{ name: "personal-review", path: "/tmp/agent-review" }] }] };
  await request.put("/api/config", { data: { revision, config } });
  try {
    await page.goto("/projects/manage?project=skills&tab=resources");
    const native = page.getByRole("region", { name: "项目附带技能", exact: true });
    await expect(native).toBeVisible();
    await chooseOption(page, "Skills 执行端", "omp");
    await native.getByRole("searchbox", { name: "搜索原生 Skills" }).fill("personal-review");
    const row = native.getByRole("article", { name: "personal-review" });
    await expect(row).toContainText(join(skill, "SKILL.md"));
    await expect(row).toContainText("工作目录");
    await expect(row).toContainText("Project 覆盖（待验证）");
    await expect(row).toContainText("已发现 · 未验证加载");
    await expect(row.locator("input, textarea")).toHaveCount(0);
    await native.screenshot({ path: testInfo.outputPath("native-skills-desktop.png") });
    await chooseOption(page, "Skills 目录组", "archive");
    await expect(row).toHaveCount(0);
    await chooseOption(page, "Skills 目录组", "notes");
    await expect(row).toContainText(join(skill, "SKILL.md"));
    await expect(native.locator('input:not([type="search"]), textarea, [role="switch"]')).toHaveCount(0);
    await chooseOption(page, "Skills 执行端", "codex");
    await expect(row).toHaveCount(0);
    const stored = (await (await request.get("/api/config")).json()).config;
    expect(stored.skillLibrary.map((s: { name: string }) => s.name)).toEqual(["personal-review", "personal-review"]);
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native skills handle discovery failures and narrow English settings", async ({ page, request }, testInfo) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2, projects: [{ id: "skills", name: "Skills fixture", cwd: "/tmp", agentIds: [], resources: [], mcp: [], skills: [] }], agents: [] } } });
  await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
  let failed = true;
  await page.route("**/api/capabilities?**", async route => {
    if (failed) await route.fulfill({ status: 500, json: { error: "Discovery unavailable" } });
    else await route.fulfill({ json: { mcp: [], skills: [{ name: "global-reader", source: "native", scope: "user", path: "/synthetic/.agents/skills/global-reader/SKILL.md" }, { name: "project-reader", source: "native", scope: "directory", path: "/tmp/.agents/skills/project-reader/SKILL.md" }] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/projects/manage?project=skills&tab=resources");
  const native = page.getByRole("region", { name: "Project directory skills", exact: true });
  await expect(native.getByRole("alert")).toContainText("Discovery unavailable");
  failed = false;
  await native.getByRole("button", { name: "Refresh native Skills", exact: true }).click();
  await expect(native.getByRole("article", { name: "global-reader" })).toHaveCount(0);
  await expect(native.getByRole("article", { name: "project-reader" })).toContainText("Discovered · Loading unverified");
  await expect(native).not.toContainText("Discovery unavailable");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("native-skills-mobile.png"), fullPage: true });
});

test('removing paused project capabilities clears their pause records and persists', async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  const config = { version: 2, agents: [],
    projects: [{ id: 'paused-project', name: 'Paused project fixture', cwd: '/tmp', resources: [], agentIds: [], skills: [], mcp: [], skillIds: ['skill'], disabledSkillIds: ['skill'], connectionIds: ['connection'], disabledConnectionIds: ['connection'] }],
    skillLibrary: [{ id: 'skill', name: 'paused-skill', path: '/tmp/legacy-skill' }],
    connections: [{ id: 'connection', name: 'paused-mcp', transport: 'http', url: 'https://example.invalid/mcp' }],
  };
  expect((await request.put('/api/config', { data: { revision, config } })).ok()).toBe(true);
  await page.goto('/projects/manage?project=paused-project&tab=resources');
  await page.getByText('项目专用能力', { exact: false }).click();
  await page.getByRole('checkbox', { name: 'paused-skill', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'paused-mcp', exact: true }).uncheck();
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.projects[0]).toMatchObject({ skillIds: [], disabledSkillIds: [], connectionIds: [], disabledConnectionIds: [] });
  await page.reload();
  await page.getByText('项目专用能力', { exact: false }).click();
  await expect(page.getByRole('checkbox', { name: 'paused-skill', exact: true })).not.toBeChecked();
});
