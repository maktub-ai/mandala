import { afterEach, expect, it, vi } from 'vitest';
import { configuredRuntime, resolveRuntime, runtimeSignature } from '../server/runtime';
import { validateConfig } from '../server/config';
import type { Config } from '../shared/types';
afterEach(() => vi.unstubAllEnvs());
it('merges workspace defaults with field overrides and keeps reference-only signatures', () => {
 const defaults = {codex:{args:['--strict-config'],env:{SERVICE:'${WORKSPACE_KEY}',SHARED:'${WORKSPACE_KEY}'},approvalMode:'auto' as const,fullAccess:false}};
 const agent = {codex:{args:[],env:{SHARED:'${AGENT_KEY}'},approvalMode:'default' as const}};
 expect(configuredRuntime('codex',agent,defaults)).toEqual({args:[],env:{SERVICE:'${WORKSPACE_KEY}',SHARED:'${AGENT_KEY}'},approvalMode:'default',fullAccess:false});
 vi.stubEnv('WORKSPACE_KEY','workspace-secret');vi.stubEnv('AGENT_KEY','agent-secret');
 expect(resolveRuntime('codex',agent,defaults)).toEqual({extraArgs:[],env:{SERVICE:'workspace-secret',SHARED:'agent-secret'},fullAccess:false});
 expect(runtimeSignature('codex',undefined,defaults)).not.toBe(runtimeSignature('codex'));
 expect(runtimeSignature('codex',agent,defaults)).not.toContain('secret');
});
it('validates additive defaults using the existing runtime safety contract', () => {
 const config:Config={version:2,projects:[],agents:[]};
 expect(()=>validateConfig(config)).not.toThrow();
 config.runtimeDefaults={codex:{args:['--strict-config'],env:{SERVICE:'${SOURCE}'},fullAccess:false}};
 expect(()=>validateConfig(config)).not.toThrow();
 for(const runtimeDefaults of [{codex:{env:{HOME:'${SOURCE}'}}},{codex:{args:['--listen=bad']}},{claude:{args:['--unsafe']}},{gemini:{env:{KEY:'literal'}}},{codex:{approvalMode:'invalid'}}])
  expect(()=>validateConfig({...config,runtimeDefaults})).toThrow();
});
