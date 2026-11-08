import { test, expect, type APIRequestContext } from "@playwright/test";
import { openArea, pickDirectoryAgent } from "./helpers/navigation";
import { chooseOption, expectSelection } from "./helpers/select";
import { waitForAutosave } from "./helpers/settings";

async function seed(request: APIRequestContext) {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], runtimes: ["codex"], system: { cli: "codex", memoryCapture: false, skillLearning: false },
    agents: [{ id: "style-agent", name: "Style agent", instructions: "Use synthetic examples", defaultCli: "codex", models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
}
async function nativeStyle(request: APIRequestContext, id: string) {
  return (await (await request.get(`/__test__/response-instructions?conversationId=${id}`)).json()).instructions as string;
}
async function run(request: APIRequestContext, id: string, style: string) {
  expect((await request.post(`/api/conversations/${id}/messages`, { data: { text: "Synthetic response style check" } })).ok()).toBe(true);
  await expect.poll(() => nativeStyle(request, id)).toContain(`Response style: ${style}`);
  await expect.poll(async () => (await (await request.get("/api/conversations")).json()).find((chat: { id: string }) => chat.id === id)?.status).toBe("idle");
}

test("RS1 current settings entry persists global and Agent preferences and updates the next native execution", async ({ page, request }) => {
  await seed(request); await page.goto("/"); await openArea(page, "设置");
  const global = page.getByRole("combobox", { name: "默认回答风格", exact: true });
  await expectSelection(global, "standard"); await chooseOption(page, global, "concise"); await waitForAutosave(page);
  await page.reload(); await expectSelection(global, "concise");
  const chat = await (await request.post("/api/conversations", { data: { projectId: "", agentId: "style-agent", cli: "codex" } })).json();
  await run(request, chat.id, "concise");
  await openArea(page, "团队"); await pickDirectoryAgent(page, "style-agent");
  const agent = page.getByRole("combobox", { name: /^(Agent|智能体) 回答风格$/, exact: true });
  await expect(agent).toContainText("继承全局（简洁）"); await chooseOption(page, agent, "standard"); await waitForAutosave(page);
  await page.reload(); await expectSelection(agent, "standard"); await run(request, chat.id, "standard");
  await chooseOption(page, agent, ""); await waitForAutosave(page);
  expect((await (await request.get("/api/config")).json()).config.agents[0]).not.toHaveProperty("responseStyle");
  await openArea(page, "设置"); await chooseOption(page, global, "explanatory"); await waitForAutosave(page);
  await openArea(page, "团队"); await pickDirectoryAgent(page, "style-agent");
  await expect(agent).toContainText("继承全局（解释型）"); await page.reload(); await expect(agent).toContainText("继承全局（解释型）");
  await run(request, chat.id, "explanatory");
});

test("RS2 failed autosave retains the response style draft and retry persists it", async ({ page, request }) => {
  await seed(request); await page.goto("/settings/general"); let fail = true;
  await page.route("**/api/config", async route => {
    if (route.request().method() === "PUT" && fail) { await route.fulfill({ status: 503, json: { error: "Synthetic save failure" } }); return; }
    await route.continue();
  });
  const picker = page.getByRole("combobox", { name: "默认回答风格", exact: true });
  await chooseOption(page, picker, "explanatory"); await expect(page.getByRole("button", { name: "重试自动保存", exact: true })).toBeVisible();
  await expectSelection(picker, "explanatory"); expect((await (await request.get("/api/config")).json()).config.responseStyle).toBeUndefined();
  fail = false; await page.getByRole("button", { name: "重试自动保存", exact: true }).click();
  await waitForAutosave(page); await page.reload(); await expectSelection(picker, "explanatory");
});

for (const [width, language, theme] of [[1280, "zh-CN", "light"], [390, "en", "dark"]] as const) {
  test(`RS3 current theme and response controls at ${width}px ${language} ${theme}`, async ({ page, request }, info) => {
    await seed(request); await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(value => localStorage.setItem("mana-language", value), language);
    await page.goto("/settings/general");
    await page.getByRole("button", { name: language === "en" ? "Dark" : "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const picker = page.getByRole("combobox", { name: language === "en" ? "Default response style" : "默认回答风格", exact: true });
    await picker.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("End"); await page.keyboard.press("Enter"); await expectSelection(picker, "explanatory"); await waitForAutosave(page);
    await expect(picker).toBeFocused(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await picker.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("response-style-general.png") });
    await openArea(page, "团队"); await pickDirectoryAgent(page, "style-agent");
    const agent = page.getByRole("combobox", { name: language === "en" ? "Agent response style" : /^(Agent|智能体) 回答风格$/, exact: true });
    await agent.click(); await expect(page.getByRole("listbox")).toBeVisible(); await page.screenshot({ path: info.outputPath("response-style-agent-menu.png") });
    await page.keyboard.press("Escape"); await expect(agent).toBeFocused();
  });
}
