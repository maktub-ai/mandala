import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Project } from "../shared/types";
import { buildConversationGroups, conversationEnvironment } from "../src/libraryGroups";

const projects: Project[] = [
  { id: "garden", name: "Home Garden", cwd: "/fixtures/garden", agentIds: ["maker"], resources: [], mcp: [], skills: [] },
  { id: "studio", name: "Photo Studio", cwd: "/fixtures/studio", agentIds: ["maker", "reader"], resources: [], mcp: [], skills: [] },
];
const agents: Agent[] = [
  { id: "maker", name: "Maker", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] },
  { id: "reader", name: "Reader", instructions: "", defaultCli: "omp", models: {}, mcp: [], skills: [] },
];
type TestConversation = Conversation & { updatedAt?: string; completedAt?: string | null };
const chat = (id: string, input: Partial<TestConversation> = {}): TestConversation => ({
  id, projectId: "garden", agentId: "maker", title: id, cli: "codex", model: null,
  nativeId: null, turnId: null, status: "idle", createdAt: "2026-09-28T12:00:00.000Z", ...input,
});
const chats = [
  chat("watering", { title: "Watering notes", updatedAt: "2026-10-01T12:00:00.000Z" }),
  chat("photo", { title: "Photo export", projectId: "studio", status: "running", createdAt: "2026-09-30T12:00:00.000Z" }),
  chat("reading", { title: "Reading list", projectId: "studio", agentId: "reader", cli: "omp", status: "approval" }),
  chat("finished", { title: "Finished checklist", completedAt: "2026-09-29T12:00:00.000Z" }),
  chat("interrupted", { status: "interrupted" }),
  chat("failed", { status: "error" }),
];
const ids = (groups: ReturnType<typeof buildConversationGroups>) => groups.flatMap((group) => group.chats.map((item) => item.id));

describe("conversation library", () => {
  it("keeps_archived_chats_out_of_active_views_and_restores_them_without_changing_completion", () => {
    const archived = chat("saved", { archivedAt: "2026-10-01T12:00:00.000Z", completedAt: "2026-09-29T12:00:00.000Z" });
    const input = [...chats, archived];
    for (const view of ["recent", "projects", "agents"]) {
      expect(ids(buildConversationGroups(input, projects, agents, { view, sort: "activity", search: "" }))).not.toContain("saved");
    }
    expect(ids(buildConversationGroups(input, projects, agents, { view: "archived", sort: "activity", search: "" }))).toEqual(["saved"]);
    const restored = input.map((item) => item.id === "saved" ? { ...item, archivedAt: null } : item);
    expect(ids(buildConversationGroups(restored, projects, agents, { view: "recent", sort: "activity", search: "" }))).toContain("saved");
    expect(archived.archivedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("keeps_all_unarchived_runtime_states_and_legacy_completed_history_in_recent", () => {
    const result = buildConversationGroups(chats, projects, agents, { view: "recent", sort: "activity", search: "" });
    expect(new Set(ids(result))).toEqual(new Set(["watering", "photo", "reading", "interrupted", "failed", "finished"]));
    expect(ids(buildConversationGroups(chats, projects, agents, { view: "recent", sort: "activity", search: "" }))).toContain("finished");
  });

  it("groups_the_same_shared_agent_across_projects_without_duplicate_chats", () => {
    const groups = buildConversationGroups(chats, projects, agents, { view: "agents", sort: "name", search: "" });
    expect(groups.map(({ key, name, chats }) => [key, name, chats.length])).toEqual([
      ["maker", "Maker", 5], ["reader", "Reader", 1],
    ]);
    expect(new Set(groups[0].chats.map((item) => item.projectId))).toEqual(new Set(["garden", "studio"]));
  });

  it("groups_all_projects_and_retains_history_for_a_removed_project", () => {
    const groups = buildConversationGroups([...chats, chat("old", { projectId: "removed" })], projects, agents,
      { view: "projects", sort: "activity", search: "" });
    expect(groups.map(({ key, chats }) => [key, chats.length])).toEqual([["garden", 4], ["studio", 2], ["removed", 1]]);
    expect(groups.find((group) => group.key === "removed")?.name).toBe("");
  });

  it("searches_titles_projects_and_agents_across_projects_case_insensitively", () => {
    const find = (search: string) => ids(buildConversationGroups(chats, projects, agents, { view: "recent", sort: "name", search }));
    expect(find("  EXPORT ")).toEqual(["photo"]);
    expect(new Set(find("photo studio"))).toEqual(new Set(["photo", "reading"]));
    expect(find("reader")).toEqual(["reading"]);
    expect(find("missing text")).toEqual([]);
  });

  it("sorts_recent_activity_by_updated_time_and_falls_back_to_created_time", () => {
    const result = buildConversationGroups(chats, projects, agents, { view: "recent", sort: "activity", search: "" });
    expect(ids(result).slice(0, 2)).toEqual(["watering", "photo"]);
    expect(ids(buildConversationGroups(chats, projects, agents, { view: "recent", sort: "created", search: "" }))[0]).toBe("photo");
    expect(ids(buildConversationGroups(chats, projects, agents, { view: "recent", sort: "name", search: "" }))[0]).toBe("failed");
  });

  it("keeps_completed_history_discoverable_without_mutating_it", () => {
    const original = structuredClone(chats);
    for (const view of ["recent", "projects", "agents"]) {
      expect(ids(buildConversationGroups(chats, projects, agents, { view, sort: "activity", search: "" }))).toContain("finished");
    }
    expect(ids(buildConversationGroups(chats, projects, agents, { view: "recent", sort: "activity", search: "" }))).toContain("finished");
    expect(chats).toEqual(original);
  });

  it("retains_history_when_legacy_completion_is_cleared", () => {
    const restored = chats.map((item) => item.id === "finished" ? { ...item, completedAt: null } : item);
    expect(ids(buildConversationGroups(restored, projects, agents, { view: "recent", sort: "activity", search: "" }))).toContain("finished");
    expect(buildConversationGroups([], projects, agents, { view: "projects", sort: "activity", search: "" })).toEqual([]);
  });
});

describe("conversation environment", () => {
  it("uses a saved directory instead of a moved project's current default", () => {
    const saved=chat("snapshot",{workspaceId:"default",workspaceName:"Default",cwd:"/fixtures/old"});
    expect(conversationEnvironment(saved,projects[0])).toEqual({name:"Default",cwd:"/fixtures/old"});
    expect(conversationEnvironment(chat("legacy"),projects[0])).toEqual({name:undefined,cwd:undefined});
  });
  it("matches legacy paths without guessing a default group", () => {
    const project={...projects[0],workspaces:[{id:"web",name:"Web",cwd:"/fixtures/web",resources:[]},{id:"api",name:"API",cwd:"/fixtures/api",resources:[]}]};
    expect(conversationEnvironment(chat("legacy",{cwd:"/fixtures/api"}),project)).toEqual({name:"API",cwd:"/fixtures/api"});
    expect(conversationEnvironment(chat("unbound",{workspaceId:null,cwd:"/fixtures/api"}),project)).toEqual({name:undefined,cwd:"/fixtures/api"});
    expect(conversationEnvironment(chat("unknown",{cwd:"/fixtures/old"}),project)).toEqual({name:undefined,cwd:"/fixtures/old"});
  });
});

it("does not guess among multiple groups sharing the same legacy path", () => {
  const project={...projects[0],workspaces:[{id:"web",name:"Web",cwd:"/fixtures/shared",resources:[]},{id:"api",name:"API",cwd:"/fixtures/shared",resources:[]}]};
  expect(conversationEnvironment(chat("legacy",{cwd:"/fixtures/shared"}),project)).toEqual({name:undefined,cwd:"/fixtures/shared"});
});
