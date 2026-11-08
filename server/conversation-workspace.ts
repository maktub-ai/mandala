import { execFile } from "node:child_process";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "../shared/workspace-contracts";
import { readLocalFilePreview } from "./local-files";

const run = promisify(execFile), LIMIT = 1024 * 1024, MAX_FILES = 1000;
const scopeError = () => new DomainError("file_scope", 403, "File is outside this conversation's workspace preview scope");
const sensitivePart = (part: string) => /^(?:\.git|\.ssh|\.aws|\.codex|\.config|\.gnupg|\.azure|\.kube|\.npmrc|\.netrc|\.env(?:\..*)?|auth(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)
  || /\.(?:pem|key|p12|pfx)$/i.test(part);
function safePath(path: unknown): path is string {
  return typeof path === "string" && !!path && path.length <= 4096 && !isAbsolute(path) && !/[\\\x00-\x1f]/.test(path)
    && !path.split("/").some(part => !part || part === "." || part === ".." || sensitivePart(part));
}
function checkRoot(root: string) {
  const parts = root.toLowerCase().split(sep);
  if (parts.some((part, i) => sensitivePart(part) && !(part === ".codex" && parts[i + 1] === "worktrees"))) throw scopeError();
}
async function location(cwd: string, path: string) {
  const root = await realpath(cwd).catch(() => { throw new DomainError("workspace_missing", 404, "Working directory is unavailable"); });
  checkRoot(root);
  let at = root;
  for (const part of path.split("/")) {
    at = resolve(at, part);
    const entry = await lstat(at).catch(() => null);
    if (entry?.isSymbolicLink()) throw scopeError();
    if (!entry) return { root, path: resolve(root, path), missing: true };
  }
  const canonical = await realpath(at);
  if (!canonical.startsWith(root + sep) || !safePath(relative(root, canonical).split(sep).join("/"))) throw scopeError();
  return { root, path: canonical, missing: false };
}
async function rawGit(cwd: string, args: string[], limit = 2 * LIMIT) {
  const { stdout } = await run("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    shell: false, encoding: "utf8", maxBuffer: limit, timeout: 5000, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1" },
  });
  return stdout;
}
async function git(cwd: string, args: string[], limit = 2 * LIMIT) {
  const overrides: string[] = [];
  if (args[0] === "diff" || args[0] === "status") {
    // Read only filter key names; repository/global credential values are never returned.
    const names = await rawGit(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|smudge|required)$"]).catch(error => {
      if (error.code === 1 && !error.stdout) return "";
      throw new DomainError("git_config_unavailable", 409, "Git filter configuration is unavailable");
    });
    const drivers = new Set(names.split("\0").filter(Boolean).map(name => name.replace(/\.(clean|process|smudge|required)$/, "")));
    for (const driver of drivers) {
      if (/[=\r\n]/.test(driver)) throw new DomainError("git_config_unavailable", 409, "Git filter configuration is unavailable");
      for (const filter of ["clean", "process", "smudge", "required"]) overrides.push("-c", `${driver}.${filter}=${filter === "required" ? "false" : ""}`);
    }
  }
  return rawGit(cwd, [...overrides, ...args], limit);
}
async function isGit(cwd: string) { return (await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim() === "true"; }

export type DiffScope = 'all' | 'staged' | 'unstaged' | 'branch';
type ChangeStats = { additions: number | null; deletions: number | null; binary?: boolean };
function diffScope(value: unknown): DiffScope {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'staged' || value === 'unstaged' || value === 'branch') return value;
  throw new DomainError('diff_scope', 400, 'Invalid change scope');
}
const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color', '--relative'];
async function hasHead(root: string) { return !!(await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')); }
const rangeArgs = (scope: DiffScope, head: boolean) => scope === 'staged' ? ['--cached'] : scope === 'all' && head ? ['HEAD'] : [];
const lineCount = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
async function addition(root: string, path: string) {
  const target = await location(root, path);
  if (target.missing) return { text: '', additions: 0, deletions: 0 };
  try {
    const { text } = await readLocalFilePreview(target.path, [root]);
    return { text, additions: lineCount(text), deletions: 0 };
  } catch (error) {
    if (error instanceof DomainError && error.status === 415) return { text: '', additions: null, deletions: null, binary: true };
    throw error;
  }
}
function addedPatch(path: string, text: string) {
  if (!text) return `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  const lines = text.replace(/\n$/, '').split('\n').map(line => '+' + line).join('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lineCount(text)} @@\n${lines}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
}

async function branchComparison(root: string, requestedBase?: unknown, allowUnavailable = false) {
  const [refs, current, head, remoteHead] = await Promise.all([
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
    git(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(() => ''),
  ]);
  const baseRefs = refs.trim().split('\n').filter(ref => ref && !ref.endsWith('/HEAD'));
  const baseRef = requestedBase ?? [remoteHead.trim(), 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'].find(ref => ref !== current.trim() && baseRefs.includes(ref));
  const comparison = {baseRef:typeof baseRef === 'string' ? baseRef : '',baseRefs,mergeBase:'',head:head.trim(),headRef:current.trim() || head.trim().slice(0,12),error:''};
  const unavailable = (message:string) => {
    if (!allowUnavailable) throw new DomainError('branch_base_unavailable',409,message);
    return {...comparison,error:message};
  };
  if (requestedBase !== undefined && (typeof baseRef !== 'string' || !baseRefs.includes(baseRef))) throw new DomainError('branch_base_unavailable',409,'No comparison base is available for this branch');
  if (!comparison.baseRef) return unavailable('No comparison base is available for this branch');
  const mergeBase = head && (await git(root, ['merge-base', comparison.baseRef, head.trim()]).catch(() => '')).trim();
  if (!mergeBase) return unavailable('No common ancestor is available for this branch');
  return {...comparison,mergeBase};
}

type WorkspaceListing = {cwd:string;git:boolean;files:({path:string;status:string}&Partial<ChangeStats>)[];directories?:string[];truncated:boolean;untracked?:number;comparison?:Awaited<ReturnType<typeof branchComparison>>};
export async function listConversationWorkspace(cwd: string, requestedScope?: unknown, requestedDirectory?: unknown, requestedBase?: unknown): Promise<WorkspaceListing> {
  const scope = diffScope(requestedScope);
  if (requestedDirectory !== undefined) {
    if (!safePath(requestedDirectory)) throw scopeError();
    const target = await location(cwd, requestedDirectory);
    if (target.missing || !(await lstat(target.path)).isDirectory()) throw new DomainError("directory_missing", 404, "Directory is unavailable");
    const listing = await listConversationWorkspace(target.path, requestedScope, undefined, requestedBase);
    return {...listing, cwd, files:listing.files.map(file=>({...file,path:requestedDirectory+"/"+file.path})), directories:(listing.directories??[]).map(path=>requestedDirectory+"/"+path)};
  }
  const root = await realpath(cwd).catch(() => null);
  if (!root) return { cwd, git: false, files: [], truncated: false };
  checkRoot(root);
  const paths = new Map<string, string>();
  const folders = new Set<string>();
  let truncated = false, scanned = 0, untrackedCount = 0;
  const repository = await isGit(root);
  if (repository && scope === 'branch') {
    const comparison = await branchComparison(root, requestedBase, true);
    if (comparison.error) return {cwd,git:true,files:[],truncated:false,comparison};
    const args = [...diffArgs, comparison.mergeBase, comparison.head];
    const [names, counts] = await Promise.all([
      git(root, [...args, '--name-status', '-z', '--', '.']),
      git(root, [...args, '--numstat', '-z', '--', '.']),
    ]);
    const statuses = new Map<string,string>(), records = names.split('\0');
    for (let i=0; i+1<records.length; i+=2) statuses.set(records[i+1], records[i]+' ');
    const files: WorkspaceListing['files'] = [];
    for (const record of counts.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match || !safePath(match[3])) continue;
      try { await location(root, match[3]); } catch { continue; }
      if (files.length >= MAX_FILES) { truncated=true; break; }
      files.push({path:match[3],status:statuses.get(match[3])??'M ',additions:match[1]==='-'?null:Number(match[1]),deletions:match[2]==='-'?null:Number(match[2]),...(match[1]==='-'?{binary:true}:{})});
    }
    return {cwd,git:true,files:files.sort((a,b)=>a.path.localeCompare(b.path)),truncated,comparison};
  }
  const directories = [""];
  while (directories.length && !truncated) {
    const directory = directories.shift()!;
    try {
      const target = directory ? (await location(root, directory)).path : root;
      for await (const entry of await opendir(target)) {
        if (++scanned > MAX_FILES) { truncated = true; break; }
        const path = directory ? directory + "/" + entry.name : entry.name;
        if (!safePath(path)) continue;
        if (entry.isFile()) paths.set(path, "");
        else if (entry.isDirectory() && entry.name !== "node_modules") {
          folders.add(path);
          if (requestedScope === undefined || !repository) directories.push(path);
        }
      }
    } catch { truncated = true; }
  }
  if (repository) {
    try {
      const [tracked, changes, prefix] = await Promise.all([
        git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", ...(requestedScope === undefined ? [] : ["--no-renames"])]),
        git(root, ["rev-parse", "--show-prefix"]),
      ]);
      // The changes view only needs status entries; unchanged files would just eat the cap.
      if (requestedScope === undefined) for (const path of tracked.split("\0")) {
        if (!safePath(path)) continue;
        if (paths.size >= MAX_FILES && !paths.has(path)) { truncated = true; continue; }
        paths.set(path, "");
      }
      const records = changes.split("\0"), base = prefix.replace(/\n$/, "");
      // Tracked changes claim the cap before untracked files.
      for (const untracked of [false, true]) for (let i = 0; i < records.length; i++) {
        const status = records[i].slice(0, 2), name = records[i].slice(3);
        if (/[RC]/.test(status)) i++;
        if ((status === '??') !== untracked || !name.startsWith(base)) continue;
        const path = name.slice(base.length);
        if (!safePath(path)) continue;
        if (untracked) untrackedCount++;
        if (paths.size >= MAX_FILES && !paths.has(path)) { truncated = true; continue; }
        paths.set(path, status === '??' && paths.get(path)?.[0] === 'D' ? 'D?' : status);
      }
    } catch { truncated = true; }
  }
  const stats = new Map<string, ChangeStats>();
  if (repository && requestedScope !== undefined) {
    const head = await hasHead(root);
    if (scope !== 'all' || head) {
      const output = await git(root, [...diffArgs, ...rangeArgs(scope, head), '--numstat', '-z', '--', '.']);
      for (const record of output.split('\0')) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
        if (match && safePath(match[3])) stats.set(match[3], { additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]), ...(match[1] === '-' ? { binary: true } : {}) });
      }
    }
    // Untracked files (and all files before the first commit) have an empty base.
    if (scope !== 'staged') for (const [path, status] of paths) {
      if (!status.includes('?') && !(scope === 'all' && !head)) continue;
      try {
        const { text: _, ...counts } = await addition(root, path);
        const removed = stats.get(path);
        stats.set(path, scope === 'all' && status === 'D?' && counts.additions !== null && removed?.deletions !== null ? {...counts, deletions: removed?.deletions ?? 0} : counts);
      } catch { stats.set(path, { additions: null, deletions: null }); }
    }
  }
  const files: { path: string; status: string; additions?: number | null; deletions?: number | null; binary?: boolean }[] = [];
  for (const [path, status] of paths) {
    try {
      if (requestedScope !== undefined && (!status.trim() || scope === 'staged' && (status[0] === ' ' || status === '??') || scope === 'unstaged' && status[1] === ' ')) continue;
      const target = await location(root, path);
      if (target.missing ? status.includes("D") : (await lstat(target.path)).isFile()) files.push({ path, status: status === 'D?' && scope !== 'all' ? scope === 'staged' ? 'D ' : '??' : status, ...(requestedScope === undefined ? {} : stats.get(path) ?? { additions: 0, deletions: 0 }) });
    } catch { /* A changed or linked entry is not a readable workspace file. */ }
  }
  return { cwd, git: repository, files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: [...folders].sort(), truncated, ...(repository && requestedScope !== undefined ? { untracked: untrackedCount } : {}) };
}

const languages: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".json": "json", ".md": "markdown", ".py": "python",
  ".sh": "bash", ".css": "css", ".html": "html", ".sql": "sql", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".rs": "rust", ".go": "go",
};
export async function readConversationWorkspaceFile(cwd: string, path: unknown, requestedScope?: unknown, requestedBase?: unknown) {
  const scope = diffScope(requestedScope);
  if (!safePath(path)) throw scopeError();
  const target = await location(cwd, path);
  const before = target.missing ? null : await lstat(target.path);
  const repository = await isGit(target.root);
  if (repository && scope === 'branch') {
    const comparison = await branchComparison(target.root, requestedBase);
    try {
      const [diff, entry] = await Promise.all([
        git(target.root, [...diffArgs, comparison.mergeBase, comparison.head, '--', path], LIMIT),
        git(target.root, ['ls-tree', '-z', comparison.head, '--', path]),
      ]);
      if (entry && !/^100(?:644|755) blob /.test(entry)) throw scopeError();
      if (!entry && !diff) throw new DomainError('file_missing', 404, 'Local file is unavailable');
      const content = entry ? await git(target.root, ['cat-file', 'blob', entry.split(' ')[2].split('\t')[0]], LIMIT) : '';
      const binary = content.includes('\0') || /^Binary files /m.test(diff);
      return {name:basename(path),path,text:binary?'':content,language:languages[extname(path).toLowerCase()],diff:diff||null,...(binary?{binary:true}:{})};
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('diff_unavailable', 413, 'File diff is unavailable or too large to preview');
    }
  }
  let text = '', binary = false;
  if (!target.missing) {
    try { text = (await readLocalFilePreview(target.path, [target.root])).text; }
    catch (error) {
      if (repository && error instanceof DomainError && error.status === 415) binary = true;
      else throw error;
    }
  }
  let diff: string | null = null;
  if (repository) {
    try {
      const [head, tracked] = await Promise.all([hasHead(target.root), git(target.root, ['ls-files', '--cached', '-z', '--', path])]);
      if (scope !== 'staged' && (!tracked || scope === 'all' && !head) && !target.missing) {
        const deletedBase = scope === 'all' && head ? await git(target.root, [...diffArgs, 'HEAD', '--', path], LIMIT) : '';
        diff = deletedBase + (binary ? '' : addedPatch(path, text)) || null;
      } else {
        diff = await git(target.root, [...diffArgs, ...rangeArgs(scope, head), '--', path], LIMIT) || null;
      }
    } catch { throw new DomainError('diff_unavailable', 413, 'File diff is unavailable or too large to preview'); }
  }
  if (diff && /^Binary files /m.test(diff)) binary = true;
  if (target.missing && !diff) throw new DomainError('file_missing', 404, 'Local file is unavailable');
  const current = await location(cwd, path), after = current.missing ? null : await lstat(current.path);
  if (current.root !== target.root || current.path !== target.path || current.missing !== target.missing
    || before && after && (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).some(key => before[key] !== after[key]))
    throw new DomainError('file_changed', 409, 'File changed while loading; open it again');
  return { name: basename(path), path, text, ...(languages[extname(path).toLowerCase()] ? { language: languages[extname(path).toLowerCase()] } : {}), diff, ...(binary ? { binary } : {}) };
}

// A worktree counts as created by the conversation when its events name the worktree's directory
// within this window around the worktree's creation; listing worktrees later does not claim them.
const CREATION_WINDOW = 10 * 60 * 1000;
type Mentioned = (needle: string, from: string, to: string) => boolean;

// Where a conversation works: branch, tracked change totals and the repository's other worktrees.
export async function conversationEnvironment(cwd: string, mentioned?: Mentioned) {
  const root = await realpath(cwd).catch(() => null);
  if (!root || !(await isGit(root))) return { cwd, git: false as const };
  checkRoot(root);
  const [branch, list, counts] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then(value => value.trim()).catch(() => ""),
    git(root, ["worktree", "list", "--porcelain"]).catch(() => ""),
    hasHead(root).then(head => head ? git(root, [...diffArgs, "HEAD", "--numstat", "-z", "--", "."]) : ""),
  ]);
  const changes = { files: 0, additions: 0, deletions: 0 };
  for (const record of counts.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match || !safePath(match[3])) continue;
    changes.files++; changes.additions += Number(match[1]) || 0; changes.deletions += Number(match[2]) || 0;
  }
  const top = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim()).catch(() => root);
  const worktrees = await Promise.all(list.split("\n\n").map(block => ({
    path: /^worktree (.+)$/m.exec(block)?.[1] ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "",
  })).filter(item => item.path).map(async item => {
    const path = await realpath(item.path).catch(() => item.path);
    const created = await stat(join(path, ".git")).then(info => info.birthtimeMs || info.ctimeMs).catch(() => 0);
    const createdHere = !!mentioned && created > 0 && mentioned(basename(path), new Date(created - CREATION_WINDOW).toISOString(), new Date(created + CREATION_WINDOW).toISOString());
    return { ...item, path, createdHere };
  }));
  return { cwd, git: true as const, branch: branch === "HEAD" ? "" : branch, changes, worktrees: worktrees.filter(item => item.path !== top) };
}
