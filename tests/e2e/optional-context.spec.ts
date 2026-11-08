import {pickDirectoryAgent, pickDirectoryProject} from './helpers/navigation';
import {openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { test, expect } from "./helpers/execution-fixture";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chooseOption } from "./helpers/select";

const fixture = (executionDirectory: string) => ({ version: 2, projects: [{ id: "personal", name: "Personal project", cwd: executionDirectory, agentIds: ["writer"], mcp: [], skills: [], resources: [],
  workspaces: [{ id: "notes", name: "Personal notes", cwd: join(executionDirectory, "notes"), resources: [] },
    { id: "drafts", name: "Personal drafts", cwd: join(executionDirectory, "drafts"), resources: [] }] }],
  agents: [{ id: "writer", name: "Personal writer", instructions: "Personal fixture only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
});

test.beforeEach(async ({ request, executionDirectory }) => {
  for (const name of ["notes", "drafts"]) mkdirSync(join(executionDirectory, name));
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: fixture(executionDirectory) } })).ok()).toBe(true);
});

for (const withAgent of [false, true]) for (const withWorkspace of [false, true]) {
  test(`optional Agent=${withAgent} Workspace=${withWorkspace} executes and survives reload`, async ({ page, request, executionDirectory }) => {
    await page.goto(`/?project=personal&agent=${withAgent ? "writer" : ""}&workspace=${withWorkspace ? "drafts" : ""}`);
    await page.getByLabel("消息", { exact: true }).fill(`Personal task ${withAgent} ${withWorkspace}`);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText(`Fixture reply: Personal task ${withAgent} ${withWorkspace}`, {exact:true})).toBeVisible();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    const id = new URL(page.url()).searchParams.get("conversation");
    const chat = (await (await request.get(`/api/conversations/${id}`)).json()).conversation;
    expect(chat).toMatchObject({ agentId: withAgent ? "writer" : "", workspaceId: withWorkspace ? "drafts" : null });
    if (withWorkspace) expect(chat.cwd).toBe(join(executionDirectory, "drafts"));
    else expect(chat.cwd).toBeUndefined();
    const row = page.locator(".library-item.active");
    await expect(row.locator(".library-item-heading strong")).toHaveText(`Personal task ${withAgent} ${withWorkspace}`);
    await expect(row.locator(".library-avatar-slot")).toBeVisible();
    await expect(row.locator('[data-identity-kind="agent"]')).toHaveCount(withAgent ? 1 : 0);
    await expect(row.locator(".library-context")).toContainText(withWorkspace ? "Personal drafts" : "无工作目录");
    await expect(row.locator('[data-project-marker="true"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".library-item.active .library-context")).toContainText(withWorkspace ? "Personal drafts" : "无工作目录");
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation).toMatchObject({ workspaceId: withWorkspace ? "drafts" : null, ...(withWorkspace ? { cwd: join(executionDirectory, "drafts") } : {}) });
    await page.goto("/projects/personal/workbench");
    const task = page.locator(".workbench-chat").filter({ hasText: `Personal task ${withAgent} ${withWorkspace}` });
    await expect(task).toContainText(withWorkspace ? "Personal drafts" : "无工作目录");
    await expect(task.locator('[data-identity-kind="agent"]')).toHaveCount(withAgent ? 1 : 0);
  });
}

test("opens a plain chat on an empty installation", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], agents: [] } } });
  await page.goto("/?project=&agent=");
  await expect(page.getByRole("button", { name: "配置项目与 Agent", exact: true })).toHaveCount(0);
  await page.getByLabel("消息", { exact: true }).fill("Discuss a personal reading plan");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const id = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation)
    .toMatchObject({ projectId: "", agentId: "", workspaceId: null });
});

test("can select an Agent without a Project and choose an independent directory", async ({ page, request, executionDirectory }) => {
  await page.goto("/?project=&agent=writer");
  await page.getByRole("button", { name: "选择工作目录（可选）", exact: true }).click();
  await page.getByRole("textbox", { name: "目录路径", exact: true }).fill(executionDirectory);
  await page.getByRole("button", { name: "前往", exact: true }).click();
  await page.getByRole("button", { name: "使用此文件夹", exact: true }).click();
  await page.getByLabel("消息", { exact: true }).fill("Work on a personal sample");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const id = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation)
    .toMatchObject({ projectId: "", agentId: "writer", cwd: executionDirectory, workspaceId: null });
});

test("selects, edits and adds independent Workspaces in Project settings", async ({ page, request, executionDirectory }) => {
  await page.goto("/settings/projects");await pickDirectoryProject(page);
  await openProjectBackground(page);
  await page.getByRole("tab", { name: "资源", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "当前目录组", exact: true });
  await chooseOption(page, picker, "drafts");
  await expect(page.getByLabel("主工作目录", { exact: true })).toHaveValue(join(executionDirectory, "drafts"));
  await page.getByLabel("目录组名称", { exact: true }).fill("Draft revision");
  await page.getByRole("button", { name: "添加目录组", exact: true }).click();
  await page.getByLabel("目录组名称", { exact: true }).fill("Third personal environment");
  await page.getByLabel("主工作目录", { exact: true }).fill(executionDirectory);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects[0].workspaces.map((w: any) => w.name))
    .toEqual(["Personal notes", "Draft revision", "Third personal environment"]);
  const { config } = await (await request.get("/api/config")).json();
  expect(config.projects[0].workspaces.map((w: any) => w.name)).toEqual(["Personal notes", "Draft revision", "Third personal environment"]);
  await page.goto("/?project=personal&agent=writer");
  await chooseOption(page, page.getByRole("combobox", { name: "当前目录组", exact: true }), "drafts");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "当前目录组", exact: true })).toContainText("Draft revision");
});
