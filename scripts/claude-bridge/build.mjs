import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import manifest from './manifest.json' with {type: 'json'};

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {build} = require('../../node_modules/esbuild');
const adapter = '@agentclientprotocol/claude-agent-acp';
const sdk = '@anthropic-ai/claude-agent-sdk';
const adapterChanges = [
  ['v1/acp-agent.js', 'explicit: creationOpts.permissionMode,', 'explicit: "default",'],
  ['v1/acp-agent.js', 'initializationResult = await q.initializationResult();',
    `initializationResult = await q.initializationResult();
      if (params.mcpServers?.length && initializationResult.mcp_servers_applied !== true) {
        throw new Error("Claude Code did not confirm the requested MCP configuration.");
      }`],
  ['session-titles.js', 'return typeof query.generateSessionTitle === "function";', 'return false;'],
];
const bridgePolicy = {
  name: 'mandala-claude-policy',
  setup(builder) {
    builder.onLoad({filter: /(?:acp-agent|session-titles)\.js$/}, async ({path}) => {
      const changes = adapterChanges.filter(([file]) => path.replaceAll('\\', '/').endsWith(`/node_modules/${adapter}/dist/${file}`));
      if (!changes.length) return;
      let source = await readFile(path, 'utf8');
      for (const [, original, replacement] of changes) {
        if (source.split(original).length !== 2) throw new Error('Claude adapter policy patch no longer applies');
        source = source.replace(original, replacement);
      }
      return {contents: source, loader: 'js'};
    });
  },
};

export async function buildClaudeBridge(outdir) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (lock.packages[`node_modules/${adapter}`]?.version !== manifest.adapterVersion ||
      lock.packages[`node_modules/${sdk}`]?.version !== manifest.sdkVersion) {
    throw new Error('Claude bridge dependency pins do not match the lockfile');
  }
  // This private install excludes the SDK's platform-specific Claude binaries.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund',
  ], {cwd: root, shell: process.platform === 'win32', stdio: 'inherit'});
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['entry.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: {__MANDALA_CLAUDE_ADAPTER_VERSION__: JSON.stringify(manifest.adapterVersion)},
    minify: true,
    plugins: [bridgePolicy],
    write: false,
    banner: {js: 'import {createRequire as __makeRequire} from "node:module"; const require = __makeRequire(import.meta.url);'},
  });
  const bytes = result.outputFiles[0].contents;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.sha256) throw new Error(`Claude bridge SHA-256 mismatch: ${digest}`);
  // Preserve upstream terms alongside every private copy, including SSH bundles.
  const notices = [];
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || metadata.optional) continue;
    const directory = join(root, path);
    const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice|third[-_]party[-_]notices)([-._]|$)/i.test(name));
    notices.push(`\n--- ${path.slice('node_modules/'.length)} ${metadata.version} (${metadata.license ?? 'see upstream'}) ---\n`);
    for (const file of files) notices.push(await readFile(join(directory, file), 'utf8'));
  }
  await writeFile(join(outdir, manifest.notices), notices.join('\n'));
  await writeFile(join(outdir, manifest.entry), bytes);
}
