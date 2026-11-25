import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLibraryFiles, validCollectionId } from '../server/library-files';
import type { LibrarySection } from '../shared/data-plugins';
import type { Project } from '../shared/types';

let temp: string, cwd: string, projectsDir: string;
const write = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const project = (paths: string[], id = 'todo-app'): Project => ({
  id, name: id, cwd: paths[0], agentIds: [], resources: [], skills: [], mcp: [],
  workspaces: paths.map((cwd, i) => ({ id: 'workspace-' + i, name: 'Workspace', cwd, resources: [] })),
});
const section = {
  id: 'plan', pluginId: 'plugin:example/community:todo', format: 'mandala-library-section', version: 1, type: 'project-files',
  label: { zh: '计划', en: 'Plan' }, icon: 'target', loopback: true,
  source: { kind: 'collection', namespace: 'omino', file: 'view.html', summary: {
    file: 'summary.json', format: 'omino-summary', version: 1, title: 'title', badgeItems: 'waiting', closedField: 'status', closedValue: 'closed',
  } },
} as const satisfies LibrarySection & { id: string; pluginId: string };
const plans = () => createLibraryFiles();
const ids = async (paths: string[]) => (await plans().list(section, [project(paths)])).projects.flatMap(group => group.files.map(plan => plan.id));
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'todo-plans-'));
  projectsDir = join(temp, 'omino', 'projects');
  vi.stubEnv('OMINO_HOME', dirname(projectsDir));
  cwd = join(temp, 'workspace');
  await mkdir(cwd);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

it('prefers the nearest marker up to and including the repository root, ahead of common-dir and path records', async () => {
  const sub = join(cwd, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  execFileSync('git', ['init', '-q', cwd]);
  for (const id of ['root-plan', 'sub-plan', 'git-plan', 'other-plan']) await mkdir(join(projectsDir, id), { recursive: true });
  await write(join(projectsDir, 'other-plan', '.paths.json'), { [cwd]: true });
  await write(join(cwd, '.git', 'omino-project'), 'git-plan\n');
  await write(join(temp, '.omino.json'), { project: 'other-plan' });
  await write(join(cwd, '.omino.json'), { project: 'root-plan' });
  await write(join(dirname(sub), '.omino.json'), { project: 'sub-plan' });
  expect(await ids([cwd, sub, dirname(sub)])).toEqual(['root-plan', 'sub-plan']);
  await rm(join(dirname(sub), '.omino.json'));
  expect(await ids([sub])).toEqual(['root-plan']);
  await rm(join(cwd, '.omino.json'));
  expect(await ids([cwd])).toEqual(['git-plan']);
  expect(await ids([sub])).toEqual(['other-plan']);
  await rm(join(projectsDir, 'other-plan', '.paths.json'));
  expect(await ids([sub])).toEqual([]);
});

it('resolves the common directory from a linked Git worktree root', async () => {
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture']);
  const linked = join(temp, 'linked');
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', linked]);
  await write(join(cwd, '.git', 'omino-project'), ' todo-app \n');
  await mkdir(join(projectsDir, 'todo-app'), { recursive: true });
  expect(await ids([linked])).toEqual(['todo-app']);
});

it('matches all path registrations on directory boundaries and lists only projects with plans', async () => {
  for (const [id, path] of [['a-plan', cwd], ['b-plan', cwd], ['sibling-plan', cwd.slice(0, -1)]]) {
    await write(join(projectsDir, id, '.paths.json'), { [path]: '2026-01-01' });
  }
  expect(await ids([cwd, join(cwd, 'nested')])).toEqual(['a-plan', 'b-plan']);
  const result = await plans().list(section, [project([cwd]), project([temp], 'empty')]);
  expect(result.projects.map(group => group.projectId)).toEqual(['todo-app']);
});

it('rejects invalid IDs without resolving them as plan paths', async () => {
  for (const id of ['.', '..', '', '../outside', 'A', 'two/parts', '/absolute', 'file\\windows', 'ok\n']) {
    expect(validCollectionId(id)).toBe(false);
    await write(join(cwd, '.omino.json'), { project: id });
    expect(await ids([cwd])).toEqual([]);
  }
  expect(validCollectionId('todo.app_2-0')).toBe(true);
});

it('serves legacy plans by directory name and reads only supported summaries and the fixed view', async () => {
  const id = 'todo-app', planPath = join(projectsDir, id);
  await write(join(cwd, '.omino.json'), { project: id });
  await write(join(planPath, 'view.html'), '<h1>Todo</h1>');
  const reader = plans(), get = async () => (await reader.list(section, [project([cwd])])).projects[0].files[0];
  expect(await get()).toMatchObject({ title: id, needsUpdate: true, modifiedAt: null, badge: 0, viewUrl: '/api/v2/library-sections/plugin%3Aexample%2Fcommunity%3Atodo/files/todo-app/view.html?project=todo-app' });
  const summary = { format: 'omino-summary', version: 1, title: 'Todo app', status: 'closed', stage: null, work: { done: 2, total: 3 }, waiting: [{ id: 'release', title: 'Release?', type: 'question', reason: 'Choose a date' }], view: '.serve.json' };
  for (const invalid of [{ ...summary, version: 2 }, { ...summary, format: 'other' }]) {
    await write(join(planPath, 'summary.json'), invalid);
    expect(await get()).toMatchObject({ title: id, needsUpdate: true });
  }
  await write(join(planPath, 'summary.json'), summary);
  expect(await get()).toMatchObject({ title: 'Todo app', badge: 0, filename: 'view.html', needsUpdate: false, modifiedAt: expect.any(Number) });
  await write(join(planPath, 'summary.json'), { ...summary, status: 'active' });
  expect((await get()).badge).toBe(1);
  const view = await reader.view(section, project([cwd]), id);
  try { expect(await view?.readFile('utf8')).toBe('<h1>Todo</h1>'); } finally { await view?.close(); }
  expect(await reader.view(section, project([temp]), id)).toBeNull();
});

it('ignores symlinked plan directories, summaries, path histories and views', async () => {
  const id = 'todo-app', outside = join(temp, 'other');
  await write(join(cwd, '.omino.json'), { project: id });
  await write(join(outside, 'view.html'), 'outside');
  await mkdir(projectsDir, { recursive: true });
  await symlink(outside, join(projectsDir, id), 'dir');
  expect(await ids([cwd])).toEqual([]);
  await rm(join(projectsDir, id));
  await mkdir(join(projectsDir, id));
  await write(join(outside, '.paths.json'), { [cwd]: true });
  await symlink(join(outside, '.paths.json'), join(projectsDir, id, '.paths.json'));
  for (const file of ['summary.json', 'view.html']) await symlink(join(outside, 'view.html'), join(projectsDir, id, file));
  const reader = plans();
  expect((await reader.list(section, [project([cwd])])).projects[0].files[0]).toMatchObject({ needsUpdate: true, viewUrl: null });
  expect(await reader.view(section, project([cwd]), id)).toBeNull();
  await rm(join(cwd, '.omino.json'));
  expect(await ids([cwd])).toEqual([]);
});

it('reuses unchanged summaries and notices replacements with the same mtime and size', async () => {
  const id = 'todo-app', summary = join(projectsDir, id, 'summary.json'), fixedTime = new Date('2026-01-01');
  const payload = (title: string) => JSON.stringify({ format: 'omino-summary', version: 1, title });
  await write(join(cwd, '.omino.json'), { project: id });
  await write(summary, payload('First'));
  await utimes(summary, fixedTime, fixedTime);
  const reader = plans(), get = async () => (await reader.list(section, [project([cwd])])).projects[0].files[0];
  const parse = vi.spyOn(JSON, 'parse');
  try {
    expect((await get()).title).toBe('First');
    expect((await get()).title).toBe('First');
    expect(parse.mock.calls.filter(([text]) => text === payload('First'))).toHaveLength(1);
    await write(summary + '.tmp', payload('Later'));
    await utimes(summary + '.tmp', fixedTime, fixedTime);
    await rename(summary + '.tmp', summary);
    expect((await get()).title).toBe('Later');
    await rm(summary);
    expect(await get()).toMatchObject({ title: id, needsUpdate: true, modifiedAt: null });
  } finally { parse.mockRestore(); }
});

it('serves only the declared workspace HTML, including nested files and project-scoped workspaces', async () => {
  const report = { ...section, id: 'report', source: { kind: 'workspace', file: 'docs/summary.html' } } as const;
  const reader = createLibraryFiles(), todo = project([cwd]);
  const bytes = '<!doctype html><title>Project report</title>';
  await write(join(cwd, 'docs/summary.html'), bytes);
  await write(join(cwd, 'docs/other.html'), 'other');
  const data = await reader.list(report, [todo, project([temp], 'other')]);
  expect(data.projects).toHaveLength(1);
  expect(data.projects[0].files).toMatchObject([{ id: 'workspace-0', filename: 'summary.html', badge: 0, needsUpdate: false, modifiedAt: expect.any(Number) }]);
  const opened = await reader.view(report, todo, 'workspace-0');
  try { expect(await opened?.readFile('utf8')).toBe(bytes); } finally { await opened?.close(); }
  expect(await reader.view(report, todo, 'other.html')).toBeNull();
  expect(await reader.view(report, project([temp], 'wrong'), 'workspace-0')).toBeNull();
  const remote = { ...todo, workspaces: todo.workspaces!.map(w => ({...w, machineId:'away'})) };
  expect((await reader.list(report, [remote])).projects).toEqual([]);
  expect(await reader.view(report, remote, 'workspace-0')).toBeNull();
  await rm(join(cwd, 'docs'), { recursive: true });
  await write(join(temp, 'outside', 'summary.html'), bytes);
  await symlink(join(temp, 'outside'), join(cwd, 'docs'), 'dir');
  expect((await reader.list(report, [todo])).projects).toEqual([]);
  expect(await reader.view(report, todo, 'workspace-0')).toBeNull();
});

it('honors the selected collection namespace, optional summary and declared filenames', async () => {
  const reader = createLibraryFiles(), todo = project([cwd]);
  const report = { ...section, id: 'report', source: {kind:'collection', namespace:'reports', file:'overview.html'} } as const;
  const dir=join(temp,'reports','projects','weekly');
  vi.stubEnv('REPORTS_HOME',join(temp,'reports'));
  await write(join(cwd,'.reports.json'), {project:'weekly'});
  await write(join(dir,'overview.html'), '<p>Weekly</p>');
  await write(join(dir,'summary.json'), '{broken');
  expect((await reader.list(section,[todo])).projects).toEqual([]);
  expect((await reader.list(report,[todo])).projects[0].files).toMatchObject([{ id:'weekly', title:'weekly', filename:'overview.html', badge:0, needsUpdate:false }]);
  const otherMapping = { ...report, source: { ...report.source, summary: {
    file:'info.json', format:'weekly', version:3, title:'caption', badgeItems:'notices',
  } } };
  await write(join(dir,'info.json'), {format:'weekly',version:3,caption:'Weekly report',notices:[1,2,3]});
  expect((await reader.list(otherMapping,[todo])).projects[0].files).toMatchObject([{title:'Weekly report', badge:3}]);
  vi.stubEnv('REPORTS_HOME','relative');
  expect((await reader.list(report,[todo])).projects).toEqual([]);
});
