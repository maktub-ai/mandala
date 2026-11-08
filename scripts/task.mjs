#!/usr/bin/env node
// Task start and baseline guard. Every task must begin from the latest origin/main.
//   npm run task:start -- <name>   fetch, fast-forward main, create .development/<name> on <prefix><name>
//   npm run task:check             verify the current worktree starts from origin/main
// Flags: --no-fetch (use the last fetched origin/main), --allow-root-branch (task branch in the primary worktree,
// for environments that cannot use linked worktrees). Branch prefix: MANDALA_BRANCH_PREFIX (default "work/").
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [command = 'check', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(arg => arg.startsWith('--')));
const args = rest.filter(arg => !arg.startsWith('--'));
const prefix = process.env.MANDALA_BRANCH_PREFIX ?? 'work/';

const git = (gitArgs, cwd = process.cwd()) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (gitArgs, cwd) => { try { return git(gitArgs, cwd); } catch { return null; } };
const isAncestor = (a, b, cwd) => tryGit(['merge-base', '--is-ancestor', a, b], cwd) !== null;
const count = (range, cwd) => Number(git(['rev-list', '--count', range], cwd));
const short = sha => sha?.slice(0, 7) ?? '—';
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };

function context(cwd = process.cwd()) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!top) fail('当前目录不是 git 工作树。');
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], top);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], top);
  return { top, isPrimary: gitDir === common, primaryRoot: dirname(common), branch: git(['branch', '--show-current'], top) };
}

function fetchMain(top) {
  if (flags.has('--no-fetch')) return false;
  return tryGit(['fetch', '--quiet', 'origin', 'main'], top) !== null;
}

function mainWorktree(top) {
  const blocks = git(['worktree', 'list', '--porcelain'], top).split('\n\n');
  const block = blocks.find(entry => entry.split('\n').includes('branch refs/heads/main'));
  return block ? block.split('\n')[0].replace(/^worktree /, '') : null;
}

function check({ quiet = false } = {}) {
  const { top, isPrimary, branch } = context();
  const fetched = fetchMain(top);
  const errors = [], warnings = [];
  const origin = tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], top);
  if (!origin) fail('找不到 origin/main，先执行 git fetch origin main。');
  const local = tryGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], top);
  const head = git(['rev-parse', 'HEAD'], top);
  const originDate = git(['log', '-1', '--format=%ci', origin], top);
  if (!fetched && !flags.has('--no-fetch')) warnings.push(`无法连接 origin，下面按本地记录的 origin/main（${originDate}）判断；联网后再确认一次。`);

  if (local && local !== origin) {
    if (isAncestor(local, origin, top)) errors.push(`本地 main 落后 origin/main ${count(`${local}..${origin}`, top)} 个提交：在 main 所在工作树执行 git merge --ff-only origin/main。`);
    else if (isAncestor(origin, local, top)) warnings.push(`本地 main 有 ${count(`${origin}..${local}`, top)} 个提交尚未推送：推送 origin main 并核对远端 SHA 后才算交付。`);
    else errors.push('本地 main 与 origin/main 已分叉：先查明原因，不要 reset 或强推。');
  }
  if (!branch) errors.push('当前是 detached HEAD：任务必须在从最新 main 新建的分支上进行。');
  else if (branch !== 'main') {
    const own = count(`${origin}..HEAD`, top), behind = count(`HEAD..${origin}`, top);
    if (isPrimary && !flags.has('--allow-root-branch')) errors.push(`根目录工作树应始终停在 main 上，当前是 ${branch}。新任务用 npm run task:start -- <名称> 创建独立 worktree。`);
    if (behind > 0 && own === 0) errors.push(`${branch} 没有自己的提交，却落后 origin/main ${behind} 个提交：这是旧分支或已交付分支，不要复用，从最新 main 重新开始。`);
    else if (behind > 0) warnings.push(`main 在本分支开出后又前进了 ${behind} 个提交：交付前先合入 origin/main 再验证。`);
  } else if (isPrimary && git(['status', '--porcelain', '--untracked-files=no'], top)) {
    warnings.push('根目录 main 有未提交的改动：改动应在任务分支上进行。');
  }

  if (!quiet || errors.length || warnings.length) {
    console.log(`工作树  ${top}${isPrimary ? '（根目录）' : ''}`);
    console.log(`分支    ${branch || '(detached)'} @ ${short(head)}`);
    console.log(`origin/main ${short(origin)}  ${originDate}${fetched ? '' : '（未联网获取）'}`);
  }
  for (const message of warnings) console.warn(`! ${message}`);
  for (const message of errors) console.error(`✗ ${message}`);
  if (errors.length) process.exit(1);
  if (!quiet) console.log('✓ 起点正确，可以开始。');
}

function start() {
  const name = args[0];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('用法：npm run task:start -- <名称>，名称只用小写字母、数字和连字符。');
  const { top, primaryRoot } = context();
  if (!fetchMain(top) && !flags.has('--no-fetch')) fail('无法获取 origin/main。联网后重试；确认本地记录已是最新时可加 --no-fetch。');
  const origin = git(['rev-parse', 'refs/remotes/origin/main'], top);
  const local = tryGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], top);
  if (local && local !== origin) {
    if (isAncestor(origin, local, top)) fail(`本地 main 有 ${count(`${origin}..${local}`, top)} 个提交尚未推送：先推送 origin main，再开始新任务。`);
    if (!isAncestor(local, origin, top)) fail('本地 main 与 origin/main 已分叉：先查明原因，不要 reset 或强推。');
    const holder = mainWorktree(top);
    if (holder) git(['merge', '--ff-only', 'origin/main'], holder);
    else git(['update-ref', 'refs/heads/main', origin, local], top);
    console.log(`main 已快进到 ${short(origin)}`);
  }
  const branch = `${prefix}${name}`, path = join(primaryRoot, '.development', name);
  if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top)) fail(`分支 ${branch} 已存在：已交付的分支不复用，换一个任务名。`);
  if (existsSync(path)) fail(`${path} 已存在。`);
  git(['worktree', 'add', '-b', branch, path, 'main'], top);
  console.log(`✓ 已从 main ${short(origin)} 创建 ${branch}\n  工作树：${path}`);
}

if (command === 'check') check();
else if (command === 'start') start();
else fail(`未知命令 ${command}：可用 start、check。`);
