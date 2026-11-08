import { expect, test } from 'vitest';
import { projectAgentChoice } from '../shared/chat-context';
import type { Config } from '../shared/types';

const config = { agents: [{ id: 'a' }, { id: 'b' }], projects: [{ id: 'p', agentIds: ['a', 'b'] }, { id: 'q', agentIds: ['b'] }] } as Config;
test('restores valid per-project choices, including explicitly choosing no Agent', () => {
  expect(projectAgentChoice(config, 'p', 'b', { p: 'a' })).toBe('a');
  expect(projectAgentChoice(config, 'p', 'a', { p: '' })).toBe('');
  expect(projectAgentChoice(config, 'q', 'a', { q: 'a' })).toBe('');
  expect(projectAgentChoice(config, 'q', 'b', {})).toBe('b');
  expect(projectAgentChoice(config, '', 'a', {})).toBe('a');
  expect(projectAgentChoice(config, 'missing', 'b', {})).toBe('');
});

test('never preselects the managed primary Agent for ordinary New Chat', () => {
  const managed={...config,agents:[...config.agents,{id:'mandala-system',systemRole:'mandala'}]} as Config;
  expect(projectAgentChoice(managed,'','mandala-system',{})).toBe('');
  expect(projectAgentChoice(managed,'','',{'':'mandala-system'})).toBe('');
  expect(projectAgentChoice(managed,'','a',{'':'mandala-system'})).toBe('a');
});


test('configured system identity can be selected and remembered in every Project without membership',()=>{
 const managed={...config,mandala:{agentId:'system'},agents:[...config.agents,{id:'system',systemRole:'mandala'}]} as Config;
 expect(projectAgentChoice(managed,'p','system',{})).toBe('system');
 expect(projectAgentChoice(managed,'q','',{'q':'system'})).toBe('system');
 expect(projectAgentChoice(managed,'','system',{})).toBe('system');
 expect(projectAgentChoice({...managed,mandala:{agentId:'other'}} as Config,'p','system',{})).toBe('');
 expect(projectAgentChoice({...managed,agents:[...config.agents,{id:'system'}]} as Config,'p','system',{})).toBe('');
});
