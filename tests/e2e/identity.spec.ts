import {pickDirectoryAgent, pickDirectoryProject} from './helpers/navigation';
import {openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { test, expect } from "@playwright/test";

test("identity color and regenerated avatar survive saving and reload", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: [{ id: "identity-project", name: "Personal project", cwd: "/tmp", agentIds: ["identity-agent"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "identity-agent", name: "Personal reader", instructions: "Read personal examples", defaultCli: "codex", models: {}, mcp: [], skills: [] }] } } });
  await page.addInitScript(() => { crypto.randomUUID = () => "00000000-0000-4000-8000-000000000001"; });
  await page.goto("/settings/agents");await pickDirectoryAgent(page);
  const preview = page.locator(".identity-preview svg");
  const original = await preview.innerHTML();
  await page.getByLabel("身份颜色", { exact: true }).fill("#a031b6");
  const colored = await preview.innerHTML();
  await page.getByRole("button", { name: "重新生成头像", exact: true }).click();
  const regenerated = await preview.innerHTML();
  expect(regenerated).not.toBe(original);
  expect(regenerated).not.toBe(colored);
  await waitForAutosave(page);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.agents[0].color).toBe("#a031b6");
  expect(saved.agents[0].avatarSeed).toEqual(expect.any(String));
  await page.reload();
  await expect(page.getByLabel("身份颜色", { exact: true })).toHaveValue("#a031b6");
  expect(await page.locator(".identity-preview svg").innerHTML()).toBe(regenerated);
  await page.getByRole("button", { name: "恢复默认颜色", exact: true }).click();
  await waitForAutosave(page);
  expect((await (await request.get("/api/config")).json()).config.agents[0]).not.toHaveProperty("color");
});

test("shared agents retain one appearance across project contexts and narrow settings", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: ["first", "second"].map((id) => ({ id, name: `Personal ${id}`, cwd: "/tmp", agentIds: ["shared-reader"], resources: [], mcp: [], skills: [] })),
    agents: [{ id: "shared-reader", name: "Shared reader", color: "#2977bb", avatarSeed: "shared-seed", instructions: "Read", defaultCli: "codex", models: {}, mcp: [], skills: [] }] } } });
  await page.goto("/settings/projects");await pickDirectoryProject(page);
  await openProjectBackground(page);
  await page.getByRole("tab", { name: "参与者", exact: true }).click();
  const firstAppearance = await page.locator(".check-list svg").innerHTML();
  await page.getByRole("link", { name: "Personal second", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/manage\?project=second&tab=members$/);
  expect(await page.locator(".check-list svg").innerHTML()).toBe(firstAppearance);
  await page.getByRole("tab", { name: "背景", exact: true }).click();
  const projectMarker = page.locator(".identity-preview [data-project-marker]");
  await expect(projectMarker).toBeVisible();
  await expect(projectMarker.locator("rect")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新生成头像", exact: true })).toHaveCount(0);
  const firstProjectColor = await projectMarker.getAttribute("stroke");
  await page.getByRole("link", { name: "Personal first", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/manage\?project=first&tab=background$/);
  await expect(projectMarker).not.toHaveAttribute("stroke", firstProjectColor!);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".identity-preview svg")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.projects[0]).not.toHaveProperty("color");
  expect(saved.projects[0]).not.toHaveProperty("avatarSeed");
});
