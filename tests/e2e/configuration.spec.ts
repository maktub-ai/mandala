import { openProjectOverview } from './helpers/navigation';
import { openArea, openProject } from "./helpers/navigation";
import { chooseOption, expectSelection } from "./helpers/select";
import { test, expect } from "./helpers/execution-fixture";

test("links project agents and explains capability sources in both CLI contexts", async ({ request, page }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const config = {
    version: 2,
    projects: [
      { id: "p1", name: "Synthetic codebase", cwd: "/tmp", agentIds: ["a1", "a3"],
        resources: [{ id: "local", label: "Shared fixtures", kind: "local", location: "/tmp" },
          { id: "remote", label: "Remote source", kind: "remote-git", location: "https://example.test/repo.git" }],
        mcp: [{ name: "mana-shared-synthetic", transport: "stdio", command: "node", args: ["project.js"] }],
        skills: [{ name: "mana-review-synthetic", path: "/tmp/project-review" }] },
      { id: "p2", name: "Synthetic operations", cwd: "/tmp", agentIds: ["a2", "a3"],
        resources: [{ id: "missing", label: "Missing local", kind: "local", location: "/tmp/openmana-missing-synthetic-directory" }], mcp: [], skills: [] },
    ],
    agents: [
      { id: "a1", name: "Builder", instructions: "Build", defaultCli: "codex", models: {},
        mcp: [{ name: "mana-shared-synthetic", transport: "stdio", command: "node", args: ["agent.js"] }],
        skills: [{ name: "mana-review-synthetic", path: "/tmp/agent-review" }] },
      { id: "a2", name: "Reviewer", instructions: "Review", defaultCli: "omp", models: {}, mcp: [], skills: [] },
      { id: "a3", name: "Generalist", instructions: "Help both projects", defaultCli: "codex", models: {}, mcp: [], skills: [] },
    ],
  };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  const effective = await (await request.get("/api/effective?projectId=p1&agentId=a1&cli=codex")).json();
  expect(effective.mcp.find((item: { name: string }) => item.name === "mana-shared-synthetic"))
    .toMatchObject({ source: "project", overridden: ["agent"], status: "unverified" });
  expect(effective.skills.find((item: { name: string }) => item.name === "mana-review-synthetic"))
    .toMatchObject({ source: "project", overridden: ["agent"], status: "unverified" });
  expect(effective.resources.map((item: { access: string }) => item.access))
    .toEqual(["not-granted", "not-checked-out"]);
  const ompView = await (await request.get("/api/effective?projectId=p2&agentId=a2&cli=omp")).json();
  expect(ompView.resources[0].access).toBe("missing");
  await page.goto("/?project=&agent=");
  await chooseOption(page, page.getByRole("combobox", { name: "当前项目" }), "p2");
  await page.getByRole("combobox", { name: "当前 智能体" }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(3);
  await expect(page.getByRole("option", { name: "不使用 智能体", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Reviewer", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Generalist", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await chooseOption(page, page.getByRole("combobox", { name: "当前 智能体" }), "a2");
  await expectSelection(page.getByRole("combobox", { name: "当前 CLI" }), "omp");
  await openProject(page, "p2");
  await openProjectOverview(page);
  await expect(page).toHaveURL(/\/projects\/p2\/workbench$/);
  await expect(page.getByRole("heading", { name: "项目", level: 1, exact: true })).toBeVisible();
  await expect(page.locator("main .project-context")).toHaveText("Synthetic operations");
  await expect(page.getByRole("dialog", { name: "项目", exact: true })).toHaveCount(0);
});

test("delegates to a separate chat and returns the receipt to the source", async ({ request, page, executionDirectory }) => {
  const { config: existing, revision } = await (await request.get("/api/config")).json();
  const config = { ...existing,
    projects: [...existing.projects,{ id: "p", name: "Synthetic handoff", cwd: executionDirectory, agentIds: ["a", "b"], resources: [], mcp: [], skills: [] }],
    agents: [...existing.agents.filter((agent:{id:string})=>!["a","b"].includes(agent.id)), ...["a", "b"].map((id) => ({ id, name: id, instructions: "Synthetic agent", defaultCli: "codex", models: {}, mcp: [], skills: [] }))] };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  const source = await (await request.post("/api/conversations", { data: { projectId: "p", agentId: "a" } })).json();
  await request.post(`/api/conversations/${source.id}/messages`, { data: { text: "Prepare a review" } });
  await page.goto(`/?project=p&conversation=${source.id}`);
  await expect(page.getByText("Fixture reply: Prepare a review", { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/conversations/${source.id}`)).json()).conversation.status)
    .toBe("idle");
  await page.goto(`/?project=p&conversation=${source.id}`);
  await expect(page.locator(".task-card")).toHaveCount(0);
  const task = await (await request.post("/api/tasks", { data: { sourceConversationId: source.id,
    targetAgentId: "b", request: "Review this synthetic change", policy: "resume" } })).json();
  expect(task.targetConversationId).not.toBe(source.id);
  const childDetail = () => request.get(`/api/v2/tasks/${task.id}`).then(response => response.json());
  await expect.poll(async () => {const detail=await childDetail();return {state:detail.task.state,runs:detail.runs.map((run:{state:string})=>run.state),receipt:detail.receipts[0]?.deliveryState};}).toMatchObject({receipt:"consumed"});
  await expect.poll(async () => (await childDetail()).runs.filter((run:{state:string})=>run.state==="succeeded").length).toBe(2);
  const child = await childDetail();
  expect(child.task).toMatchObject({ state: "review", completion: null, goal: "Prepare a review", originConversationId: source.id });
  expect(child.task.originConversationId).toBe(source.id);
  expect(child.task.conversationIds).toEqual(expect.arrayContaining([source.id,task.targetConversationId]));
  expect(child.executions.map((execution:{conversationId:string})=>execution.conversationId)).toContain(task.targetConversationId);
  expect(child.runs[0]).toMatchObject({ state: "succeeded", routing: { executionConversationId: task.targetConversationId, destinationConversationId: source.id, mode: "dedicated" } });
  expect(child.receipts).toHaveLength(1);
  expect(child.receipts[0]).toMatchObject({ policy: "resume", deliveryState: "consumed", destinationConversationId: source.id, sourceRunId: child.runs[0].id, summary: "Fixture reply: Review this synthetic change" });
  expect(child.executions).toHaveLength(2);
  const resumed=child.runs.find((run:{routing:{executionConversationId:string}})=>run.routing.executionConversationId===source.id);
  expect(resumed).toMatchObject({state:'succeeded',routing:{mode:'existing'}});
  expect(child.receipts[0].claimedByRunId).toBe(resumed.id);
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
  const linkedTask=page.locator('#chat-environment-panel a[href="/tasks/'+task.id+'"]');await expect(linkedTask).toContainText('Prepare a review');await expect(page.locator('.conversation-tasks')).toHaveCount(0);
  await linkedTask.click();await expect(page.locator('.task-deliveries')).toContainText('Fixture reply: Review this synthetic change');await page.goBack();
  await expect(page.locator(".handoff-input")).toHaveCount(1);
  await expect(page.locator(".handoff-input summary")).toContainText("帮手结果");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "编辑消息", exact: true })).toHaveCount(1);
  await page.locator(".handoff-input summary").click();
  await expect(page.locator(".handoff-input")).toContainText("Prepare a review");
  await expect(page.locator(".handoff-input")).toContainText("Task receipts (data):");
  await expect(page.locator(".handoff-input")).toContainText(child.receipts[0].id);
  await expect(page.locator(".handoff-input")).toContainText("Fixture reply: Review this synthetic change");
  await page.reload();
  await expect(page.locator('.conversation-tasks')).toHaveCount(0);await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();await expect(linkedTask).toBeVisible();
  expect((await childDetail()).receipts[0].deliveryState).toBe("consumed");
  await expect(page.locator(".handoff-input")).toHaveCount(1);
  await expect(page.locator(".message.user")).toHaveCount(1);
});

test("a stopped source keeps the successful Run's receipt waiting for explicit continuation",async({request,page})=>{
  const {config:existing,revision}=await(await request.get("/api/config")).json();
  const config={...existing,projects:[...existing.projects,{id:"paused",name:"Synthetic paused handoff",cwd:"/tmp",agentIds:["a","b"],resources:[],mcp:[],skills:[]}],
    agents:[...existing.agents.filter((agent:{id:string})=>!["a","b"].includes(agent.id)),...["a","b"].map(id=>({id,name:id,instructions:"Synthetic only",defaultCli:"codex",models:{},mcp:[],skills:[]}))]};
  expect((await request.put("/api/config",{data:{revision,config}})).ok()).toBe(true);
  const source=await(await request.post("/api/conversations",{data:{projectId:"paused",agentId:"a",workspaceId:null}})).json();
  await request.post(`/api/conversations/${source.id}/messages`,{data:{text:"hold"}});
  expect((await request.post(`/api/conversations/${source.id}/stop`,{data:{}})).ok()).toBe(true);
  expect((await(await request.get(`/api/conversations/${source.id}`)).json()).conversation.status).toBe("interrupted");
  const delegated=await(await request.post("/api/tasks",{data:{sourceConversationId:source.id,targetAgentId:"b",request:"Review a synthetic change",policy:"resume"}})).json();
  const childDetail=()=>request.get(`/api/v2/tasks/${delegated.id}`).then(response=>response.json());
  await expect.poll(async()=>(await childDetail()).runs[0]?.state).toBe("succeeded");
  const child=await childDetail();
  expect(child.task).toMatchObject({state:"review",completion:null,originConversationId:source.id});
  expect((await request.post(`/api/v2/tasks/${delegated.id}`+'/executions',{headers:{'Idempotency-Key':'link-source-'+delegated.id},data:{expectedRevision:child.task.revision,conversationId:source.id}})).ok()).toBe(true);
  expect(child.runs).toHaveLength(1);
  expect(child.runs[0]).toMatchObject({state:"succeeded",routing:{executionConversationId:delegated.targetConversationId,destinationConversationId:source.id,mode:"dedicated"}});
  expect(child.receipts).toHaveLength(1);
  expect(child.receipts[0]).toMatchObject({policy:"resume",destinationConversationId:source.id,sourceRunId:child.runs[0].id,summary:"Fixture reply: Review a synthetic change",claimedByRunId:null});
  expect(child.executions).toHaveLength(1);
  expect((await(await request.get(`/api/conversations/${source.id}`)).json()).conversation.status).toBe("interrupted");
  await page.goto(`/?project=paused&conversation=${source.id}`);
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
  const linkedTask=page.locator('#chat-environment-panel a[href="/tasks/'+delegated.id+'"]');await expect(linkedTask).toBeVisible();await expect(page.locator('.conversation-tasks')).toHaveCount(0);
  await linkedTask.click();await expect(page.locator('.task-deliveries')).toContainText('Fixture reply: Review a synthetic change');
  expect((await(await request.get(`/api/conversations/${source.id}`)).json()).conversation.status).toBe("interrupted");
  await page.evaluate(()=>localStorage.setItem("mana-language","en"));
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await expect(page.locator('.task-deliveries')).toContainText('Fixture reply: Review a synthetic change');
  const reloaded=await childDetail();
  expect(reloaded.receipts[0]).toMatchObject({id:child.receipts[0].id,claimedByRunId:null,summary:child.receipts[0].summary});
  expect((await childDetail()).runs).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
