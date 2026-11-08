import { expect, it } from 'vitest';
import { validateConfig } from '../server/config';
const config = (memory: unknown) => ({ version: 2, projects: [], agents: [], system: { cli: 'omp', memory } });
it('accepts independent generation and reading controls and omitted defaults', () => {
  for (const memory of [{}, {request:{generate:false,read:true},session:{generate:true,read:false},idleHours:6}]) expect(()=>validateConfig(config(memory))).not.toThrow();
});
it('rejects malformed memory controls and unsafe idle intervals', () => {
  for (const memory of [null, [], {request:null}, {request:{generate:'yes'}}, {session:{read:0}}, {idleHours:0}, {idleHours:-1}, {idleHours:169}, {idleHours:Infinity}, {idleHours:'6'}, {unknown:true}, {request:{extra:true}}]) expect(()=>validateConfig(config(memory))).toThrow('invalid configuration');
});
