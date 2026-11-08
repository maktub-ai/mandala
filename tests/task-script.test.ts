import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = resolve("scripts/task.mjs");
let root = "", repo = "", origin = "";
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const run = (args: string[], cwd = repo) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, MANDALA_BRANCH_PREFIX: "t/" } });
const commit = (cwd: string, message: string) => { writeFileSync(join(cwd, `${message}.txt`), message); git(["add", "."], cwd); git(["commit", "-qm", message], cwd); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mandala-task-"));
  origin = join(root, "origin.git"); repo = join(root, "repo");
  git(["init", "-q", "--bare", "-b", "main", origin], root);
  git(["clone", "-q", origin, repo], root);
  git(["config", "user.email", "test@example.com"]); git(["config", "user.name", "Test"]);
  commit(repo, "base"); git(["push", "-q", "origin", "main"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("accepts the primary worktree on the latest main", () => {
  const result = run(["check"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("起点正确");
});

it("rejects a task branch in the primary worktree unless explicitly allowed", () => {
  git(["switch", "-qc", "t/work"]);
  expect(run(["check"]).status).toBe(1);
  expect(run(["check", "--allow-root-branch"]).status).toBe(0);
});

it("rejects a stale branch without its own commits and a local main behind origin", () => {
  git(["switch", "-qc", "t/old"]); git(["switch", "-q", "main"]);
  const other = join(root, "other"); git(["clone", "-q", origin, other], root);
  git(["config", "user.email", "test@example.com"], other); git(["config", "user.name", "Test"], other);
  commit(other, "ahead"); git(["push", "-q", "origin", "main"], other);
  const behind = run(["check"]);
  expect(behind.status).toBe(1);
  expect(behind.stderr).toContain("本地 main 落后 origin/main 1 个提交");
  git(["merge", "-q", "--ff-only", "origin/main"]); git(["switch", "-q", "t/old"]);
  const stale = run(["check", "--allow-root-branch"]);
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain("旧分支或已交付分支");
});

it("starts a task worktree from the fast-forwarded main", () => {
  const other = join(root, "other"); git(["clone", "-q", origin, other], root);
  git(["config", "user.email", "test@example.com"], other); git(["config", "user.name", "Test"], other);
  commit(other, "ahead"); git(["push", "-q", "origin", "main"], other);
  const result = run(["start", "design-tokens"]);
  expect(result.status, result.stderr).toBe(0);
  const worktree = join(repo, ".development", "design-tokens");
  expect(existsSync(worktree)).toBe(true);
  expect(git(["rev-parse", "HEAD"], worktree)).toBe(git(["rev-parse", "origin/main"]));
  expect(git(["branch", "--show-current"], worktree)).toBe("t/design-tokens");
  expect(run(["check"], worktree).status).toBe(0);
  expect(run(["start", "design-tokens"]).status).toBe(1);
});

it("warns about unpushed main commits and refuses to start from them", () => {
  commit(repo, "local-only");
  const result = run(["check"]);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("1 个提交尚未推送");
  const start = run(["start", "next"]);
  expect(start.status).toBe(1);
  expect(start.stderr).toContain("先推送 origin main");
});
