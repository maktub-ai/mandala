import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const { config, revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { ...config,
    projects: [...config.projects.filter((project: {id:string})=>project.id!=="observe"), { id: "observe", name: "Observation test", cwd: "", agentIds: ["observer"], resources: [], mcp: [], skills: [] }],
    agents: [...config.agents.filter((agent: {id:string})=>agent.id!=="observer"), { id: "observer", name: "Observer", instructions: "Synthetic test only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
  } } });
});

test("keeps the answer clear and provides live status, parallel timeline and replay", async ({ page }, testInfo) => {
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("消息", { exact: true }).fill("observed-flow");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const process = page.locator(".turn-process");
  await expect(process).toContainText("正在执行的操作");
  await expect(process.locator(".explicit-progress")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("live-progress-desktop.png") });
  await expect(page.locator(".agent-reply .message-avatar")).toHaveCount(1);
  await expect(page.locator(".agent-reply .turn-process")).toHaveCount(1);
  await expect(process.locator(".operation-card")).toHaveCount(0);
  await expect(process.locator(".run-commentary")).toHaveCount(0);
  await process.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await expect(process.getByText("Checking both resources", { exact: true })).toBeVisible();
  await expect(page.getByText("Both resources are ready.", { exact: true })).toBeVisible();
  await process.locator('.run-reasoning-group > summary').click();
  await expect(process.locator(".operation-card")).toHaveCount(2);
  await expect(page.locator(".message.text")).toHaveCount(2);
  await expect(page.locator(".agent-reply .message-avatar")).toHaveCount(1);
  await expect(page.locator(".turn-process .run-overview-button")).toHaveCount(0);
  await expect(process.getByRole("button", { name: "收起本轮过程", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.locator(".turn-footer").getByRole("button", { name: "查看执行总览", exact: true }).click();
  const overview = page.getByRole("dialog", { name: "执行总览", exact: true });
  await expect(overview.locator(".run-metrics div").filter({ hasText: "峰值并行操作" }).locator("dd")).toHaveText("2");
  await expect(overview.locator(".run-timeline li")).toHaveCount(2);
  await expect(overview).toContainText("原生报告");
  await overview.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const drawer = (await overview.boundingBox())!;
  expect(drawer.x).toBeGreaterThanOrEqual(0);
  expect(drawer.x + drawer.width).toBeCloseTo(1280, 0);
  expect(drawer.y).toBeCloseTo(0, 0);
  await page.screenshot({ path: testInfo.outputPath("observability-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(overview).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".message.text")).toHaveCount(2);
  await expect(page.locator(".operation-card")).toHaveCount(0);
  await page.locator(".turn-footer").getByRole("button", { name: "查看执行总览", exact: true }).click();
  await expect(overview.locator(".run-metrics div").filter({ hasText: "峰值并行操作" }).locator("dd")).toHaveText("2");
});

test("keeps interrupted output discoverable and the overview usable on a narrow English screen", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("Message", { exact: true }).fill("live-tool-flow");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Expand this turn's activity", exact: true }).click();
  await expect(page.locator(".operation-preview")).toContainText("reading 1/3");
  await page.screenshot({ path: testInfo.outputPath("live-progress-mobile.png") });
  await page.getByRole("button", { name: "Stop execution", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Interrupted");
  await expect(page.locator(".message.text")).toHaveCount(0);
  await expect(page.getByText("Checking the sample", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View execution overview", exact: true }).click();
  const overview = page.getByRole("dialog", { name: "Execution overview", exact: true });
  await expect(overview).toContainText("Interrupted");
  expect((await overview.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("observability-mobile.png") });
  await overview.getByRole("button", { name: "Close execution overview", exact: true }).click();
});

test("keeps 300 operation logs unmounted until inspected", async ({ page }) => {
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("消息", { exact: true }).fill("observed-many");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("300 operations completed.", { exact: true })).toBeVisible({timeout:15000});
  await expect(page.locator(".operation-card")).toHaveCount(0);
  await page.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await expect(page.locator(".operation-card")).toHaveCount(300);
  await expect(page.locator(".operation-content")).toHaveCount(0);
  await page.locator(".operation-card").first().locator(":scope > summary").click();
  await expect(page.locator(".operation-content")).toHaveCount(1);
  await expect(page.locator(".operation-output")).toContainText("Synthetic output 299");
  await page.locator(".operation-card").first().locator(":scope > summary").click();
  await expect(page.locator(".operation-content")).toHaveCount(0);
});

test("keeps approval actionable outside the fold and records its wait in the overview", async ({ page }) => {
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("消息", { exact: true }).fill("approval");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".approval-card")).toBeVisible();
  await expect(page.locator(".turn-process-status")).toHaveText("等待审批");
  await expect(page.getByRole("button", { name: "展开本轮过程", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", {name:"查看执行总览",exact:true})).toHaveCount(0);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.locator(".turn-footer").getByRole("button", { name: "查看执行总览", exact: true }).click();
  const overview = page.getByRole("dialog", { name: "执行总览", exact: true });
  const wait = overview.locator(".run-metrics div").filter({ hasText: "等待审批耗时" }).locator("dd");
  await expect(wait).not.toHaveText("0 ms");

});

test("preserves inspection scroll while a reply streams and resumes following on request", async ({ page }) => {
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("消息", { exact: true }).fill("stream-reading");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message.text")).toContainText("阅读资料 40");
  await page.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await page.getByRole("button", { name: "收起本轮过程", exact: true }).click();
  const conversation = page.locator(".conversation");
  await conversation.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(page.locator(".message.text")).toContainText("更新 5");
  expect(await conversation.evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
  await expect.poll(() => conversation.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
});


test("hides dot-only tool preambles in progress while retaining useful updates, tools and history", async ({page}) => {
  await page.goto("/?project=observe&agent=observer");
  await page.getByLabel("消息",{exact:true}).fill("placeholder-progress");
  await page.getByRole("button",{name:"发送消息",exact:true}).click();
  await expect(page.getByText("Synthetic setting verified.",{exact:true})).toBeVisible();
  for (let replay = 0; replay < 2; replay++) {
    await page.getByRole("button",{name:"展开本轮过程",exact:true}).click();
    await expect(page.locator(".run-process-timeline .markdown-text p")).toHaveText(["Synthetic setting located."]);
    await expect(page.locator(".operation-card")).toHaveCount(7);
    await expect(page.getByText("Synthetic setting verified.",{exact:true})).toBeVisible();
    if (!replay) await page.reload();
  }
});
