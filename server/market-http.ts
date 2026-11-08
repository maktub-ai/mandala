import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "./http-body";
import type { Market } from "./market";
import type { MarketKind } from "../shared/market";

export async function handleMarketRequest(req: IncomingMessage, res: ServerResponse, url: URL, market: Market,
  readBody: (req: IncomingMessage) => Promise<unknown>): Promise<boolean> {
  if (!url.pathname.startsWith("/api/market/")) return false;
  const path = url.pathname.slice("/api/market".length);
  const match = path.match(/^\/installed\/(market-[a-f0-9]{20})\/(unlink|uninstall)$/);
  const read = async <T>(operation: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try { return await operation(controller.signal); }
    finally { res.off("close", cancel); }
  };
  let data: unknown, status = 200;
  if (path === "/extensions" && req.method === "GET") data = await market.extensions.read();
  else if (["/extensions/install", "/extensions/uninstall"].includes(path) && req.method === "POST") {
    const body = await readBody(req) as Record<string, unknown>;
    if (!body || typeof body.catalogId !== 'string' || typeof body.revision !== 'string') throw Error('invalid extension request');
    if (path.endsWith('/uninstall')) data = await market.extensions.uninstall(body.catalogId, body.revision);
    else {
      if (typeof body.version !== 'string' || typeof body.digest !== 'string') throw Error('invalid extension request');
      data = await market.extensions.install({ catalogId: body.catalogId, revision: body.revision, version: body.version, digest: body.digest }); status = 201;
    }
  }
  else if (path === "/extensions/import-pet" && req.method === "POST") {
    // Pet images make these packages larger than ordinary requests, so this route reads its own bounded body.
    const body = await readJsonBody(req, { maxBytes: 6 * 1024 * 1024, contentTypeError: 'invalid content type', sizeError: 'invalid pet package size', jsonError: 'invalid JSON' }) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['raw', 'revision'].includes(key)) || typeof body.raw !== 'string' || typeof body.revision !== 'string') throw Error('invalid extension request');
    data = await market.extensions.importPet({ raw: body.raw, revision: body.revision }); status = 201;
  }
  else if (path === "/sources" && req.method === "GET") data = await market.sources();
  else if (path === "/sources" && req.method === "PUT") {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid market sources");
    data = await market.saveSources(body as Parameters<Market["saveSources"]>[0]);
  }
  else if (path === "/search" && req.method === "GET") data = await read(signal => market.search(url.searchParams.get("kind") as MarketKind,
    url.searchParams.get("query") ?? "", url.searchParams.get("cursor") ?? "", url.searchParams.get("source") ?? undefined, url.searchParams.get("sort") ?? undefined, signal));
  else if (path === "/detail" && req.method === "GET") data = await read(signal => market.detail(url.searchParams.get("catalogId") ?? "", signal));
  else if (path === "/installed" && req.method === "GET") data = await market.installed();
  else if (req.method === "POST" && (path === "/install" || match)) {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid market request");
    const b = body as Record<string, any>;
    if (typeof b.revision !== "string" || !b.revision) throw new Error("invalid configuration revision");
    if (path === "/install") {
      if (typeof b.catalogId !== "string" || typeof b.version !== "string") throw new Error("invalid market install");
      data = await market.install({ catalogId: b.catalogId, version: b.version, revision: b.revision, targets: b.targets, environment: b.environment }); status = 201;
    } else {
      if (match![2] === "unlink") await market.unlink(match![1], b.target, b.revision);
      else await market.uninstall(match![1], b.revision);
      data = { ok: true };
    }
  } else { status = 404; data = { error: "Market route not found" }; }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); return true;
}
