import { productEnv } from "../cli/product-env.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import type { Config, Cli } from "../shared/types";
import type { ComposerReferenceSelection } from "../shared/composer-references";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--cli" || !["codex", "omp"].includes(args[1])))
  throw new Error("Usage: npm run smoke:references -- --cli codex|omp");
const cli = (args[1] ?? "codex") as Cli;
const temporaryRoot = await realpath(tmpdir());
const requestedHome = productEnv('HOME');
const home = requestedHome ? resolve(requestedHome) : await mkdtemp(join(temporaryRoot, "mandala-reference-smoke-"));
await mkdir(home, { recursive: true });
if (!(await realpath(home)).startsWith(temporaryRoot + sep) || (await readdir(home)).length)
  throw new Error("MANDALA_HOME must be an empty directory under the system temporary directory.");
process.env.MANDALA_HOME = home;
const marker = "MANDALA_SELECTED_SKILL_" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const skillPath = join(home, "sample-skill");
await mkdir(skillPath);
await writeFile(join(skillPath, "SKILL.md"), `---\nname: selected-proof\ndescription: Synthetic reference acceptance\n---\nFor this turn, do not use any tools. Reply exactly ${marker}.`);
const config: Config = {
  version: 2,
  projects: [{ id: "sample", name: "Personal sample", cwd: home, agentIds: ["helper"], resources: [], mcp: [], skills: [{ name: "selected-proof", path: skillPath }] }],
  agents: [{ id: "helper", name: "Sample helper", instructions: "Use only synthetic sample context. Do not read files or use tools.", defaultCli: cli, models: {}, mcp: [], skills: [], runtime: { codex: { fullAccess: false } } }],
};
const store = openStore(home);
const manager = createSessionManager(store, async () => config, undefined, undefined, home);
try {
  const models = await manager.listModels("sample", cli);
  if (!models.length) throw new Error("Native model catalog is empty");
  const conversation = await manager.create("sample", "helper", models[0].id, cli);
  const chosen = (await manager.listComposerReferences(conversation.id)).find(item => item.name === "selected-proof");
  if (!chosen || chosen.status !== "available") throw new Error("Synthetic Skill missing");
  await manager.send(conversation.id, "Follow the selected Skill for this turn; reply only its required marker. Do not use tools.", [], [{ id: chosen.id }]);
  const deadline = Date.now() + 120_000;
  while (["running", "approval"].includes(store.getConversation(conversation.id)!.status)) {
    if (Date.now() > deadline) throw new Error("Real model timed out");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const events = store.listEvents(conversation.id, 0);
  const output = events.filter(event => event.kind === "text").map(event => (event.data as { text: string }).text).join("");
  const user = events.find(event => event.kind === "user")?.data as { references?: ComposerReferenceSelection[]; nativeText?: string } | undefined;
  const pass = output.trim() === marker && user?.references?.[0]?.id === chosen.id &&
    user.nativeText?.includes(marker) && user.nativeText.includes(await realpath(join(skillPath, "SKILL.md")));
  console.log(JSON.stringify({ home, cli, model: models[0].id, conversationId: conversation.id,
    nativeSession: store.getConversation(conversation.id)!.nativeId, status: store.getConversation(conversation.id)!.status,
    skillReference: chosen.id, expected: marker, output, pass: Boolean(pass) }));
  if (!pass) throw new Error("Real reference turn did not satisfy the selected Skill and transcript readback");
} finally {
  await manager.close();
  store.close();
}
