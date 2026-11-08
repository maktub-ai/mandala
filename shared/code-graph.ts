export type CodeGraphSettings = { enabled: boolean; scope: 'directory' | 'repository' };
export type CodeGraphStatus = {
  bindingId: string; label: string; enabled: boolean; scope: CodeGraphSettings['scope'];
  selectedRoot: string | null; root: string | null; repositoryRoot: string | null;
  status: 'disabled' | 'missing' | 'not-checked-out' | 'unsupported' | 'pending' | 'indexing' | 'ready' | 'stale' | 'error';
  files?: number; nodes?: number; generation?: number; snapshot?: string; updatedAt?: string; error?: string;
};
export type CodeGraphReadScope = {
  projectId: string; agentId: string; workspaceId: string | null; cwd?: string;
  bindings: { bindingId: string; selectedRoot: string; allowedRoot: string }[];
};
export type CodeGraphNode = { id: string; name: string; kind: string; path: string; startLine: number; endLine: number };
export type CodeGraphResult = { root: string; generation: number; snapshot: string; freshness: 'current'; boundary: string; nodes: CodeGraphNode[]; snippet?: string; truncated?: boolean };
