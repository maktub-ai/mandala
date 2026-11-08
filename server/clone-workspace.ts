import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../shared/types";

const exec = promisify(execFile);

function remoteUrl(value: unknown): { url: string; name: string; ssh: boolean } {
  const invalid = () => { throw new Error("invalid repository URL"); };
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\;`$<>|&?#\x00-\x1f]/.test(value)) return invalid();
  let path: string, ssh = false;
  const scp = value.match(/^[A-Za-z0-9_][A-Za-z0-9_.-]*@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9_~][A-Za-z0-9_./~%+-]*)$/);
  if (scp) { path = scp[2]; ssh = true; }
  else {
    if (!/^(https|ssh):\/\//.test(value)) return invalid();
    let parsed: URL;
    try { parsed = new URL(value); } catch { return invalid(); }
    ssh = parsed.protocol === "ssh:";
    if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || parsed.hostname.startsWith("-") ||
        parsed.search || parsed.hash || parsed.password || (!ssh && parsed.username) ||
        (ssh && parsed.username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(parsed.username)) ||
        !/^\/[A-Za-z0-9_./~%+-]*$/.test(parsed.pathname)) return invalid();
    path = parsed.pathname;
  }
  try { if (/[\s\\;`$<>|&\x00-\x1f]/.test(decodeURIComponent(path))) return invalid(); } catch { return invalid(); }
  const name = path.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/, "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 70) || "repository";
  return { url: value, name, ssh };
}

export async function cloneProjectWorkspace(home: string, project: { id: string; cwd: string }, url: unknown): Promise<Workspace> {
  const remote = remoteUrl(url);
  if (!project || !/^[A-Za-z0-9_-]{1,100}$/.test(project.id) || typeof project.cwd !== "string" ||
      (project.cwd && !isAbsolute(project.cwd)) || !isAbsolute(home)) throw new Error("invalid clone workspace");
  const base = project.cwd || join(home, "workspaces", project.id);
  if (project.cwd) {
    if (!(await stat(base)).isDirectory()) throw new Error("invalid workspace directory");
  } else await mkdir(base, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(base, `${remote.name}-`));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"])
    delete env[key as keyof typeof env];
  const options = { cwd, env, timeout: 120_000, killSignal: "SIGKILL" as const, maxBuffer: 1024 * 1024, windowsHide: true };
  const config = async (args: string[]) => {
    try { return (await exec("git", ["config", ...args], options)).stdout.trim(); }
    catch (error) { if ((error as { code?: number }).code === 1) return ""; throw error; }
  };
  try {
    // Keep native authentication, but do not execute checkout hooks or configured filters during a clone.
    const args = ["-c", `core.hooksPath=${devNull}`, "-c", `core.attributesFile=${devNull}`,
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
      "-c", "credential.interactive=false"];
    const filters = await config(["--null", "--name-only", "--get-regexp", "^filter\\..*\\.(smudge|process|required)$"]);
    for (const key of filters.split("\0").filter(Boolean)) args.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    if (remote.ssh) {
      const sshCommand = process.env.GIT_SSH_COMMAND || await config(["--get", "core.sshCommand"]) || "ssh";
      Object.assign(env, { GIT_SSH_COMMAND: `${sshCommand} -oBatchMode=yes -oStrictHostKeyChecking=yes` });
    }
    await exec("git", [...args, "clone", "--template=", "--", remote.url, cwd], options);
    return { id: `clone-${randomUUID()}`, name: remote.name, cwd,
      resources: [{ id: `source-${randomUUID()}`, label: remote.name, kind: "remote-git", location: remote.url }] };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("git is not installed");
    throw new Error("git clone failed; check the repository URL, network, and native Git authentication");
  }
}
