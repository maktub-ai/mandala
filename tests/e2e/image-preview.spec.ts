import { expect, test } from "@playwright/test";

for (const english of [false, true]) {
  test(`previews draft and persisted images${english ? " on a narrow English screen" : " in Chinese"}`, async ({ page, request }) => {
    const { revision } = await (await request.get("/api/config")).json();
    await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], agents: [], runtimes: ["codex"] } } });
    if (english) {
      await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.goto("/?project=");
    const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=", "base64");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "sample.png", mimeType: "image/png", buffer },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic notes") },
    ]);
    const draft = page.locator(".composer-attachments");
    await expect(draft.getByRole("img", { name: "sample.png", exact: true })).toBeVisible();
    await expect.poll(() => draft.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const previewName = english ? "Preview image sample.png" : "预览图片 sample.png";
    const dialogName = english ? "Image preview" : "图片预览";
    await draft.getByRole("button", { name: previewName, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
    await expect(dialog.getByRole("img", { name: "sample.png", exact: true })).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(english ? 390 : 1280);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(draft.getByRole("button", { name: previewName, exact: true })).toBeFocused();
    await draft.getByRole("button", { name: english ? "Remove attachment notes.txt" : "移除附件 notes.txt", exact: true }).click();
    await page.getByRole("textbox", { name: english ? "Message" : "消息", exact: true }).fill("Image preview fixture");
    await page.getByRole("button", { name: english ? "Send message" : "发送消息", exact: true }).click();
    await expect(page.getByText("Fixture reply: Image preview fixture", { exact: true })).toBeVisible();
    await expect(page.locator(".turn-process-toggle svg.lucide-check")).toHaveCount(0);
    await page.reload();
    const sent = page.locator(".message.user .message-attachments");
    await expect.poll(() => sent.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await sent.getByRole("button", { name: previewName, exact: true }).click();
    const reader = page.locator("#chat-environment-panel");
    await expect(reader.getByRole("img", { name: "sample.png", exact: true })).toBeVisible();
    await reader.getByRole("button", { name: english ? "Actual size" : "查看原尺寸", exact: true }).click();
    await expect(reader.getByRole("button", { name: english ? "Fit to width" : "适应宽度", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await reader.locator(".content-image img").evaluate(el=>getComputedStyle(el).maxWidth)).toBe("none");
    await reader.getByRole("button", { name: english ? "Collapse right sidebar" : "收起右侧栏", exact: true }).click();
    await expect(reader).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const sourceId = new URL(page.url()).searchParams.get("conversation");
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).not.toBe(sourceId);
    await expect.poll(() => sent.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await sent.getByRole("button", { name: previewName, exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("image-preview.png") });
  });
}
