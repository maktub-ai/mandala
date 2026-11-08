import {waitForAutosave} from './helpers/settings';
import { test, expect } from "@playwright/test";
import { openSidebar } from "./helpers/navigation";

test("project picker supports keyboard search, selection and dismissal", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const projects = Array.from({ length: 12 }, (_, index) => ({ id: `control-project-${index}`, name: `Reading workspace ${index + 1}`,
    cwd: "/tmp", agentIds: [], resources: [], mcp: [], skills: [] }));
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects, agents: [] } } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=control-project-0");
  const picker = page.getByRole("combobox", { name: "当前项目", exact: true });
  await picker.focus();
  await picker.press("ArrowDown");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: projects[0].name, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(picker).toContainText(projects[11].name);
  await expect(list).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await page.getByRole("searchbox", { name: "当前项目 · 搜索选项", exact: true }).fill("workspace 3");
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toContainText(projects[2].name);
  await picker.click();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await page.locator(".chat-setup h1").click();
  await expect(list).toHaveCount(0);
  await expect(page.locator("select:visible")).toHaveCount(0);
});

test("Agent content list contains long names on narrow screens without requiring a Project", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const name = "A personal reading agent with a very long name that remains distinguishable";
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [],
    agents: [{ id: "control-agent", name, instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/agents");
  await expect(page.locator(".directory-overview").getByRole("button", { name: `智能体 · ${name}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("combobox", { name: "模型目录读取环境", exact: true })).toHaveCount(0);
  await expect(page.locator("select:visible")).toHaveCount(0);
});

test("MCP transport uses the designed picker and saves the selected connection fields", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, agents: [],
    projects: [{ id: "mcp-picker", name: "Synthetic MCP project", cwd: "/tmp", agentIds: [], resources: [], mcp: [], skills: [] }],
  } } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "添加 MCP", exact: true }).click();
  await page.getByRole("textbox", { name: "MCP 名称", exact: true }).fill("synthetic-http");
  await page.getByRole("textbox", { name: "启动命令", exact: true }).fill("node");
  const transport = page.getByRole("combobox", { name: "连接类型", exact: true });
  const bounds = (await transport.boundingBox())!;
  await transport.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "HTTP", exact: true }).click();
  await expect(transport).toHaveAttribute("data-value", "http");
  await expect(page.getByRole("textbox", { name: "启动命令", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill("https://example.test/synthetic-mcp");
  await page.getByRole("button", { name: "创建 MCP", exact: true }).click();
  await expect(page.locator("select:visible")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.connections?.map(({id: _id, ...definition}: {id: string}) => definition)).toEqual([
    { name: "synthetic-http", transport: "http", url: "https://example.test/synthetic-mcp" },
  ]);
  await page.reload();
  await expect(transport).toHaveAttribute("data-value", "http");
  await expect(page.getByRole("textbox", { name: "URL", exact: true })).toHaveValue("https://example.test/synthetic-mcp");
});
