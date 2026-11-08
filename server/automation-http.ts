import type { IncomingMessage, ServerResponse } from "node:http";
import type { Automations } from "./automations";

export async function handleAutomationRequest(req: IncomingMessage, res: ServerResponse, url: URL,
  service: Automations | undefined, readBody: (req: IncomingMessage) => Promise<unknown>): Promise<boolean> {
  const match=url.pathname.match(/^\/api\/automations(?:\/([a-zA-Z0-9_-]+)(?:\/(run|stop|catch-up))?)?$/);
  if (!match) return false;
  if (!service) {res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"Automations unavailable"}));return true;}
  const [,id,action]=match;let data: unknown, status=200;
  if (!id && req.method === "GET") data=await service.list();
  else if (!id && req.method === "POST") {data=await service.create(await readBody(req),req.headers["idempotency-key"] as string|undefined);status=201;}
  else if (id && !action && req.method === "PATCH") data=await service.update(id,await readBody(req));
  else if (id && !action && req.method === "DELETE") {await service.remove(id,(await readBody(req) as {expectedRevision:number}).expectedRevision);data={ok:true};}
  else if (id && action === "run" && req.method === "POST") {data=await service.runNow(id,req.headers["idempotency-key"] as string|undefined);status=202;}
  else if (id && action === "catch-up" && req.method === "POST") {data=await service.catchUp(id,req.headers["idempotency-key"] as string??id);status=202;}
  else if (id && action === "stop" && req.method === "POST") data=await service.stopRun(id);
  else {status=405;data={error:"Method not allowed"};}
  res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));return true;
}
