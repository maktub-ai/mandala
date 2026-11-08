import {chooseOption} from "./helpers/select";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
});

test("stalled catalog expires, retry is independent and source management remains usable", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/market/search?*source=clawhub*", () => new Promise(() => {}));
  let attempts = 0;
  await page.route("**/api/market/search?*source=anthropic*", route => ++attempts === 1
    ? route.fulfill({ status: 502, json: { error: "Market source HTTP 503" } }) : route.continue());
  await page.goto("/market");
  const retry = page.getByRole("button", { name: "Retry Anthropic", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("button", { name: "View details synthetic-reading", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage sources", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Manage sources", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.fastForward(31_000);
  await expect(page.getByRole("button", { name: "Retry ClawHub", exact: true })).toBeEnabled();
  await expect(page.locator(".market-results")).toHaveAttribute("aria-busy", "false");
});

test("source preference read times out with recovery instead of a perpetual skeleton", async ({ page }) => {
  await page.clock.install();
  let attempts = 0;
  await page.route("**/api/market/sources", route => ++attempts === 1 ? new Promise(() => {}) : route.continue());
  await page.goto("/market");
  await expect.poll(() => attempts).toBe(1);
  await page.clock.fastForward(31_000);
  await expect(page.getByRole("button", { name: "Retry sources", exact: true })).toBeVisible();
  await expect(page.locator(".ui-loading")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry sources", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage sources", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "View details synthetic-claw", exact: true })).toBeVisible();
});

test("changing source aborts obsolete reads and closing details aborts its read", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    (window as any).marketAborts = [];
    window.fetch = (input, init) => {
      const url = String(input);
      init?.signal?.addEventListener("abort", () => (window as any).marketAborts.push(url));
      return original(input, init);
    };
  });
  await page.route("**/api/market/search?*source=clawhub*", () => new Promise(() => {}));
  await page.goto("/market");
  await expect(page.getByRole("button", { name: "View details synthetic-reading", exact: true })).toBeVisible();
  await chooseOption(page,page.getByRole("combobox",{name:"Market sources",exact:true}),"anthropic");
  await expect.poll(() => page.evaluate(() => (window as any).marketAborts.some((url: string) => url.includes("source=clawhub")))).toBe(true);
  await page.route("**/api/market/detail?*", () => new Promise(() => {}));
  await page.getByRole("button", { name: "View details synthetic-reading", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Capability details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).marketAborts.some((url: string) => url.includes("/market/detail?")))).toBe(true);
});

test("synthetic directory, partial failure, empty and source editor render in light, dark and narrow layouts", async ({ page }) => {
  const output = "/tmp/compact-market-reliability";
  for (const [theme, width, height] of [["light", 1280, 850], ["dark", 1280, 850], ["light", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem("mana-theme", theme), theme);
    await page.goto("/market");
    await expect(page.locator(".market-card")).toHaveCount(5);
    await expect(page.locator(".market-results")).toHaveAttribute("aria-busy", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/directory-${theme}-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Manage sources", exact: true }).click();
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.getByRole("textbox", { name: "Source name", exact: true }).fill("Synthetic research repository");
    await page.getByRole("textbox", { name: "Repository URL", exact: true }).fill("https://github.com/example/research-skills");
    await page.screenshot({ path: `${output}/sources-${theme}-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.route("**/api/market/search?*source=clawhub*", route => route.fulfill({ status: 502, json: { error: "Market source HTTP 503" } }));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry ClawHub", exact: true })).toBeVisible();
    await expect(page.locator(".market-results")).toHaveAttribute("aria-busy", "false");
    await page.screenshot({ path: `${output}/partial-${theme}-${width}.png`, fullPage: true });
    await page.unroute("**/api/market/search?*source=clawhub*");
    await page.getByRole("searchbox", { name: "Search market", exact: true }).fill("no-such-skill");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("No matching results.", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${output}/empty-${theme}-${width}.png`, fullPage: true });
  }
});

test("failed installed data has an independent recovery without blocking catalogs or source management", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/market/installed", route => ++attempts === 1 ? route.fulfill({ status: 503, json: { error: "Local installation data unavailable" } }) : route.continue());
  await page.goto("/market");
  await expect(page.locator(".market-card")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Manage sources", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Installed", exact: true }).click();
  await expect(page.getByText("No market capabilities installed.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry installed capabilities", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry installed capabilities", exact: true })).toHaveCount(0);
  await expect(page.locator(".market-empty")).toBeVisible();
});
