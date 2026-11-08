import { productEnv } from "../cli/product-env.mjs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { readConfig, writeConfig } from "../server/config";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import { connectCodex, type CodexOptions } from "../server/codex";
import { createRpcClient } from "../server/rpc";
import { approvalChoices } from "../shared/approvals";
const home = resolve(productEnv('HOME') ?? "");
if (!productEnv('HOME') || !home.startsWith(resolve(tmpdir()) + sep))
  throw new Error(
    "Set MANDALA_HOME to a new directory under the system temporary directory.",
  );
console.log(execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());
const initial = await readConfig(home);
await writeConfig(
  home,
  {
    version: 1,
    projects: [{ id: "reading", name: "Personal reading list", cwd: "" }],
    agents: [
      {
        id: "developer",
        name: "Developer",
        instructions:
          "Use only the temporary personal sample. Do not read personal files or credentials.",
        defaultCli: "codex",
        models: {},
      },
    ],
  },
  initial.revision,
);
const store = openStore(home),
  load = async () => (await readConfig(home)).config;
let manager = createSessionManager(store, load);
const wait = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 120000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const done = (id: string) =>
  !["running", "approval"].includes(store.getConversation(id)!.status);
const text = (id: string) =>
  store
    .listEvents(id, 0)
    .filter((e) => e.kind === "text")
    .map((e) => (e.data as { text: string }).text)
    .join("");
try {
  const models = await manager.listModels("reading");
  if (!models.length) throw new Error("Native model catalog is empty");
  const model = models[0].id;
  console.log("Native catalog model: " + model);
  const chat = await manager.create("reading", "developer", model);
  await manager.send(
    chat.id,
    "Do not use tools. Reply exactly: MANDALA_SMOKE_OK",
  );
  await wait(() => done(chat.id), "first answer");
  if (!text(chat.id).includes("MANDALA_SMOKE_OK"))
    throw new Error("No expected real model output; inspect the local events.");
  const nativeId = store.getConversation(chat.id)!.nativeId;
  console.log("PASS real output; native thread " + nativeId);
  await manager.close();
  manager = createSessionManager(store, load);
  await manager.continue(
    chat.id,
    "Do not use tools. Reply exactly: MANDALA_RESUME_OK",
  );
  await wait(() => done(chat.id), "resume answer");
  if (
    store.getConversation(chat.id)!.nativeId !== nativeId ||
    !text(chat.id).includes("MANDALA_RESUME_OK")
  )
    throw new Error("Native thread recovery failed");
  console.log("PASS same-thread recovery");
  await manager.send(
    chat.id,
    "Without tools, write 1000 numbered sentences explaining a personal reading list.",
  );
  await manager.stop(chat.id);
  await wait(() => done(chat.id), "interrupt");
  if (store.getConversation(chat.id)!.status !== "interrupted")
    throw new Error("Stop did not interrupt the native turn");
  console.log("PASS native turn interrupt");
  await manager.close();
  // This isolated acceptance thread is deliberately stricter than the normal inherited policy.
  const approvalFactory = async (options: CodexOptions) => {
    const rpc = createRpcClient(
      spawn("codex", ["app-server", "--stdio"], {
        cwd: options.cwd,
        stdio: "pipe",
        shell: false,
      }),
      {
        onNotification: options.onEvent,
        onRequest: options.onApproval,
        onExit: options.onExit,
      },
    );
    const client = await connectCodex(rpc);
    return {
      ...client,
      startThread: async ({
        cwd,
        instructions,
        model,
      }: {
        cwd: string;
        instructions: string;
        model?: string;
      }) =>
        (
          await rpc.request("thread/start", {
            cwd,
            model,
            developerInstructions: instructions,
            approvalPolicy: "untrusted",
            sandbox: "read-only",
            ephemeral: false,
          })
        ).thread.id as string,
    };
  };
  manager = createSessionManager(store, load, approvalFactory);
  const approvalChat = await manager.create("reading", "developer", model);
  await manager.send(
    approvalChat.id,
    "Execute this harmless command with the command tool: printf MANDALA_APPROVAL_TEST. Do not read files or run any other command.",
  );
  await wait(
    () =>
      manager.getApprovals(approvalChat.id).length > 0 || done(approvalChat.id),
    "native approval",
  );
  const approval = manager.getApprovals(approvalChat.id)[0];
  if (!approval)
    throw new Error("Real approval was not triggered; it remains unverified.");
  const choices=approvalChoices(approval);
  const decline=choices.includes("reject")?"reject":choices.includes("reject-stop")?"reject-stop":null;
  console.log("Native approval choices: "+JSON.stringify(choices));
  if(!decline)throw new Error("Native approval has no supported decline; remains unverified");
  await manager.approve(approvalChat.id, approval.id, decline);
  await wait(() => done(approvalChat.id), "approval decline");
  console.log(
    "PASS native approval request and explicit decline; no command approved",
  );
} finally {
  await manager.close();
  store.close();
}
