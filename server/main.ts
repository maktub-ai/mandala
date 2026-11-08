import { claimServiceHome } from './service-home-lock';
import { claimServiceRecord, handleServiceControl, removeServiceRecord } from '../desktop/service-discovery';
import { productEnv, productHome } from "../cli/product-env.mjs";
import { createMemoryRuntime } from "./memory-runtime";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createAutomations } from "./automations";
import { resolve } from "node:path";
import { readConfig } from "./config";
import { openStore } from "./store";
import { migrateWorkspace } from "./workspace-migrations";
import { createSessionManager } from "./sessions";
import { createSystemTasks } from "./system-tasks";
import { createHttpServer } from "./http";
import { createTelegramService } from "./telegram";
import { createTelegramWorkspace } from "./telegram-workspace";
import { createTerminals } from './terminals';
const home = resolve(
  productHome(),
);
const port = Number(productEnv('PORT') ?? 4317);
let startupStopRequested = false;
let desktopStop = () => { startupStopRequested = true; };
const persistentDesktop = process.env.MANDALA_DESKTOP_PERSIST === "1" && process.env.MANDALA_DESKTOP === "1";
if (process.send) {
  process.on("message", message => { if ((message as { type?: string })?.type === "mandala:stop") desktopStop(); });
  if (!persistentDesktop) {
    process.once("disconnect", () => desktopStop());
    if (!process.connected) process.exit(0);
  }
}
// Reserve the actual listener before configuration, migration or Store can write home.
const server = createServer((_req, res) => { res.writeHead(503); res.end("Starting"); });
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
});
const reservedPort = String((server.address() as { port: number }).port);
process.env.OPEN_MANA_PORT = reservedPort;
process.env.MANDALA_PORT = reservedPort;
const serviceHome=claimServiceHome(home);
process.once('exit',()=>{try{serviceHome.release();}catch{/* An unsafe replaced lock is never removed. */}});
const setupToken = process.env.MANDALA_DESKTOP === "1" ? randomBytes(32).toString("base64url") : undefined;
const serviceRecord = (persistentDesktop || Boolean(process.env.MANDALA_ACCOUNT_WORKER_KEY)) ? claimServiceRecord(home, `http://127.0.0.1:${reservedPort}`, setupToken!) : undefined;
await readConfig(home);
await migrateWorkspace(home, "apply");
const store = openStore(home);
const memoryRuntime = createMemoryRuntime({home,store,loadConfig:async()=>(await readConfig(home)).config,authorizeConversationRead:(_p,id)=>manager.authorizeConversationRead(id)});
const manager = createSessionManager(
  store,
  async () => (await readConfig(home)).config,
  undefined,
  undefined,
  home,
  (id, round) => { void systemTasks.onSettled(id, round).catch(() => {}); },
  id => { void systemTasks.onMessage(id).catch(() => {}); },
  memoryRuntime,
);
 await memoryRuntime.initialize();
 const systemTasks = createSystemTasks({ home, store, memoryRuntime, tasks:manager.taskService, loadConfig: async () => (await readConfig(home)).config });
memoryRuntime.start();
manager.fileMaintenance.start();
manager.knowledgeBase.start();
manager.codeGraph.start();
const automations = createAutomations({ home, store, manager, loadConfig: async () => (await readConfig(home)).config });
await manager.reconcileRuns('local');
await automations.list();
const terminalService = createTerminals();
const telegram=createTelegramService({home,store,workspace:createTelegramWorkspace(home,store,manager)});
const ready = createHttpServer({
  setupToken,
  requireIdentity: true,
  localOrigin: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
  terminals: terminalService,
  telegram,
  home,
  store,
  manager,
  systemTasks,
  automations,
  memoryRuntime,
  devOrigin:
    productEnv('DEV') === "1" ? "http://127.0.0.1:4174" : undefined,
});
server.on("close", () => ready.emit("close"));
server.removeAllListeners("request");
server.on("request", (req, res) => {
  if (serviceRecord && handleServiceControl(serviceRecord, req, res, () => { void stop(); })) return;
  ready.emit("request", req, res);
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  telegram.stop();
  terminalService.close();
  automations.close();
  systemTasks.close();
  await manager.fileMaintenance.close();
  await manager.knowledgeBase.close();
  await manager.close();
  await memoryRuntime.close();
  server.closeAllConnections();
  server.close(() => {
    store.close();
    serviceHome.release();
    if (serviceRecord) removeServiceRecord(home, serviceRecord);
    if (process.connected) process.disconnect();
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// IPC shutdown works on Windows and cancellation is retained throughout initialization.
desktopStop = () => { void stop(); };
if (startupStopRequested) await stop();
else {
  automations.start();
  telegram.start();
  console.log(`Mandala: http://127.0.0.1:${reservedPort}`);
  if (process.connected) process.send?.({ type: "mandala:ready", port: Number(reservedPort), setupToken });
}
