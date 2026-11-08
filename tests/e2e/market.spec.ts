import { openModuleMenu,openUserMenu } from './helpers/navigation';
import { chooseOption } from "./helpers/select";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const { revision, config: current } = await (await request.get("/api/config")).json();
  const response = await request.put("/api/config", { data: { revision, config: { ...current, version: 2, skillLibrary: [], connections: [], marketInstallations: [],
    agents: [...current.agents.filter((agent: { systemRole?: string }) => agent.systemRole), { id: "market-reader", name: "Market reader", defaultCli: "codex", instructions: "", models: {}, mcp: [], skills: [] }],
    projects: [{ id: "market-project", name: "Market project", agentIds: ["market-reader"], cwd: "", resources: [], mcp: [], skills: [] }],
  } } });
  expect(response.ok(), await response.text()).toBe(true);
});

test("browse, install, link both scopes, reload, unlink and uninstall a complete Skill package", async ({ page, request }) => {
  await page.goto("/?project=&agent=market-reader");
  await (await openModuleMenu(page)).locator('[data-area="market"]').click();
  await expect(page).toHaveURL(/\/market/);
  await page.getByRole("searchbox", { name: "搜索市场" }).fill("synthetic-reading");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "查看详情 synthetic-reading", exact: true }).click();
  await expect(page.getByText("Synthetic reading workflow", { exact: true }).first()).toBeVisible();
  await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const drawer = (await page.getByRole('dialog').boundingBox())!;
  expect(drawer.x).toBeGreaterThanOrEqual(0);
  expect(drawer.x + drawer.width).toBeCloseTo(1280, 0);
  expect(drawer.y).toBeCloseTo(0, 0);
  await page.getByRole("dialog").getByRole("button", { name: "安装", exact: true }).click();
  await page.getByRole("checkbox", { name: "智能体 · Market reader", exact: true }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("checkbox", { name: "Project · Market project", exact: true }).check();
  await page.getByRole("button", { name: "安装并关联", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已安装并关联");
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.skillLibrary).toHaveLength(1);
  expect(saved.agents.find((agent: {id: string}) => agent.id === "market-reader").skillIds).toEqual([saved.skillLibrary[0].id]);
  expect(saved.projects[0].skillIds).toEqual([saved.skillLibrary[0].id]);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "已安装", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "查看详情 synthetic-reading", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看详情 synthetic-reading", exact: true }).click();
  await expect(page.getByRole("button", { name: "卸载", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "解除关联 Market reader", exact: true }).click();
  await page.getByRole("button", { name: "解除关联 Market project", exact: true }).click();
  await page.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已卸载");
  expect((await (await request.get("/api/config")).json()).config.skillLibrary).toEqual([]);
  await page.goBack();
});

test("MCP shows the launch recipe and accepts environment references without saving credentials", async ({ page, request }) => {
  await page.goto("/market?tab=mcp");
  await page.getByRole("button", { name: "查看详情 synthetic-tools", exact: true }).click();
  await page.getByText("安装配置", { exact: true }).click();
  await expect(page.getByText("@example/synthetic-tools@1.0.0", { exact: false }).first()).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "安装", exact: true }).click();
  await page.getByRole("checkbox", { name: "智能体 · Market reader", exact: true }).check();
  await page.getByRole("textbox", { name: "SYNTHETIC_KEY", exact: true }).fill("raw-private-key");
  await page.getByRole("button", { name: "安装并关联", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("环境变量引用");
  expect((await (await request.get("/api/config")).json()).config.connections ?? []).toEqual([]);
  await page.getByRole("textbox", { name: "SYNTHETIC_KEY", exact: true }).fill("${MARKET_DEMO_KEY}");
  await page.getByRole("button", { name: "安装并关联", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已安装并关联");
  expect((await (await request.get("/api/config")).json()).config.connections[0].env).toEqual({ SYNTHETIC_KEY: "${MARKET_DEMO_KEY}" });
});

test("mobile navigation, English UI, empty results and source failure are explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { localStorage.setItem("mana-language", "en"); });
  await page.goto("/market");
  await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View details synthetic-reading", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Capability details", exact: true });
  await drawer.getByRole("button", { name: "Install", exact: true }).click();
  await drawer.getByRole("checkbox", { name: "Agent · Market reader", exact: true }).check();
  const installButton = drawer.getByRole("button", { name: "Install and link", exact: true });
  await expect(installButton).toBeVisible();
  const bounds = await installButton.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("searchbox", { name: "Search market" }).fill("no-such-skill");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No matching results.", { exact: true })).toBeVisible();
  await page.route("**/api/market/search?*", route => route.fulfill({ status: 502, json: { error: "Market source HTTP 503" } }));
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("503");
  await expect(page.getByText("No matching results.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Market uses the reviewed sidebar, can be pinned and preserves the conversation draft", async ({ page }) => {
  await page.goto("/?project=&agent=market-reader");
  await page.locator(".composer textarea").fill("Synthetic draft remains while browsing Market");
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect.poll(()=>nav.locator('.sidebar-primary-navigation a[data-area]').evaluateAll(items=>items.map(item=>item.getAttribute("data-area")))).toEqual(["tasks","projects","agents"]);
  await openModuleMenu(page);
  const modules=page.getByRole("menu",{name:"用户菜单",exact:true});
  await modules.locator('[data-area="market"]').click();
  await expect(page.getByRole("heading", { name: "市场", exact: true })).toBeVisible();
  await expect(page.locator("#navigation-chat .library-draft")).toBeVisible();
  await (await openUserMenu(page)).locator('[data-area="settings"]').click();
  await page.getByRole('switch', { name: "显示市场", exact: true }).check();
  await nav.locator('.sidebar-primary-navigation [data-area="market"]').click();
  await expect(nav.locator('.sidebar-primary-navigation [data-area="market"]')).toHaveAttribute("aria-current", "page");
  await page.locator("#navigation-chat .library-draft").click();
  await expect(page).toHaveURL(/\/?\?project=/);
  await expect(page.locator(".composer textarea")).toHaveValue("Synthetic draft remains while browsing Market");
  await nav.locator('.sidebar-primary-navigation [data-area="market"]').click();
  await page.reload();
  await expect(nav.locator('.sidebar-primary-navigation [data-area="market"]')).toHaveAttribute("aria-current", "page");
});

test("source preferences persist, filter real source identities and leave offline installations usable", async ({ page, request }) => {
  await page.goto("/market");
  await page.getByRole("button", { name: "管理来源", exact: true }).click();
  const sources = page.getByRole("dialog", { name: "管理来源", exact: true });
  await sources.getByRole("checkbox", { name: "ClawHub", exact: true }).uncheck();
  await sources.getByRole("button", { name: "保存", exact: true }).click();
  await page.reload();
  await page.getByRole("combobox",{name:"市场来源",exact:true}).click();await expect(page.getByRole("option",{name:"ClawHub",exact:true})).toHaveCount(0);await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "管理来源", exact: true }).click();
  await sources.getByRole("checkbox", { name: "ClawHub", exact: true }).check();
  await sources.getByRole("button", { name: "保存", exact: true }).click();
  await chooseOption(page,page.getByRole("combobox",{name:"市场来源",exact:true}),"clawhub");
  await page.getByRole("button", { name: "查看详情 synthetic-claw", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "能力详情", exact: true });
  await expect(drawer.getByText("Synthetic ClawHub workflow", { exact: true }).first()).toBeVisible();
  await expect(drawer.getByRole("link", { name: "查看源目录" })).toHaveAttribute("href", "https://clawhub.ai/example/skills/synthetic-claw");
  await drawer.getByRole("button", { name: "安装", exact: true }).click();
  await drawer.getByRole("checkbox", { name: "智能体 · Market reader", exact: true }).check();
  await drawer.getByRole("button", { name: "安装并关联", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已安装并关联");
  expect((await (await request.get("/api/config")).json()).config.marketInstallations[0].catalogId).toBe("skill:clawhub/example/synthetic-claw");
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.route("**/api/market/search?*", route => route.abort());
  await page.getByRole("button", { name: "已安装", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "查看详情 synthetic-claw", exact: true }).click();
  await drawer.getByRole("button", { name: "解除关联 Market reader", exact: true }).click();
  await drawer.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已卸载");
});

test("source failures preserve other catalogs and the drawer restores keyboard focus", async ({ page }) => {
  await page.route("**/api/market/search?*source=clawhub*", route => route.fulfill({ status: 502, json: { error: "Market source HTTP 503" } }));
  await page.goto("/market");
  const card = page.getByRole("button", { name: "查看详情 synthetic-reading", exact: true });
  await expect(card).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ClawHub");
  await card.click();
  await expect(page.getByRole("dialog", { name: "能力详情", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("incompatible Skill metadata keeps real contents visible and blocks install with a clear reason", async ({ page }) => {
  await page.goto("/market?tab=browse");
  await chooseOption(page,page.getByRole("combobox",{name:"市场来源",exact:true}),"clawhub");
  await page.getByRole("searchbox", { name: "搜索市场" }).fill("synthetic-headerless");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "查看详情 synthetic-headerless", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("此 Skill 的 SKILL.md 缺少或不符合所需的 YAML 元数据（name、description），暂不能安装；仍可查看包内容。", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "安装", exact: true })).toBeDisabled();
  await drawer.getByRole("button", { name: "包内容", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "Synthetic headerless guide", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  await drawer.getByRole("button", { name: "概览", exact: true }).click();
  await expect(drawer.getByRole("link", { name: "查看源目录", exact: true })).toBeVisible();
});

test("source popularity is visible and sorting preserves unknown values, URL state and search scope", async ({ page }) => {
  await page.goto("/market?tab=browse&source=clawhub");
  await page.getByRole("searchbox", { name: "搜索市场" }).fill("popularity");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const cards = page.locator(".market-card");
  await expect(cards).toHaveCount(3);
  await chooseOption(page, page.getByRole("combobox", { name: "市场排序", exact: true }), "stars");
  await expect.poll(() => cards.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")))).toEqual(["查看详情 synthetic-popular", "查看详情 synthetic-claw", "查看详情 synthetic-no-stats"]);
  await expect(cards.first().getByLabel("星标 60", { exact: true })).toBeVisible();
  await expect(cards.last().locator(".market-popularity")).toHaveCount(0);
  await expect(page.getByText("仅对已加载结果排序；未提供统计的数据排在后面。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/sort=stars/);
  await chooseOption(page, page.getByRole("combobox", { name: "市场排序", exact: true }), "downloads");
  await expect(cards.first()).toHaveAttribute("aria-label", "查看详情 synthetic-claw");
  await cards.first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByLabel("评论 2", { exact: true })).toBeVisible();
  await expect(drawer.getByText("更新时间", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await chooseOption(page, page.getByRole("combobox", { name: "市场排序", exact: true }), "updated");
  await expect(cards.first()).toHaveAttribute("aria-label", "查看详情 synthetic-popular");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "市场排序", exact: true })).toHaveAttribute("data-value","updated");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
