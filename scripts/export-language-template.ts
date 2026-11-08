import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { english } from '../src/messages';
// Export the current static message surface. Dynamic sentences should use stable keys and placeholders.
const messages: Record<string, string> = { ...english };
async function scan(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await scan(path); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const file = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, entry.name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ['localize','text','say','label','l'].includes(node.expression.getText(file)) && node.arguments.length === 2 && node.arguments.every(ts.isStringLiteralLike)) {
        let [zh, en] = node.arguments.map(argument => (argument as ts.StringLiteralLike).text);
        if (/[\u3400-\u9fff]/.test(en) && !/[\u3400-\u9fff]/.test(zh)) [zh, en] = [en, zh];
        if (/[\u3400-\u9fff]/.test(zh)) messages[zh] ??= en;
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
}
await scan('src');
const raw = JSON.stringify(Object.fromEntries(Object.entries(messages).sort(([a], [b]) => a.localeCompare(b, 'en'))), null, 2) + '\n';
if (process.argv[2]) await writeFile(process.argv[2], raw); else process.stdout.write(raw);
