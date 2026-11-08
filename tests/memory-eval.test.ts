import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadBaseline, runCorpus, scoreCase, type EvalCase, type EvalHit } from '../scripts/memory-eval';
const gold = JSON.parse(readFileSync(new URL('./fixtures/memory-eval.json', import.meta.url), 'utf8')) as { cases: EvalCase[] };
const example = gold.cases[0];
const hit: EvalHit = { id: 'target:L1', text: example.user, layer: 'L1', verification: 'source_extract', sources: ['target:user'], status: 'active' };
test('gold has sixty bilingual cases, ten in each fixed category and explicit source/claim expectations', () => {
 expect(gold.cases).toHaveLength(60);
 expect(new Set(gold.cases.map(c => c.id)).size).toBe(60);
 for (const category of ['fact','preference','correction','scope','withdrawal','unsupported']) {
  const cases = gold.cases.filter(c => c.category === category);
  expect(cases).toHaveLength(10); expect(cases.filter(c => c.language === 'zh')).toHaveLength(5);
  expect(cases.filter(c => c.language === 'en')).toHaveLength(5);
 }
 for (const c of gold.cases) { expect(c.allowed.length).toBeGreaterThan(0); expect(c.sourceExpectations).toBeDefined(); expect(c.forbiddenClaims.length).toBeGreaterThan(0); }
});
test('scorer rejects scope leakage even with valid evidence', () => {
 expect(scoreCase(example, [{...hit, id:'foreign:L1'}]).scopeLeaks).toBe(1);
});
test('scorer rejects withdrawn output independently of scope and recall', () => {
 expect(scoreCase(example, [{...hit,status:'retracted'}]).withdrawnLeaks).toBe(1);
});
test('scorer rejects missing, forged and mismatched sources', () => {
 for(const sources of [[], ['invented:user'], ['target:assistant']]) expect(scoreCase(example, [{...hit,sources}]).sourceErrors).toBe(1);
});
test('scorer rejects unsupported current assertions, including an L2 label without historical verification', () => {
 for(const layer of ['L1','L2'] as const) expect(scoreCase(example,[{...hit,layer,text:example.forbiddenClaims[0]}]).unsupportedClaims).toBe(1);
});
test('scorer permits a fixed gold historical quote, but not arbitrary text tagged stage_summary', () => {
 const c = gold.cases.find(c=>c.category==='unsupported')!;
 const summary: EvalHit = {id:'target:L2',text:c.historicalText,layer:'L2',verification:'stage_summary',sources:['target:user','target:assistant'],status:'active'};
 expect(scoreCase(c,[summary]).unsupportedClaims).toBe(0);
 expect(scoreCase(c,[{...summary,text:c.forbiddenClaims[0]}]).unsupportedClaims).toBe(1);
});
test('scorer rejects a supported id with wrong content or promoted layer', () => {
 expect(scoreCase(example,[{...hit,text:'invented current fact'}]).contentErrors).toBe(1);
 expect(scoreCase(example,[{...hit,layer:'L3'}]).contentErrors).toBe(1);
});
test('duplicate answers cannot inflate recall and eight-record/6000-body budgets are checked', () => {
 expect(scoreCase(example,Array(9).fill(hit)).budgetErrors).toBeGreaterThan(0);
 expect(scoreCase(example,[{...hit,text:'文'.repeat(6001)}]).budgetErrors).toBeGreaterThan(0);
 expect(scoreCase(example,[hit,hit]).recallAt5).toBeLessThanOrEqual(1);
});
test('explicit missing baseline fails without silently replacing the old algorithm', async () => {
 await expect(loadBaseline('/definitely-missing-openmana-baseline/knowledge.ts')).rejects.toThrow(/baseline/i);
});
test('retired phase-excerpt corpus cannot claim a passing quality gate for shared automatic memory', async () => {
 await expect(runCorpus(gold.cases)).rejects.toThrow('legacy_memory_gold_incompatible');
});

test('unverified active output cannot pass as an adopted fact even when text and source match', () => {
 expect(scoreCase(example,[{...hit,verification:'unverified'}]).unsupportedClaims).toBe(1);
});
test('fixed freshness gold contains correction and independent expiration/source mutation subcases', () => {
 const corrections=gold.cases.filter(c=>c.category==='correction');
 expect(corrections).toHaveLength(10);
 for(const c of corrections){expect(c.forbiddenClaims).toContain(c.user);expect(c.allowed).not.toContain('target:L2');expect(c.correction).not.toBe(c.user);}
 expect(new Set(gold.cases.filter(c=>c.category==='withdrawal').map(c=>c.withdrawalMode))).toEqual(new Set(['record','expired','source_update','source_retract']));
});
