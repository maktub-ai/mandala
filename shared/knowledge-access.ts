import type { KnowledgeEntry } from "./types";

export function canUseKnowledge(entry: KnowledgeEntry, context: { agentId: string; projectId: string }): boolean {
  const access = entry.access;
  if (access?.mode === "private") return false;
  if (access?.mode === "all") return true;
  if (access?.mode === "selected") return !!(context.agentId && access.agentIds?.includes(context.agentId) ||
    context.projectId && access.projectIds?.includes(context.projectId));
  return entry.scope === "global" || entry.scope === "project" && entry.projectId === context.projectId ||
    entry.scope === "agent" && entry.agentId === context.agentId && (!entry.projectId || entry.projectId === context.projectId);
}
