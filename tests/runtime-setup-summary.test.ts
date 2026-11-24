import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import RuntimeSetup, { RuntimeProbeSummary } from '../src/RuntimeSetup';
import { renderChineseMarkup } from './helpers/render-ui';
import type { CliStatus } from '../shared/types';

const diagnostics = {
  host: 'local', executable: 'missing', probe: 'acp', auth: 'not-verified', standaloneClaude: true,
} satisfies NonNullable<CliStatus['diagnostics']>;

it('does not show a missing adapter when the actual launcher probe succeeds', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'ready', version: null, diagnostics },
  }));
  expect(html).toContain('Connection check passed');
  expect(html).not.toContain('adapter is not runnable');
});

it('explains that a standalone Claude installation does not supply the ACP adapter when launch fails', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'unavailable', version: null, diagnostics: { ...diagnostics, probe: 'failed' } },
  }));
  expect(html).toContain('separate ACP adapter is not runnable');
});

it('explains verified incompatibility without treating an ACP handshake as runnable',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeProbeSummary,{status:{status:'unavailable',version:'1.0',diagnostics:{...diagnostics,executable:'executable',standaloneClaude:false,capabilityIssue:'durable-resume-unsupported'}}}));
 expect(html).toContain('cannot resume conversations');
 expect(html).not.toContain('Connection check passed');
});
it('explains the actionable Claude override without showing a configured path',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeProbeSummary,{status:{status:'unavailable',version:null,diagnostics:{...diagnostics,requiredDependency:'claude-override-unavailable'}}}));
 expect(html).toContain('CLAUDE_CODE_EXECUTABLE');
 expect(html).toContain('bundled executable');
 expect(html).not.toContain('adapter is not runnable');
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
