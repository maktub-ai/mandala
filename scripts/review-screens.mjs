#!/usr/bin/env node
// Rendered review of the main product pages on synthetic data (DESIGN.md §11).
// Starts the e2e fixture server, seeds tasks, chats, a wiki and schedules, then captures every page in
// each theme and width, with console errors and (with --a11y) axe-core WCAG 2.1 AA results.
//
//   npm run review:screens                      build, then 1440px light + dark
//   npm run review:screens -- --widths 1440,768,390 --a11y
//   npm run review:screens -- --skip-build --only tasks,library
//
// Output: output/review-screens/<time>/ with one PNG per page/theme/width, report.json and index.html.
// Screens use synthetic data only; never point this at a real Mandala home.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
const flag = name => argv.includes('--' + name);
const themes = option('themes', 'light,dark').split(',');
const widths = option('widths', '1440').split(',').map(Number);
const only = option('only', '')?.split(',').filter(Boolean) ?? [];
const port = Number(option('port', '4391'));
const base = `http://127.0.0.1:${port}`;
const out = resolve(option('out', join('output', 'review-screens', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
const heights = { 1440: 900, 1024: 768, 768: 1000, 390: 844 };

if (!flag('skip-build') || !existsSync('dist/index.html')) {
  console.log('Building the frontend…');
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/server.ts'], {
  env: { ...process.env, MANDALA_E2E_PORT: String(port), E2E_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', chunk => { serverLog += chunk; });
const stop = () => { if (!server.killed) server.kill(); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const request = async (path, init) => {
  const response = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init });
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
for (let i = 0; ; i++) {
  try { await request('/api/config'); break; } catch (error) {
    if (i > 60 || server.exitCode !== null) { console.error(serverLog.slice(-2000)); throw new Error('Fixture server did not start', { cause: error }); }
    await new Promise(done => setTimeout(done, 500));
  }
}

const post = path => request(path, { method: 'POST', body: '{}' });
const panels = await post('/__test__/mandala-panels');
await post('/__test__/operation-outcomes');
await post('/__test__/task-operation-cards');
await post('/__test__/wiki/seed');
// A realistic description with inline code and a list for the Task dialog.
const { task } = await request('/api/v2/tasks/' + panels.goalId);
await request('/api/v2/tasks/' + panels.goalId, { method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({
  expectedRevision: task.revision,
  goal: task.goal + '\n- 核对 `reading_list` 的真实用途、schema、唯一键和粒度。\n- 对 `book_id / title / category` 做全量 diff，再用 `READING_LIST_DRY_RUN=true` 检查清单。\n- **只读评估。**不导入、不写库、不改配置。',
}) });

const p = encodeURIComponent(panels.projectId), a = encodeURIComponent(panels.agentId);
const pages = [
  ['mandala', '/mandala'], ['chat', `/?project=&conversation=${panels.chatId}`],
  ['tasks', '/tasks'], ['tasks-board', '/tasks?view=board'], ['task-dialog', '/tasks/' + panels.goalId],
  ['projects', '/projects'], ['project-overview', `/projects/${p}/overview`], ['project-library', `/projects/${p}/library`], ['project-settings', `/projects/${p}/settings`],
  ['agents', '/agents'], ['agent-overview', `/agents/${a}`], ['agent-settings', `/agents/${a}?tab=settings`],
  ['library', '/library'], ['memory', '/mana'], ['schedules', '/schedules'], ['market', '/market'], ['market-installed', '/market?tab=installed'], ['usage', '/usage'],
  ['settings-general', '/settings/general'], ['settings-runtimes', '/settings/runtimes'], ['settings-mcp', '/settings/mcp'], ['settings-system', '/settings/system'],
].filter(([name]) => !only.length || only.some(prefix => name.startsWith(prefix)));

const axeSource = flag('a11y') ? readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8') : '';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  for (const theme of themes) for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: heights[width] ?? 900 }, colorScheme: theme, locale: 'zh-CN' });
    await context.addInitScript(mode => { try { localStorage.setItem('mana-language', 'zh-CN'); localStorage.setItem('mana-theme', mode); } catch { /* storage unavailable */ } }, theme);
    const page = await context.newPage();
    let errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
    // Name the failing request instead of the browser's generic "Failed to load resource".
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
    for (const [name, path] of pages) {
      errors = [];
      await page.goto(base + path, { waitUntil: 'networkidle' }).catch(error => errors.push(String(error)));
      await page.waitForTimeout(1200);
      const file = `${name}-${theme}-${width}.png`;
      await page.screenshot({ path: join(out, file) });
      const entry = { page: name, path, theme, width, file, url: page.url(), errors: [...new Set(errors)].slice(0, 10) };
      if (axeSource) {
        await page.addScriptTag({ content: axeSource });
        const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
        entry.a11y = result.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
      }
      report.push(entry);
      console.log(`${file}${entry.errors.length ? ` · ${entry.errors.length} console error(s)` : ''}${entry.a11y ? ` · ${entry.a11y.length} a11y rule(s)` : ''}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  stop();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cards = report.map(r => `<figure><a href="${r.file}"><img loading="lazy" src="${r.file}" alt=""></a><figcaption><strong>${escape(r.page)}</strong> · ${r.theme} · ${r.width}px${r.errors.length ? ` · <em>${r.errors.length} console</em>` : ''}${r.a11y?.length ? ` · <em>${r.a11y.length} a11y</em>` : ''}</figcaption></figure>`).join('\n');
const a11y = report.filter(r => r.a11y?.length).map(r => `<tr><td>${escape(r.page)} · ${r.theme} · ${r.width}</td><td>${r.a11y.map(v => `<b>${escape(v.id)}</b> (${v.impact}, ${v.nodes}) ${escape(v.help)}<br><code>${escape(v.targets.join(' | '))}</code>`).join('<br>')}</td></tr>`).join('');
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mandala rendered review</title>
<style>body{font:13px system-ui;margin:24px;background:#f4f5f7;color:#1b1d22}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}figure{margin:0;background:#fff;border:1px solid #e2e4e9;border-radius:8px;overflow:hidden}img{width:100%;display:block}figcaption{padding:8px 10px}em{color:#cf3a3a;font-style:normal}table{border-collapse:collapse;margin-top:24px;background:#fff}td{border:1px solid #e2e4e9;padding:6px 8px;vertical-align:top}code{font-size:11px;color:#5d616a}</style>
<h1>Mandala rendered review</h1><p>${report.length} screens · synthetic data · ${new Date().toLocaleString()}</p><main>${cards}</main>${a11y ? `<h2>Accessibility (WCAG 2.1 AA)</h2><table>${a11y}</table>` : ''}`);
console.log(`\n${report.length} screens → ${out}/index.html`);
