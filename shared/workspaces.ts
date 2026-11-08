import type { Project, Workspace } from "./types";

export function projectWorkspaces(project?: Project): Workspace[] {
  if (!project) return [];
  return project.workspaces ?? [{ id: "default", name: "Default", cwd: project.cwd, resources: project.resources }];
}

export function selectedWorkspace(project: Project | undefined, id?: string | null): Workspace | undefined {
  if (id === null) return undefined;
  const workspaces = projectWorkspaces(project);
  if (id === undefined) return workspaces[0];
  const workspace = workspaces.find(item => item.id === id);
  if (!workspace) throw new Error("invalid workspace");
  return workspace;
}
