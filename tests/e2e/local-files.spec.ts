import { expect, test } from "@playwright/test";

// These workflows start after an explicit CLI choice; first-use coverage keeps empty preferences.
test.beforeEach(async ({ page }) => {
 await page.addInitScript(() => localStorage.setItem('mana-chat-preferences', JSON.stringify({projectId:'',agentId:'',cli:'codex',model:'',effort:'',onboardingCompleted:true})));
});

test.beforeEach(async ({page}) => {
 await page.route('**/api/conversations/*/local-files/resolve', route => route.fulfill({json:{hrefs:route.request().postDataJSON().hrefs.filter((href:string)=>href==='/tmp/report.md')}}));
});

for (const english of [false, true]) {
  test(`opens a compact local file link, with copying inside the preview${english ? " in narrow English" : " in Chinese"}`, async ({ page, request, context }) => {
    const { revision } = await (await request.get("/api/config")).json();
    await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], agents: [], runtimes: ["codex"] } } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    if (english) {
      await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.route("**/api/conversations/*/local-file", route => route.fulfill({ json: { name: "report.md", path: "/tmp/report.md", text: "# Synthetic report\n\nReadable file content." } }));
    await page.goto("/?project=");
    await page.getByLabel(english ? "Message" : "消息", { exact: true }).fill("[查看说明](/tmp/report.md)");
    await page.getByRole("button", { name: english ? "Send message" : "发送消息", exact: true }).click();
    const link = page.locator(".message.text").getByRole("link", { name: "查看说明", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveText("查看说明");
    await link.click();
    const preview = page.locator("#chat-environment-panel");
    await expect(preview.getByRole("heading", { name: "Synthetic report", exact: true })).toBeVisible();
    await expect(preview).toContainText("Readable file content.");
    const id = new URL(page.url()).searchParams.get("conversation");
    await request.post(`/api/conversations/${id}/messages`, { data: { text: "hold" } });
    await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
    await expect(preview).toBeVisible();
    await request.post(`/api/conversations/${id}/stop`, { data: {} });
    await preview.getByRole("button", { name: english ? "Copy path" : "复制路径", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/tmp/report.md");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(preview).not.toBeVisible();
    await expect(link).toBeFocused();
    await page.route("**/api/conversations/*/local-file", route => route.fulfill({ status: 404, json: { error: "Local file is unavailable" } }));
    await link.click();
    await expect(preview.getByRole("alert").locator("p")).toHaveText(english ? "The local file is missing or unavailable." : "本地文件不存在或已不可用。");
    await preview.getByRole("button", { name: english ? "Collapse right sidebar" : "收起右侧栏", exact: true }).click();
    await expect(preview).not.toBeVisible();
  });
}
