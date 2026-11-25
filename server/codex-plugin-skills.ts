import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

// Legacy bindings identify a skill by marketplace/plugin/version/skills/name.
// Only the version can change when Codex replaces an installed package.
export async function resolveCodexPluginSkill(path: string): Promise<string> {
  if (!path) return path;
  const cache = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "plugins", "cache");
  const parts = relative(cache, path).split(sep);
  if (parts.length !== 5 || parts.some(part => !part || part.startsWith(".")) || parts[3] !== "skills") return path;
  const [market, plugin, , , skill] = parts;
  try {
    if ((await stat(join(path, "SKILL.md"))).isFile()) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return path;
  }

  try {
    const root = join(cache, market, plugin);
    const entries = await readdir(root, { withFileTypes: true });
    const versions = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
    const version = entries.find(entry => entry.name === "latest") ?? (versions.length === 1 ? versions[0] : undefined);
    if (!version) return path;

    const packageDir = await realpath(join(root, version.name));
    if (dirname(packageDir) !== join(await realpath(cache), market, plugin)) return path;
    const manifestPath = join(packageDir, ".codex-plugin", "plugin.json");
    if (await realpath(manifestPath) !== manifestPath) return path;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== plugin) return path;

    const entry = join(packageDir, "skills", skill, "SKILL.md");
    if (await realpath(entry) !== entry || !(await lstat(entry)).isFile()) return path;
    return join(root, basename(packageDir), "skills", skill);
  } catch {
    // An unavailable or partially installed plugin must not prevent loading the rest of the config.
    return path;
  }
}
