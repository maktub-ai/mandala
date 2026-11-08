import type { APIRequestContext, Page } from "@playwright/test";
import type { Project, Workspace } from "../../shared/types";
import { test, expect } from "./helpers/execution-fixture";

async function fixture(request: APIRequestContext, directory: string) {
  const project: Project = { id: "clone-project", name: "Clone project", cwd: directory, agentIds: [], resources: [], mcp: [], skills: [],
    workspaces: [{ id: "existing", name: "Existing workspace", cwd: directory, resources: [{ id: "notes", label: "Notes", kind: "local", location: directory }] }] };
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [project, { ...project, id: "other-project", name: "Other project" }], agents: [] } } })).ok()).toBe(true);
  return project;
}

async function openClone(page: Page, id = "clone-project") {
  await page.goto(`/projects/manage?project=${id}&tab=resources`);
  await page.getByRole("button", { name: "从仓库克隆", exact: true }).click();
  await page.getByLabel("远程仓库 URL", { exact: true }).fill("https://example.com/team/repository.git");
}

async function savedProject(request: APIRequestContext, id = "clone-project"): Promise<Project> {
  return (await (await request.get("/api/config")).json()).config.projects.find((project: Project) => project.id === id);
}

test("clone appends a workspace after success and preserves edits made while waiting", async ({ page, request, executionDirectory }) => {
  const original = await fixture(request, executionDirectory);
  const workspace: Workspace = { id: "cloned", name: "repository", cwd: executionDirectory, resources: [] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/projects/clone-project/workspaces/clone", async route => {
    expect(route.request().postDataJSON()).toEqual({ url: "https://example.com/team/repository.git" });
    started(); await held; await route.fulfill({ json: { workspace } });
  });
  await openClone(page);
  const before = await savedProject(request);
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await pending;
  try {
    await expect(page.getByRole("button", { name: "克隆中…", exact: true })).toBeDisabled();
    expect(await savedProject(request)).toEqual(before);
    await page.getByLabel("目录组名称", { exact: true }).fill("Edited while cloning");
  } finally { release(); }
  await expect(page.getByLabel("目录组名称", { exact: true })).toHaveValue(workspace.name);
  await expect.poll(async () => (await savedProject(request)).workspaces).toEqual([
    { ...original.workspaces![0], name: "Edited while cloning" }, workspace,
  ]);
  expect((await savedProject(request)).cwd).toBe(original.cwd);
});

test("clone can become the default without removing existing directories", async ({ page, request, executionDirectory }) => {
  const original = await fixture(request, executionDirectory);
  const workspace: Workspace = { id: "cloned-default", name: "repository", cwd: executionDirectory, resources: [] };
  await page.route("**/api/projects/*/workspaces/clone", route => route.fulfill({ json: { workspace } }));
  await openClone(page);
  await page.getByRole("checkbox", { name: "设为默认目录组", exact: true }).check();
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await expect.poll(async () => (await savedProject(request)).workspaces).toEqual([workspace, ...original.workspaces!]);
  expect((await savedProject(request)).resources).toEqual([]);
});

for (const name of ["Default", "My empty workspace"]) test(`clone preserves materialized default workspaces (${name})`, async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  const { config, revision } = await (await request.get("/api/config")).json();
  const project = config.projects.find((item: Project) => item.id === "clone-project");
  project.cwd = ""; project.resources = [];
  project.workspaces = [{ id: "default", name, cwd: "", resources: [] }];
  expect((await request.put("/api/config", { data: { revision, config } })).ok()).toBe(true);
  const original = await savedProject(request);
  expect(original.workspaces![0].cwd).toBeTruthy();
  const workspace: Workspace = { id: "empty-cloned", name: "repository", cwd: executionDirectory, resources: [] };
  await page.route("**/api/projects/*/workspaces/clone", route => route.fulfill({ json: { workspace } }));
  await openClone(page);
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await expect.poll(async () => (await savedProject(request)).workspaces).toEqual([...original.workspaces!, workspace]);
  expect((await savedProject(request)).workspaces![0].name).toBe(name);
});

test("failed clone preserves URL for retry and does not save project changes", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  let attempts = 0;
  await page.route("**/api/projects/*/workspaces/clone", route => ++attempts === 1
    ? route.fulfill({ status: 400, json: { error: "Repository is unavailable" } })
    : route.fulfill({ json: { workspace: { id: "retry-clone", name: "repository", cwd: executionDirectory, resources: [] } } }));
  await openClone(page);
  const before = await savedProject(request);
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Repository is unavailable");
  await expect(page.getByLabel("远程仓库 URL", { exact: true })).toHaveValue("https://example.com/team/repository.git");
  expect(await savedProject(request)).toEqual(before);
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await expect.poll(async () => (await savedProject(request)).workspaces?.map(workspace => workspace.id)).toEqual(["existing", "retry-clone"]);
});

test("a clone finishing after project navigation cannot modify either project", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/projects/*/workspaces/clone", async route => {
    started(); await held;
    await route.fulfill({ json: { workspace: { id: "late-clone", name: "repository", cwd: executionDirectory, resources: [] } } });
  });
  await openClone(page);
  const before = await (await request.get("/api/config")).json();
  await page.getByRole("button", { name: "克隆仓库", exact: true }).click();
  await pending;
  try {
    await page.evaluate(() => {
      history.pushState(null, "", "/projects/manage?project=other-project&tab=resources");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator(".settings-detail")).toContainText("Existing workspace");
    await expect(page.getByRole("form", { name: "克隆仓库", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "从仓库克隆", exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByLabel("目录组名称", { exact: true })).toHaveValue("Existing workspace");
  expect(await (await request.get("/api/config")).json()).toEqual(before);
});
