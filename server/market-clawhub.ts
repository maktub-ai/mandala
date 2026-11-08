import { createHash } from "node:crypto";
import { fromBuffer, type Entry } from "yauzl";
import { sortMarketItems, type MarketSort, type MarketDetail, type MarketItem } from "../shared/market";
import { marketBytes, safeMarketPath, skillHeader, type MarketFetcher } from "./market-source";

const base = "https://clawhub.ai/api/v1";
type File = { path: string; size: number; sha256: string };
const identity = (id: string) => {
  const match = id.match(/^skill:clawhub\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})$/);
  if (!match) throw new Error("invalid ClawHub identity"); return { owner: match[1], slug: match[2] };
};
export function createClawHub(fetcher: MarketFetcher, json: (url: string, signal?: AbortSignal) => Promise<any>) {
  const manifests = new Map<string, File[]>();
  const item = (entry: any): MarketItem => {
    const owner = entry.ownerHandle ?? entry.owner?.handle, slug = entry.slug;
    const catalogId = `skill:clawhub/${owner}/${slug}`; identity(catalogId);
    const rawStats = entry.stats ?? entry.native?.skill?.stats ?? {};
    const stats = Object.fromEntries((["downloads", "stars", "installs", "comments"] as const).map(key => [key, rawStats[key] ?? (key === "downloads" ? entry.downloads : undefined)])
      .filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
    const updatedAt = entry.updatedAt ?? entry.native?.skill?.updatedAt;
    return { catalogId, name: slug, kind: "skill", description: typeof entry.summary === "string" ? entry.summary.slice(0, 5000) : "",
      version: entry.latestVersion?.version ?? (typeof entry.version === "string" ? entry.version : ""), publisher: owner,
      sourceUrl: `https://clawhub.ai/${owner}/skills/${slug}`, ...(Object.keys(stats).length ? { stats } : {}),
      ...(Number.isSafeInteger(updatedAt) && updatedAt > 0 && updatedAt <= 8640000000000000 ? { updatedAt } : {}) };
  };
  const search = async (query: string, cursor: string, sort: MarketSort, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: "24", nonSuspiciousOnly: "true" });
    if (query) params.set("q", query); else { params.set("sort", sort === "default" ? "updated" : sort); if (cursor) params.set("cursor", cursor); }
    const result = await json(`${base}/${query ? "search" : "skills"}?${params}`, signal);
    const entries = query ? result.results : result.items;
    if (!Array.isArray(entries) || entries.length > 200) throw new Error("invalid ClawHub directory response");
    return { items: sortMarketItems(entries.filter(entry => (!entry.source || entry.source === "clawhub") && (!entry.trust || entry.trust.installability === "installable")).map(item), sort),
      ...(!query && typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}) };
  };
  const versionFiles = async (catalogId: string, version: string, signal?: AbortSignal) => {
    const { owner, slug } = identity(catalogId), params = new URLSearchParams({ owner });
    const result = await json(`${base}/skills/${slug}/versions/${encodeURIComponent(version)}?${params}`, signal);
    if (result.version?.version !== version || !Array.isArray(result.version.files)) throw new Error("invalid ClawHub version response");
    const files: File[] = result.version.files;
    const seen = new Set<string>();
    if (!files.length || files.length > 200 || !files.some(file => file.path === "SKILL.md") || files.some(file => {
      if (typeof file.path !== "string" || !safeMarketPath(file.path) ||
          !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 10 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) return true;
      const folded = file.path.normalize("NFC").toLowerCase(); if (seen.has(folded)) return true; seen.add(folded); return false;
    }) || files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new Error("invalid ClawHub package files");
    // ClawHub replaces _meta.json with generated registry metadata in the download.
    const contentFiles = files.filter(file => file.path !== "_meta.json");
    manifests.set(catalogId + ":" + version, contentFiles);
    return { files: contentFiles, security: result.version.security?.status };
  };
  const detail = async (catalogId: string, signal?: AbortSignal): Promise<MarketDetail> => {
    const { owner, slug } = identity(catalogId);
    const result = await json(`${base}/skills/${slug}?${new URLSearchParams({ owner })}`, signal);
    if (result.owner?.handle !== owner || result.skill?.slug !== slug || typeof result.latestVersion?.version !== "string" || !result.latestVersion.version || result.latestVersion.version.length > 100)
      throw new Error("invalid ClawHub identity or version");
    const version = result.latestVersion.version, { files, security } = await versionFiles(catalogId, version, signal);
    const readme = (await marketBytes(await fetcher(`${base}/skills/${slug}/file?${new URLSearchParams({ owner, version, path: "SKILL.md" })}`, signal))).toString("utf8");
    if (createHash("sha256").update(readme).digest("hex") !== files.find(file => file.path === "SKILL.md")!.sha256) throw new Error("invalid ClawHub file integrity");
    let header: ReturnType<typeof skillHeader> | undefined;
    try { header = skillHeader(readme); } catch { /* Invalid metadata must not hide the verified source contents. */ }
    const unsupported = ["malicious", "suspicious", "blocked"].includes(security) || result.moderation?.isSuspicious || result.moderation?.isMalwareBlocked
      ? "unsupported ClawHub security status" : !header ? "unsupported ClawHub Skill metadata" : undefined;
    return { ...item({ ...result.skill, ownerHandle: owner, latestVersion: result.latestVersion }), ...header, readme, fileCount: files.length,
      ...(unsupported ? { unsupported } : {}) };
  };
  const download = async (info: MarketDetail) => {
    const { owner, slug } = identity(info.catalogId);
    const files = manifests.get(info.catalogId + ":" + info.version) ?? (await versionFiles(info.catalogId, info.version)).files;
    const data = await marketBytes(await fetcher(`${base}/download?${new URLSearchParams({ slug, owner, version: info.version })}`), 40 * 1024 * 1024);
    if (data[0] === 123) throw new Error("unsupported ClawHub GitHub handoff; inspect the source directory");
    return await new Promise<{ path: string; data: Buffer; executable: boolean }[]>((resolve, reject) => {
      fromBuffer(data, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
        if (error || !zip) { reject(new Error("invalid ClawHub archive")); return; }
        const output: { path: string; data: Buffer; executable: boolean }[] = [], seen = new Set<string>(); let count = 0;
        const fail = () => { zip.close(); reject(new Error("invalid ClawHub archive or file integrity")); };
        zip.on("error", fail);
        zip.on("entry", (entry: Entry) => {
          const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000;
          if (++count > 201 || !safeMarketPath(entry.fileName) || (type !== 0 && type !== 0o100000) || entry.isEncrypted()) { fail(); return; }
          const file = files.find(file => file.path === entry.fileName);
          if (seen.has(entry.fileName) || (!file && entry.fileName !== "_meta.json") || entry.uncompressedSize > 10 * 1024 * 1024 ||
              (file && entry.uncompressedSize !== file.size) || (!file && entry.uncompressedSize > 10000)) { fail(); return; }
          seen.add(entry.fileName);
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) { fail(); return; }
            const parts: Buffer[] = []; let size = 0;
            stream.on("error", fail);
            stream.on("data", (part: Buffer) => { size += part.length; if (size > entry.uncompressedSize) { stream.destroy(); fail(); } else parts.push(part); });
            stream.on("end", () => {
              const value = Buffer.concat(parts);
              if (size !== entry.uncompressedSize || file && createHash("sha256").update(value).digest("hex") !== file.sha256) { fail(); return; }
              if (file) output.push({ path: file.path, data: value, executable: !!(mode & 0o111) });
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => { if (output.length !== files.length) fail(); else resolve(output); });
        zip.readEntry();
      });
    });
  };
  return { search, detail, download };
}
