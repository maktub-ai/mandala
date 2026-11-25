import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { LibrarySection, LibrarySummary } from '../shared/data-plugins';
import { libraryFilesPath, type LibraryFile, type LibraryFileList } from '../shared/library-files';
import type { Project } from '../shared/types';
import { projectWorkspaces } from '../shared/workspaces';
import { canonical, inside, repositoryRoot } from './code-graph-sources';

const git = promisify(execFile);
export const validCollectionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[^a-z0-9._-]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

async function regularFile(path: string) {
  if (await realpath(path).catch(() => null) !== path) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    const opened = await file.stat();
    const current = await lstat(path);
    if (opened.isFile() && current.isFile() && opened.dev === current.dev && opened.ino === current.ino && await realpath(path) === path) return { file, stat: opened };
  } catch { /* The file may have disappeared. */ }
  await file.close();
  return null;
}
async function readText(path: string) {
  const opened = await regularFile(path);
  if (!opened) return null;
  try { return await opened.file.readFile('utf8'); }
  finally { await opened.file.close(); }
}

function markerId(raw: string) {
  const value = parseJson(raw);
  return object(value) && validCollectionId(value.project) ? value.project : null;
}
async function nearestMarker(folder: string, top: string | null, namespace: string) {
  for (let directory = folder; ; directory = dirname(directory)) {
    const marker = await readText(join(directory, '.' + namespace + '.json'));
    if (marker !== null) {
      return { directory, id: markerId(marker) };
    }
    if (directory === top || dirname(directory) === directory) return null;
  }
}

async function collectionIds(cwd: string, namespace: string, fallback: () => Promise<{ id: string; paths: string[] }[]>) {
  if (!isAbsolute(cwd)) return [];
  const folder = await canonical(cwd);
  if (folder) {
    const top = await repositoryRoot(folder);
    const marker = await nearestMarker(folder, top, namespace);
    if (marker) return marker.id ? [marker.id] : [];
    if (folder === top) {
      const common = await git('git', ['rev-parse', '--git-common-dir'], { cwd: folder, windowsHide: true }).catch(() => null);
      if (common) {
        const binding = await readText(join(resolve(folder, common.stdout.trim()), namespace + '-project'));
        if (binding !== null) return validCollectionId(binding.trim()) ? [binding.trim()] : [];
      }
    }
  }
  return (await fallback()).filter(({ paths }) => paths.some(path => inside(path, cwd) || folder && inside(path, folder))).map(({ id }) => id);
}

type Section = LibrarySection & { id: string; pluginId: string };
type Candidate = { id: string; directory: string; title: string };

async function collectionRoot(namespace: string) {
  const home = process.env[namespace.toUpperCase() + '_HOME'] ?? join(homedir(), '.' + namespace);
  if (!isAbsolute(home)) return null;
  const base = await canonical(home);
  if (!base) return null;
  const root = join(base, 'projects');
  return (await lstat(root).catch(() => null))?.isDirectory() ? root : null;
}

async function registeredPaths(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const result: { id: string; paths: string[] }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !validCollectionId(entry.name)) continue;
    const raw = await readText(join(root, entry.name, '.paths.json'));
    const value = raw && parseJson(raw);
    if (object(value)) result.push({ id: entry.name, paths: Object.keys(value).filter(key => isAbsolute(key)) });
  }
  return result;
}

type BindingEvidence = {
  workspaceId: string;
  source: 'marker' | 'worktree-marker' | 'primary-marker' | 'default-ref' | 'git-common-dir' | 'path-history' | 'unverified-repository';
  planId: string | null;
  available: boolean;
};

// A broken .git pointer can make rev-parse fail like an ordinary non-repository.
async function enclosingGitDirectory(folder: string) {
  for (let dir = folder; ; dir = dirname(dir)) {
    try { await lstat(join(dir, '.git')); return dir; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return dir; }
    if (dirname(dir) === dir) return null;
  }
}

async function checkoutMarkers(top: string, folder: string, markerDirectory: string | undefined,
  add: (source: BindingEvidence['source'], planId: string | null) => Promise<void>) {
  const run = (args: string[]) => git('git', args, { cwd: top, windowsHide: true });
  const worktrees = (await run(['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0');
  const ref = (await run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(error => {
    if (error.code === 1) return null;
    throw error;
  }))?.stdout.trimEnd();
  const defaultBranch = ref?.replace(/^refs\/remotes\/origin\//, 'refs/heads/');
  const checkout = defaultBranch ? worktrees.find(entry => entry.split('\0').includes('branch ' + defaultBranch)) : worktrees[0];
  const primary = checkout?.split('\0')[0].slice('worktree '.length);
  if (primary && primary !== top) {
    const other = await nearestMarker(join(primary, relative(top, folder)), primary, 'omino');
    if (other) await add(ref ? 'primary-marker' : 'worktree-marker', other.id);
  } else if (!primary && ref) {
    // The default branch need not be checked out. Read its committed marker without switching branches.
    for (let dir = folder; ; dir = dirname(dir)) {
      const file = join(relative(top, dir), '.omino.json').split(sep).join('/');
      const entry = await run(['--literal-pathspecs', 'ls-tree', ref, '--', file]);
      if (entry.stdout) {
        const marker = await run(['cat-file', 'blob', ref + ':' + file]);
        await add('default-ref', markerId(marker.stdout));
        break;
      }
      if (dir === top) break;
    }
  }
  if (!markerDirectory || markerDirectory === top) {
    const common = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const binding = await readText(join(common.stdout.trimEnd(), 'omino-project'));
    if (binding !== null) await add('git-common-dir', validCollectionId(binding.trim()) ? binding.trim() : null);
  }
  return Boolean(ref && primary === top);
}

// Keep provenance for upgrade decisions. The Library uses its original display precedence above.
export async function previewProjectPlanBindings(projects: Project[]) {
  const root = await collectionRoot('omino');
  let history: ReturnType<typeof registeredPaths> | undefined;
  const results = [];
  for (const project of projects) {
    const evidence: BindingEvidence[] = [];
    for (const workspace of projectWorkspaces(project)) {
      if (workspace.machineId !== undefined || !isAbsolute(workspace.cwd)) continue;
      const add = async (source: BindingEvidence['source'], planId: string | null) => {
        const file = root && planId ? await regularFile(join(root, planId, 'project.md')) : null;
        await file?.file.close();
        evidence.push({ workspaceId: workspace.id, source, planId, available: !!file });
      };
      const folder = await canonical(workspace.cwd);
      const top = folder ? await repositoryRoot(folder) : null;
      const boundary = top ?? (folder && await enclosingGitDirectory(folder));
      const marker = folder ? await nearestMarker(folder, boundary, 'omino') : null;
      const before = evidence.length;
      let canonicalMarker = !boundary;
      if (folder && boundary) {
        if (top && inside(top, folder)) {
          try { canonicalMarker = await checkoutMarkers(top, folder, marker?.directory, add); }
          catch { await add('unverified-repository', null); }
        } else {
          await add('unverified-repository', null);
        }
      }
      if (marker) await add(canonicalMarker ? 'marker' : 'worktree-marker', marker.id);
      if (evidence.length === before && root) {
        for (const entry of await (history ??= registeredPaths(root))) {
          if (entry.paths.some(path => inside(path, workspace.cwd) || folder && inside(path, folder))) await add('path-history', entry.id);
        }
      }
    }
    const ids = new Set(evidence.map(row => row.planId).filter((id): id is string => id !== null));
    const explicit = evidence.some(row => ['marker', 'primary-marker', 'default-ref', 'git-common-dir'].includes(row.source));
    let status: 'bound' | 'conflict' | 'candidate' | 'unbound' = 'unbound';
    if (ids.size > 1 && evidence.some(row => row.planId && row.source !== 'path-history')) status = 'conflict';
    else if (explicit && ids.size === 1 && evidence.every(row => row.available)) status = 'bound';
    else if (evidence.length) status = 'candidate';
    results.push({ projectId: project.id, status, planId: status === 'bound' ? [...ids][0] : null, evidence });
  }
  return results;
}

async function discover(source: Section['source'], projects: Project[]) {
  const root = source.kind === 'collection' ? await collectionRoot(source.namespace) : null;
  const groups: { project: Project; candidates: Candidate[] }[] = [];
  if (source.kind === 'collection' && !root) return groups;
  let paths: ReturnType<typeof registeredPaths> | undefined;
  for (const project of projects) {
    const files = new Map<string, Candidate>();
    for (const workspace of projectWorkspaces(project)) {
      if (workspace.machineId !== undefined || !isAbsolute(workspace.cwd)) continue;
      if (source.kind === 'workspace') {
        const directory = await canonical(workspace.cwd);
        if (directory) files.set(workspace.id, { id: workspace.id, directory, title: workspace.name });
      } else if (root) {
        const ids = await collectionIds(workspace.cwd, source.namespace, () => paths ??= registeredPaths(root));
        for (const id of ids) {
          const directory = join(root, id);
          if (!files.has(id) && (await lstat(directory).catch(() => null))?.isDirectory()) files.set(id, { id, directory, title: id });
        }
      }
    }
    if (files.size) groups.push({ project, candidates: [...files.values()] });
  }
  return groups;
}

export function createLibraryFiles() {
  // Cache the extracted display fields only. Two declarations may map the same JSON differently.
  type Display = Pick<LibraryFile, 'title' | 'badge' | 'needsUpdate' | 'modifiedAt'>;
  const summaries = new Map<string, { stamp: string; display: Display }>();
  async function readSummary(candidate: Candidate, summary: LibrarySummary): Promise<Display> {
    const path = join(candidate.directory, summary.file);
    const opened = await regularFile(path);
    const display = { title: candidate.title, badge: 0, needsUpdate: true, modifiedAt: opened?.stat.mtimeMs ?? null };
    if (!opened) { summaries.delete(path); return display; }
    try {
      const { dev, ino, size, mtimeMs, ctimeMs } = opened.stat;
      const stamp = JSON.stringify([dev, ino, size, mtimeMs, ctimeMs, summary]);
      const cached = summaries.get(path);
      if (cached?.stamp === stamp) return cached.display;
      const value = parseJson(await opened.file.readFile('utf8'));
      if (object(value) && value.format === summary.format && value.version === summary.version) {
        const title = value[summary.title];
        const items = summary.badgeItems && value[summary.badgeItems];
        const closed = summary.closedField !== undefined && value[summary.closedField] === summary.closedValue;
        if (typeof title === 'string' && title.trim()) display.title = title;
        display.badge = !closed && Array.isArray(items) ? items.length : 0;
        display.needsUpdate = false;
      }
      if (summaries.size >= 512) summaries.delete(summaries.keys().next().value!);
      summaries.set(path, { stamp, display });
      return display;
    } finally { await opened.file.close(); }
  }

  return {
    async list(section: Section, projects: Project[]): Promise<LibraryFileList> {
      const result: LibraryFileList = { projects: [] };
      const { source } = section;
      for (const { project, candidates } of await discover(source, projects)) {
        const files: LibraryFile[] = [];
        for (const candidate of candidates) {
          const view = await regularFile(join(candidate.directory, source.file));
          if (!view && source.kind === 'workspace') continue;
          await view?.file.close();
          const display = source.kind === 'collection' && source.summary
            ? await readSummary(candidate, source.summary)
            : { title: candidate.title, badge: 0, needsUpdate: false, modifiedAt: view?.stat.mtimeMs ?? null };
          const viewUrl = view ? libraryFilesPath(section.pluginId) + '/' + encodeURIComponent(candidate.id) + '/view.html?project=' + encodeURIComponent(project.id) : null;
          files.push({ id: candidate.id, filename: basename(source.file), ...display, viewUrl });
        }
        if (files.length) result.projects.push({ projectId: project.id, projectName: project.name, files });
      }
      return result;
    },
    async view(section: Section, project: Project, id: string) {
      if (section.source.kind === 'collection' && !validCollectionId(id)) return null;
      const groups = await discover(section.source, [project]);
      const file = groups[0]?.candidates.find(candidate => candidate.id === id);
      return file ? (await regularFile(join(file.directory, section.source.file)))?.file ?? null : null;
    },
  };
}
