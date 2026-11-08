import { test, expect } from "@playwright/test";

for (const [width, language] of [[1280, "zh-CN"], [390, "zh-CN"], [1280, "en"]] as const) {
  test(`quiet chat header supports direct title editing and configuration at ${width}px in ${language}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(value => localStorage.setItem("mana-language", value), language);
    const { revision } = await (await request.get("/api/config")).json();
    await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], agents: [] } } });
    const chat = await (await request.post("/api/conversations", { data: { projectId: "", agentId: "", cli: "codex" } })).json();
    await page.goto(`/?project=&conversation=${chat.id}`);
    const header = page.locator(".chat-title-bar");
    const title = header.getByRole("button", { name: language === "en" ? "Rename chat" : "重命名对话", exact: true });
    await expect(title).toHaveText(chat.title || (language === "en" ? "New chat" : "新对话"));
    await title.click();
    const input = page.getByRole("textbox", { name: language === "en" ? "Chat title" : "对话标题", exact: true });
    await expect(input).toBeFocused();
    await input.fill("A quieter reading session");
    await input.press("Enter");
    await expect(title).toHaveText("A quieter reading session");
    await page.reload();
    await expect(title).toHaveText("A quieter reading session");
    await title.focus();
    await page.keyboard.press("Enter");
    await input.fill("Cancelled title");
    await input.press("Escape");
    await expect(title).toHaveText("A quieter reading session");
    await expect(header.getByRole("button")).toHaveCount(2);
    await expect(header.getByRole('button',{name:language==='en'?'Fork conversation':'Fork 对话',exact:true})).toBeVisible();
    const sidebar = page.getByRole("button", {name:language === "en" ? "Expand right sidebar" : "展开右侧栏",exact:true});
    await sidebar.focus();
    await page.keyboard.press("Enter");
    const panel=page.locator('#chat-environment-panel');
    await panel.getByRole('tab',{name:language==='en'?'Capabilities':'能力',exact:true}).click();
    await expect(panel).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('quiet-header.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
