import { parseDocument } from "yaml";

export type MarketFetcher = (url: string, signal?: AbortSignal) => Promise<Response>;
export const safeMarketPath = (path: string) => path.split("/").every(part => !!part && part !== "." && part !== ".." && !/[\\\x00-\x1f:]/.test(part));
export async function marketBytes(response: Response, limit = 10 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Market source HTTP ${response.status}`); }
  if (!response.body) throw new Error("invalid market source response");
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > limit) throw new Error("invalid market source size"); parts.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}
export function skillHeader(readme: string) {
  const header = readme.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header || header.length > 128000) throw new Error("invalid Skill metadata");
  const document = parseDocument(header, { uniqueKeys: true });
  if (document.errors.length) throw new Error("invalid Skill metadata");
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.name)) throw new Error("invalid Skill name");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("invalid Skill description");
  const strings = (input: unknown): string[] => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string").slice(0, 50).map(item => item.slice(0, 200)) : [];
  const metadata = value.metadata?.openclaw ?? value.metadata?.clawdbot ?? {};
  return { name: value.name, description: typeof value.description === "string" ? value.description.trim().slice(0, 5000) : "",
    requirements: { binaries: [...strings(metadata.requires?.bins), ...strings(metadata.requires?.anyBins)], environment: strings(metadata.requires?.env), platforms: strings(metadata.os) } };
}
