import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RuntimeProbeSummary } from '../src/RuntimeSetup';
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
