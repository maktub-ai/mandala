import { parseDocument } from "yaml";

export function validateManagedSkillContent(name: string, content: unknown): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) return "invalid Skill name";
  if (typeof content !== "string" || !content.trim() || content.length > 200000)
    return "Skill content must contain 1 to 200000 characters";
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header || header.length > 128000) return "invalid Skill metadata";
  try {
    const document = parseDocument(header, { uniqueKeys: true });
    if (document.errors.length) return "invalid Skill metadata";
    const value = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid Skill metadata";
    if (value.name !== name) return "Skill metadata name must match the registered name";
    if (typeof value.description !== "string" || !value.description.trim()) return "invalid Skill description";
  } catch { return "invalid Skill metadata"; }
}

// Host-only immutable resource descriptors; symbols never cross JSON/config boundaries.
export const skillResources = Symbol('skillResources');
export type SkillResource = { path:string; blobPath:string; executable:boolean };

export const skillIdentity = Symbol('skillIdentity');
