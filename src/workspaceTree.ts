export type WorkspaceTreeFile = { path: string; status: string; additions?: number | null; deletions?: number | null; binary?: boolean };
export type WorkspaceTreeNode = WorkspaceTreeFile & { children?: WorkspaceTreeNode[] };

export function workspaceTree(files: WorkspaceTreeFile[], directories: string[] = []): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode = {path: '', status: '', children: []};
  const folders = new Map<string, WorkspaceTreeNode>([['', root]]);
  const folder = (path: string): WorkspaceTreeNode => {
    if (folders.has(path)) return folders.get(path)!;
    const node: WorkspaceTreeNode = {path, status: '', children: []};
    folders.set(path, node);
    folder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').children!.push(node);
    return node;
  };
  for (const path of directories) folder(path);
  for (const file of files) folder(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '').children!.push({...file});
  for (const node of folders.values()) node.children!.sort((a,b) => Number(!!b.children) - Number(!!a.children) || a.path.localeCompare(b.path));
  return root.children!;
}
