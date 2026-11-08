import { projectWorkspaces } from "../shared/workspaces";
import type { Agent, Conversation, Project } from "../shared/types";

export type ConversationGroup = { key: string; name: string; chats: Conversation[] };

export function conversationEnvironment(chat: Conversation, project?: Project): { name?: string; cwd?: string } {
  const workspaces = chat.workspaceId === null ? [] : projectWorkspaces(project);
  const matches = chat.cwd ? workspaces.filter(w => w.cwd === chat.cwd) : [];
  const candidate = chat.workspaceId !== undefined ? workspaces.find(w => w.id === chat.workspaceId) :
    matches.length === 1 ? matches[0] : undefined;
  const workspace = candidate && (!chat.cwd || candidate.cwd === chat.cwd) ? candidate : undefined;
  return { name: chat.workspaceId === null ? undefined : chat.workspaceName ?? workspace?.name,
    cwd: chat.cwd ?? workspace?.cwd };
}

export function buildConversationGroups(
  chats: Conversation[], projects: Project[], agents: Agent[],
  options: { view: string; sort: string; search: string },
): ConversationGroup[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const query = options.search.trim().toLocaleLowerCase();
  const compare = (a: Conversation, b: Conversation) => {
    if (options.sort === "name") {
      return (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);
    }
    const time = (chat: Conversation) => Date.parse(options.sort === "created" ? chat.createdAt : chat.updatedAt || chat.createdAt);
    return time(b) - time(a) || a.id.localeCompare(b.id);
  };
  const visible = chats.filter((chat) => {
    if ((options.view === "archived") !== !!chat.archivedAt) return false;
    if (options.view === "completed" && !chat.completedAt) return false;
    const environment = conversationEnvironment(chat, projects.find(p => p.id === chat.projectId));
    return !query || [chat.title ?? "", projectNames.get(chat.projectId) ?? "", agentNames.get(chat.agentId) ?? "", environment.cwd ?? "", environment.name ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(query));
  }).sort(compare);
  if (!visible.length) return [];
  if (options.view !== "projects" && options.view !== "agents") {
    return [{ key: "all", name: "", chats: visible }];
  }
  const groups = new Map<string, ConversationGroup>();
  for (const chat of visible) {
    const key = options.view === "projects" ? chat.projectId : chat.agentId;
    const name = (options.view === "projects" ? projectNames : agentNames).get(key) ?? "";
    if (!groups.has(key)) groups.set(key, { key, name, chats: [] });
    groups.get(key)!.chats.push(chat);
  }
  return [...groups.values()].sort((a, b) => options.sort === "name"
    ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.key.localeCompare(b.key)
    : compare(a.chats[0], b.chats[0]));
}
