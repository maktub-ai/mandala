import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import RuntimeSetup, { RuntimeProbeSummary } from '../src/RuntimeSetup';
import { renderChineseMarkup } from './helpers/render-ui';
import type { CliStatus } from '../shared/types';

const diagnostics = {
  host: 'local', executable: 'executable', probe: 'acp', auth: 'not-verified', requiredDependency: 'claude-bridge-missing',
} satisfies NonNullable<CliStatus['diagnostics']>;

it('does not show a missing adapter when the actual launcher probe succeeds', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'ready', version: null, diagnostics },
  }));
  expect(html).toContain('Connection check passed');
  expect(html).not.toContain('missing Mandala');
});

it('identifies an incomplete Mandala install when Claude is present', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'unavailable', version: null, diagnostics: { ...diagnostics, probe: 'failed' } },
  }));
  expect(html).toContain('missing Mandala');
});

it('explains verified incompatibility without treating an ACP handshake as runnable',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeProbeSummary,{status:{status:'unavailable',version:'1.0',diagnostics:{...diagnostics,executable:'executable',requiredDependency:undefined,capabilityIssue:'durable-resume-unsupported'}}}));
 expect(html).toContain('cannot resume conversations');
 expect(html).not.toContain('Connection check passed');
});
it('explains the actionable Claude override without showing a configured path',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeProbeSummary,{status:{status:'unavailable',version:null,diagnostics:{...diagnostics,requiredDependency:'claude-override-unavailable'}}}));
 expect(html).toContain('CLAUDE_CODE_EXECUTABLE');
 expect(html).toContain('installed Claude Code');
 expect(html).not.toContain('missing Mandala');
});

it.each([
 ['configuration','Runtime settings prevented the check'],
 ['launch','Could not start the native CLI'],
 ['probe','The native CLI readiness check failed'],
] as const)('shows an actionable and precise explanation for %s', (failureStage,label)=>{
 const status={status:'unavailable',version:null,diagnostics:{host:'local',executable:'not-verified',probe:'failed',auth:'not-verified',failureStage}} satisfies CliStatus;
 const html=renderToStaticMarkup(createElement(RuntimeProbeSummary,{status}));
 expect(html).toContain(label);
 expect(html).not.toContain('launcher was found');
 expect(html).not.toContain('native CLI started');
});

it.each([
  ['missing', 'Launcher not found', 'PATH 中未找到启动命令'],
  ['broken', 'link points to a missing file', '链接指向不存在的文件'],
  ['blocked', 'not executable', '该文件不能执行'],
] as const)('reports a %s launcher before an ACP handshake error', (executable, english, chinese) => {
  const status = { status: 'unavailable', version: null, diagnostics: { host: 'local', executable, probe: 'failed', auth: 'not-verified', failureStage: 'handshake' } } satisfies CliStatus;
  const element = createElement(RuntimeProbeSummary, { status });
  const en = renderToStaticMarkup(element), zh = renderChineseMarkup(element);
  expect(en).toContain(english);
  expect(en).not.toContain('handshake');
  expect(zh).toContain(chinese);
  expect(zh).not.toContain('握手');
});

it('explains that OpenCode ships its own ACP mode and links to usage, not another installer', () => {
  const element = createElement(RuntimeSetup, { cli: 'opencode' });
  const en = renderToStaticMarkup(element), zh = renderChineseMarkup(element);
  expect(en).toContain('opencode acp');
  expect(en).toContain('no separate adapter installation is required');
  expect(en).toContain('Official OpenCode ACP guide');
  expect(zh).toContain('OpenCode 官方 ACP 使用说明');
  expect(zh).not.toContain('官方安装说明');
});

it.each([
 ['hermes','https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
  'Requires the Hermes ACP extra and a running Hermes Gateway with a configured model provider',
  '需要 Hermes ACP 扩展，以及已配置模型服务且正在运行的 Hermes Gateway'],
 ['openclaw','https://docs.openclaw.ai/cli/acp',
  'Requires a configured, running OpenClaw Gateway',
  '需要已配置并运行的 OpenClaw Gateway'],
] as const)('shows %s prerequisites and direct official ACP docs without claiming readiness', (cli, docs, english, chinese) => {
 const element=createElement(RuntimeSetup,{cli});
 const en=renderToStaticMarkup(element), zh=renderChineseMarkup(element);
 expect(en).toContain(english);
 expect(zh).toContain(chinese);
 for(const html of [en,zh]){
  expect(html).toContain('href="'+docs+'"');
  expect(html).not.toContain('Connection check passed');
 }
 if(cli==='openclaw')expect(en).not.toContain('Hermes ACP extra');
});
