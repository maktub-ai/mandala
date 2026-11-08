import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const unquote = (value: string) => value.slice(1, -1).replaceAll("'\\''", "'");

export function businessCliContext(instructions = "") {
  const command = instructions.match(/^(?:Mandala|OpenMana) CLI command: (.+)$/m)?.[1];
  if (!command) throw new Error("Missing invocation CLI command");
  const windowsLauncher = command.match(/ -File '((?:[^']|'')+)'$/)?.[1];
  const launcher = windowsLauncher ? windowsLauncher.replaceAll("''", "'") : unquote(command);
  const credential = readFileSync(launcher, "utf8").match(/^export (?:MANDALA|OPEN_MANA)_CONTEXT=(.+)$/m)?.[1];
  if (!windowsLauncher && !credential) throw new Error("Missing CLI credential file");
  const contextFile = windowsLauncher ? join(dirname(launcher), "context.json") : unquote(credential!);
  return { launcher, contextFile, ...JSON.parse(readFileSync(contextFile, "utf8")) as { baseUrl: string; token: string; mailboxPath?: string } };
}
