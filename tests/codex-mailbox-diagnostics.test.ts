import { EventEmitter } from 'node:events';
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { codexMailboxSid, ownedPrivatePath } from "../cli/private-path.mjs";
import { startCodex } from "../server/codex";
import { createRpcClient } from "../server/rpc";
import type { RpcClient } from "../server/rpc";

vi.mock("../cli/private-path.mjs", () => ({ codexMailboxSid: vi.fn(), ownedPrivatePath: vi.fn(), protectInvocationDirectory: vi.fn() }));
const {helper}=vi.hoisted(()=>({helper:vi.fn()}));
vi.mock("../cli/windows-system.mjs",()=>({windowsSystemBinary:()=> 'synthetic-cmd.exe'}));
vi.mock("../server/native-spawn", () => ({
  spawn: vi.fn((_command: string, args: string[]) => {
    if (args[0] === "sandbox") return helper(...args);
    if (args[0] !== "app-server") throw new Error("Blocked unexpected test subprocess");
    return { stderr: new PassThrough() };
  }),
}));
vi.mock("../server/rpc", () => ({ createRpcClient: vi.fn() }));

it.skipIf(process.platform !== "win32").each([
  ["path", "codex_mailbox_path_invalid"],
  ["setup", "codex_mailbox_setup_failed"],
  ["setup-rejected", "codex_mailbox_setup_failed"],
  ["capability", "codex_mailbox_capability_unverified"],
  ["permissions", "codex_mailbox_permissions_unverified"],
  ["ready", undefined],
])("reports sanitized private mailbox preparation at %s before submitting a model turn", async (phase, code) => {
  const root = await mkdtemp(join(tmpdir(), "mandala-mailbox-diagnostics-"));
  try {
    const mailbox = join(root, "mailbox");
    if (phase === "path") await writeFile(mailbox, "inert");
    else await mkdir(mailbox);
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return { userAgent: "codex/0.167.0" };
      if (method === "config/read") return { config: { windows: { sandbox: "unelevated" } } };
      if (method === "thread/start") return {
        thread: { id: "synthetic-native" }, cwd: root,
        sandbox: { type: "workspaceWrite", writableRoots: [mailbox] },
      };
      if (method === "command/exec") {
        if (phase === "setup-rejected") throw new Error("PRIVATE_NATIVE_DIAGNOSTIC");
        return { exitCode: phase === "setup" ? 7 : 0 };
      }
      throw new Error("Blocked unexpected synthetic RPC");
    });
    vi.mocked(createRpcClient).mockReturnValue({ request, notify() {}, close() {} } as unknown as RpcClient);
    vi.mocked(codexMailboxSid).mockClear().mockResolvedValue(phase === "capability" ? undefined : "SYNTHETIC_SID");
    vi.mocked(ownedPrivatePath).mockClear().mockReturnValue(phase !== "permissions");
    const client = await startCodex({cwd: root, fullAccess: false, env: { CODEX_HOME: root }, onEvent() {}, onApproval() {}, onExit() {}});
    try {
      const started = client.startThread({cwd:root,instructions:"Synthetic",runtimeMailboxPath:mailbox});
      if (code) {
        const error: unknown = await started.catch(reason => reason);
        expect(error).toMatchObject({code,status:500});
        expect((error as Error).message).not.toMatch(/PRIVATE_NATIVE_DIAGNOSTIC|SYNTHETIC_SID/);
        expect((error as Error).message).not.toContain(root);
      } else expect(await started).toBe("synthetic-native");
      expect(request.mock.calls.flat()).not.toContain("turn/start");
      if (["path", "setup", "setup-rejected"].includes(phase)) expect(ownedPrivatePath).not.toHaveBeenCalled();
      if (code === "codex_mailbox_setup_failed") expect(codexMailboxSid).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  } finally {
    await rm(root, {recursive:true,force:true});
  }
});

it.each([["exit",1,"helper_nonzero_exit"],["signal",null,undefined],["spawn",null,undefined]])(
"reports only an observed nonzero isolated helper exit before a native turn (%s)", async (phase,exitCode,outcome) => {
  const root=await mkdtemp(join(tmpdir(),"mandala-helper-outcome-"));
  const platform=Object.getOwnPropertyDescriptor(process,"platform")!;
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
  try{
    const mailbox=join(root,"mailbox");
    await mkdir(mailbox);
    Object.defineProperty(process,"platform",{...platform,value:"win32"});
    helper.mockImplementation(()=>{
      if(phase==="spawn")throw new Error("PRIVATE_HELPER_DIAGNOSTIC");
      queueMicrotask(()=>{child.stderr.end("PRIVATE_HELPER_DIAGNOSTIC");child.emit("close",exitCode,phase==="signal"?"SIGTERM":null);});
      return child;
    });
    const request=vi.fn(async(method:string)=>{
      if(method==="initialize")return {userAgent:"codex/0.167.0"};
      if(method==="config/read")return {config:{windows:{sandbox:"unelevated"}}};
      if(method==="thread/resume")return {thread:{id:"synthetic-original-thread"},sandbox:{type:"readOnly"},cwd:root};
      throw new Error("Unexpected synthetic RPC: "+method);
    });
    vi.mocked(createRpcClient).mockReturnValue({request,notify(){},close(){}} as unknown as RpcClient);
    const client=await startCodex({cwd:root,fullAccess:false,env:{CODEX_HOME:root},onEvent(){},onApproval(){},onExit(){}});
    try{
      const error:unknown=await client.resumeThread("synthetic-original-thread",[],undefined,undefined,undefined,mailbox).catch(reason=>reason);
      expect(error).toMatchObject({code:"codex_mailbox_setup_failed",status:500});
      expect((error as {mailboxSetupOutcome?:string}).mailboxSetupOutcome).toBe(outcome);
      expect(JSON.stringify(error)).not.toMatch(/PRIVATE_HELPER_DIAGNOSTIC|synthetic-original-thread/);
      expect((error as Error).message).not.toContain(root);
      expect(helper).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.map(([method])=>method)).toEqual(["initialize","config/read","thread/resume"]);
    }finally{await client.close();}
  }finally{
    Object.defineProperty(process,"platform",platform);
    helper.mockReset();
    await rm(root,{recursive:true,force:true});
  }
});

it("does not copy arbitrary helper annotations into a public diagnostic",async()=>{
  const {codexMailboxFailure}=await import("../server/codex");
  expect(codexMailboxFailure("codex_mailbox_setup_failed","PRIVATE_HELPER_DIAGNOSTIC")).not.toHaveProperty("mailboxSetupOutcome");
  expect(codexMailboxFailure("codex_mailbox_path_invalid","helper_nonzero_exit")).not.toHaveProperty("mailboxSetupOutcome");
});


// SSH transports typed runtime codes in plain Errors. The persisted event must
// reconstruct safe copy instead of retaining the remote diagnostic message.
it("records only the sanitized Codex mailbox stage before any native turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "mandala-mailbox-event-"));
  try {
    const { openStore } = await import("../server/store");
    const { createSessionManager } = await import("../server/sessions");
    const store = openStore(home);
    const project = join(home, "project");
    await mkdir(project);
    const factory = vi.fn(async () => {
      throw Object.assign(new Error("PRIVATE_REMOTE_DIAGNOSTIC"), { code:"codex_mailbox_capability_unverified", status:500 });
    });
    const manager = createSessionManager(store, async () => ({
      version:2,
      projects:[{id:"p",name:"Fixture",cwd:project,agentIds:["a"],resources:[],mcp:[],skills:[]}],
      agents:[{id:"a",name:"Fixture",defaultCli:"codex",models:{},instructions:"",mcp:[],skills:[]}],
    }), factory, async () => { throw new Error("Unexpected OMP launch"); }, home);
    try {
      const chat = await manager.create("p","a");
      await expect(manager.send(chat.id,"Synthetic no-model input")).rejects.toMatchObject({
        code:"codex_mailbox_capability_unverified",
      });
      expect(factory).toHaveBeenCalledTimes(1);
      const errors = store.listEvents(chat.id,0).filter(event => event.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].data).toMatchObject({
        code:"codex_mailbox_capability_unverified",nativeTurnSubmitted:false,
      });
      expect(JSON.stringify(errors)).not.toMatch(/PRIVATE_REMOTE_DIAGNOSTIC|SYNTHETIC_SID/);
      expect(JSON.stringify(errors)).not.toContain(home);
    } finally {
      try { await manager.close(); } finally { store.close(); }
    }
  } finally {
    await rm(home,{recursive:true,force:true});
  }
});

it("durably rejects a known prestart human queue failure without accepting, replaying or losing the request", async () => {
  const home = await mkdtemp(join(tmpdir(), "mandala-mailbox-queue-event-"));
  const { openStore } = await import("../server/store");
  const { createSessionManager } = await import("../server/sessions");
  const project = join(home, "project");
  await mkdir(project);
  const factory = vi.fn(async () => {
    throw Object.assign(new Error("PRIVATE_REMOTE_DIAGNOSTIC"), {code:"codex_mailbox_setup_failed",status:500,mailboxSetupOutcome:"helper_nonzero_exit"});
  });
  const setup = () => {
    const store = openStore(home);
    const manager = createSessionManager(store, async () => ({
      version:2,
      projects:[{id:"p",name:"Fixture",cwd:project,agentIds:["a"],resources:[],mcp:[],skills:[]}],
      agents:[{id:"a",name:"Fixture",defaultCli:"codex",models:{},instructions:"",mcp:[],skills:[]}],
    }), factory, async () => { throw new Error("Unexpected OMP launch"); }, home);
    return {store,manager};
  };
  let {store,manager} = setup();
  try {
    const chat = await manager.create("p","a");
    const body = "Saved synthetic request";
    const input = manager.enqueueUserInput(chat.id,body,"mailbox-queue-test");
    await expect(manager.sendQueuedInput(chat.id,input.id)).rejects.toMatchObject({code:"codex_mailbox_setup_failed"});
    const receipt = () => manager.listUserInputs(chat.id).find(row=>row.id===input.id);
    expect(receipt()).toMatchObject({
      id:input.id,text:body,state:"cancelled",prestartFailure:{code:"codex_mailbox_setup_failed"},
    });
    const diagnostics=store.listEvents(chat.id,0).filter(event=>event.kind==="error").map(event=>event.data);
    expect(diagnostics).toMatchObject([
      {queuedInputId:input.id,nativeTurnSubmitted:false,code:"codex_mailbox_setup_failed",mailboxSetupOutcome:"helper_nonzero_exit"},
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_REMOTE_DIAGNOSTIC|PRIVATE_HELPER_DIAGNOSTIC/);
    expect(store.database.prepare("SELECT COUNT(*) n FROM task_input_invocations WHERE input_id=?").get(input.id)?.n).toBe(0);
    expect(store.database.prepare("SELECT COUNT(*) n FROM task_directory_claims WHERE kind='input' AND owner_id=?").get(input.id)?.n).toBe(0);
    await manager.close();
    store.close();
    ({store,manager} = setup());
    expect(manager.enqueueUserInput(chat.id,body,"mailbox-queue-test")).toEqual(receipt());
    expect(()=>manager.enqueueUserInput(chat.id,"changed","mailbox-queue-test")).toThrow(/idempotency_conflict/);
    await expect(manager.sendQueuedInput(chat.id,input.id)).rejects.toMatchObject({code:"input_not_queued"});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(store.database.prepare("SELECT state FROM task_user_inputs WHERE command_key=?").get("mailbox-queue-test")?.state).toBe("cancelled");
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    try { await manager.close(); } finally { store.close(); await rm(home,{recursive:true,force:true}); }
  }
});
