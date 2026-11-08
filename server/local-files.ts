import { MAX_FILE_REFERENCE_BATCH, MAX_FILE_REFERENCE_BODY_BYTES, isConcreteLocalFileReference, isRelativeLocalFileReference, messageFileLinks, withoutFileLine } from "../shared/local-file-links";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../shared/workspace-contracts";

const LIMIT = 1024 * 1024;
export function localFilePath(href: string, cwd?: string) {
  try {
    const value = withoutFileLine(href);
    const path = value.startsWith("file://") ? fileURLToPath(value) : decodeURIComponent(value);
    if (path.includes("\0") || path.length > 4096) throw new Error();
    if (!isAbsolute(path)) {
      if (!cwd || !isAbsolute(cwd) || !isRelativeLocalFileReference(href)) throw new Error();
      return resolve(cwd, path);
    }
    if (path.startsWith('//')) throw new Error();
    return resolve(path);
  } catch { throw new DomainError("invalid_file_path", 400, "Invalid local file path"); }
}

export function linkedLocalFiles(text: string, cwd?: string) {
  const paths: string[] = [];
  for (const link of messageFileLinks(text)) { try { paths.push(localFilePath(link.href, cwd)); } catch { /* Web links are not local files. */ } }
  return paths;
}

async function openScopedLocalFile(href: string, roots: string[], linked = false, cwd?: string) {
  const requested = localFilePath(href, cwd);
  const canonicalRoots = (await Promise.all(roots.map(root => realpath(root).catch(() => null))))
    .filter((root): root is string => !!root);
  const inside = (path: string) => canonicalRoots.some(root => path.startsWith(root + sep));
  // Check the requested location first so an outside path does not disclose existence.
  const requestedRoots = [...roots.map(root => resolve(root)), ...canonicalRoots];
  if (!linked && !requestedRoots.some(root => requested.startsWith(root + sep))) throw new DomainError("file_scope", 403, "File is outside this chat's preview scope");
  let path: string;
  try { path = await realpath(requested); } catch { throw new DomainError("file_missing", 404, "Local file is unavailable"); }
  // A stored chat link grants access to this exact file, never a symlink's outside target.
  if (!inside(path) && !(linked && path === requested)) throw new DomainError("file_scope", 403, "File is outside this chat's preview scope");
  const parts = path.toLowerCase().split(sep);
  if (parts.some((part, index) => [".ssh", ".aws", ".git", ".config"].includes(part) || part === ".codex" && parts[index + 1] !== "worktrees") || /^(?:\.env(?:\..*)?|auth\.json|credentials|id_rsa|id_ed25519)$/i.test(basename(path)))
    throw new DomainError("file_scope", 403, "File is outside this chat's preview scope");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new DomainError("file_missing", 404, "Local file is unavailable");
  });
  return { handle, path, requested };
}

export async function readLocalFilePreview(href: string, roots: string[], linked = false, cwd?: string) {
  const { handle, path, requested } = await openScopedLocalFile(href, roots, linked, cwd);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new DomainError("file_type", 415, "Only text files can be previewed here");
    if (before.size > LIMIT) throw new DomainError("file_size", 413, "File is too large to preview");
    const buffer = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat(), location = await realpath(requested), current = await stat(location);
    if (location !== path || current.dev !== before.dev || current.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || size !== before.size)
      throw new DomainError("file_changed", 409, "File changed while loading; open it again");
    let text: string;
    try {
      if (buffer.subarray(0, size).includes(0)) throw new Error();
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch { throw new DomainError("file_type", 415, "Only text files can be previewed here"); }
    return { name: basename(path), path, text };
  } finally { await handle.close(); }
}

// Resolve a whole transcript batch without reading file contents. Preview rechecks the
// same scope and descriptor after the user opens the delivered file.
export async function resolveConversationLocalFiles(hrefs: unknown, scope: {
  cwd: string; roots: string[]; linkedPaths: ReadonlySet<string>; absoluteLinkedPaths: ReadonlySet<string>;
}) {
  if (!Array.isArray(hrefs) || hrefs.length > MAX_FILE_REFERENCE_BATCH || hrefs.some(href => typeof href !== 'string' || href.length > 4096) || Buffer.byteLength(JSON.stringify({ hrefs })) > MAX_FILE_REFERENCE_BODY_BYTES)
    throw new DomainError('invalid_file_paths', 400, 'File reference batch exceeds its count or size limit');
  const verified: string[] = [];
  for (const href of new Set<string>(hrefs)) {
    if (!isConcreteLocalFileReference(href)) continue;
    try {
      const target = localFilePath(href, scope.cwd);
      if (!scope.linkedPaths.has(target)) continue;
      const scoped = isRelativeLocalFileReference(href) || !scope.absoluteLinkedPaths.has(target);
      const { handle, path, requested } = await openScopedLocalFile(href, scoped ? [scope.cwd] : scope.roots, false, scope.cwd);
      try {
        const before = await handle.stat();
        const location = await realpath(requested), current = await stat(location);
        if (before.isFile() && location === path && before.dev === current.dev && before.ino === current.ino && before.ctimeMs === current.ctimeMs)
          verified.push(href);
      } finally { await handle.close(); }
    } catch (error) {
      // An unavailable, unsafe or unknown path remains ordinary message text.
      if (!(error instanceof DomainError) && !(error instanceof Error && 'code' in error)) throw error;
    }
  }
  return { hrefs: verified };
}
