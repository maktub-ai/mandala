import {realpath, stat} from 'node:fs/promises';
import {isAbsolute, join, posix, relative, sep} from 'node:path';
import type {Config, Conversation} from '../shared/types';
import {projectWorkspaces} from '../shared/workspaces';
import {gitWorkspaceRoots} from './work-directory-discovery';
import type {Store} from './store';

type Binding = Pick<Conversation,'projectId'|'cwd'|'executionLocation'|'purpose'>;

async function localDirectory(path:string) {
  if (!isAbsolute(path) || !(await stat(path).catch(()=>null))?.isDirectory()) return;
  const actual = await realpath(path).catch(()=>null);
  if (!actual) return;
  const roots = await gitWorkspaceRoots(actual);
  return {actual, repository:roots?.commonDir, shared:roots && join(roots.commonDir,relative(roots.checkoutRoot,actual))};
}

function distance(root:string, directory:string, paths:{relative:typeof relative; isAbsolute:typeof isAbsolute; sep:string}) {
  const suffix=paths.relative(root,directory);
  if (!suffix) return 0;
  if (paths.isAbsolute(suffix) || suffix.split(paths.sep)[0]==='..') return Infinity;
  return suffix.split(paths.sep).length;
}

// One lookup per distinct local directory during a historical backfill. SSH paths never enter local Git.
export function conversationProjectResolver(config:Pick<Config,'projects'|'executionMachines'>) {
  const local=new Map<string,ReturnType<typeof localDirectory>>();
  const inspect=(path:string)=>{
    let pending=local.get(path);
    if (!pending) { pending=localDirectory(path); local.set(path,pending); }
    return pending;
  };
  return async (chat:Binding):Promise<string|undefined>=>{
    if (chat.projectId && config.projects.some(project=>project.id===chat.projectId)) return chat.projectId;
    if (chat.purpose==='mandala-main') return;
    const remote=chat.executionLocation, cwd=remote?.cwd ?? chat.cwd;
    if (!cwd || !config.projects.length) return;
    if (remote && (!posix.isAbsolute(cwd) || !config.executionMachines?.some(machine=>machine.id===remote.machineId && machine.host===remote.host))) return;
    const target=remote ? undefined : await inspect(cwd);
    if (!remote && !target) return;
    const matches=new Set<string>();
    let best=Infinity;
    for (const project of config.projects) for (const workspace of projectWorkspaces(project)) {
      if (workspace.machineId!==remote?.machineId || !workspace.cwd) continue;
      let depth=Infinity;
      if (remote) {
        if (posix.isAbsolute(workspace.cwd)) depth=distance(workspace.cwd,cwd,posix);
      } else if (target) {
        const root=await inspect(workspace.cwd);
        if (!root) continue;
        const paths={relative,isAbsolute,sep};
        depth=distance(root.actual,target.actual,paths);
        if (root.repository===target.repository && root.shared && target.shared) depth=Math.min(depth,distance(root.shared,target.shared,paths));
      }
      if (!Number.isFinite(depth) || depth>best) continue;
      if (depth<best) { matches.clear(); best=depth; }
      matches.add(project.id);
    }
    return matches.size===1 ? [...matches][0] : undefined;
  };
}

export async function backfillConversationProjects(store:Store,config:Config) {
  const db=store.database, migration='conversation_project_attribution_v1';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE key=?').get(migration)) return;
  const resolveProject=conversationProjectResolver(config);
  const page=db.prepare("SELECT rowid,id,data FROM conversations WHERE rowid>? AND json_extract(data,'$.attributedProjectId') IS NULL ORDER BY rowid LIMIT 128");
  const update=db.prepare("UPDATE conversations SET data=json_set(data,'$.attributedProjectId',?) WHERE id=? AND json_extract(data,'$.attributedProjectId') IS NULL");
  let cursor=0;
  for (;;) {
    const rows=page.all(cursor);
    if (!rows.length) break;
    const matches:{conversation:string;project:string}[]=[];
    for (const row of rows) {
      const project=await resolveProject(JSON.parse(row.data as string));
      if (project) matches.push({conversation:row.id as string,project});
    }
    if (matches.length) store.transaction(()=>{
      for (const match of matches) update.run(match.project,match.conversation);
    });
    cursor=Number(rows.at(-1)!.rowid);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(key,applied_at) VALUES (?,?)').run(migration,new Date().toISOString());
}
