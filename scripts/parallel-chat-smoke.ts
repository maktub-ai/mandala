import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import { startCodex } from "../server/codex";

const home = await mkdtemp(join(tmpdir(), "mana-parallel-smoke-"));
const store = openStore(home);
let holdingThread: string | undefined;
const manager = createSessionManager(store, async () => ({
  version: 2,
  projects: [{ id: "sample", name: "Synthetic sample", cwd: home, agentIds: ["sample"], resources: [], mcp: [], skills: [] }],
  agents: [{ id: "sample", name: "Synthetic sample", defaultCli: "codex", models: {}, mcp: [], skills: [],
    instructions: "Use only this temporary synthetic sample. Do not read personal files or credentials.",
    runtime: { codex: { approvalMode: "auto" } } }],
}), options => startCodex({ ...options, onEvent: event => {
  if (event.method === "item/started" && event.params?.item?.type === "commandExecution" &&
      /sleep 45/.test(event.params.item.command ?? "")) holdingThread = event.params.threadId;
  options.onEvent(event);
} }), undefined, home);
const wait = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out: " + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
let firstId: string | undefined;
try {
  const model = (await manager.listModels("sample"))[0];
  if (!model) throw new Error("Native model catalog is empty");
  const environment = { effort: model.supportedReasoningEfforts?.includes("low") ? "low" as const : model.defaultReasoningEffort };
  const first = await manager.create("sample", "sample", model.id, "codex", environment);
  const second = await manager.create("sample", "sample", model.id, "codex", environment);
  firstId = first.id;
  await manager.send(first.id, "For this concurrency test, execute exactly `sleep 45` with the command tool, then reply HOLD_DONE. Do not read files or use any other tools.");
  await wait(() => holdingThread === store.getConversation(first.id)?.nativeId, "first native command starts");
  if (store.getConversation(first.id)?.status !== "running") throw new Error("First conversation is not running");
  const input = manager.enqueueUserInput(second.id, "Do not use tools. Reply exactly: PARALLEL_CHAT_OK", "parallel-smoke");
  await wait(() => manager.listUserInputs(second.id).find(item => item.id === input.id)?.state === "completed", "second conversation completes independently");
  const one = store.getConversation(first.id)!, two = store.getConversation(second.id)!;
  const answer = store.listEvents(second.id, 0).filter(event => event.kind === "text")
    .map(event => (event.data as { text: string }).text).join("");
  if (one.status !== "running" || one.nativeId === two.nativeId || !answer.includes("PARALLEL_CHAT_OK"))
    throw new Error("Second conversation did not answer while the first was still running");
  console.log("PASS real Codex: same Agent and directory, distinct native threads, second reply while first still running; model=" + model.id);
} finally {
  try { if (firstId) await manager.stop(firstId); }
  finally { await manager.close(); store.close(); await rm(home, { recursive: true, force: true }); }
}
