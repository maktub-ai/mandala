import { expect, it } from 'vitest';
import type { CompletionEvidence } from '../shared/tasks';
import { goalParts, taskGoal } from '../shared/task-presentation';

it('separates a short title and details without losing the execution goal', () => {
  const goal = taskGoal('Investigate CLI versions', 'Trace the version probe.\nReport evidence.');
  expect(goalParts(goal)).toEqual({title: 'Investigate CLI versions', description: 'Trace the version probe.\nReport evidence.'});
});
it('keeps long legacy instructions in the brief with a bounded title', () => {
  const goal = '为什么有些 CLI 版本看不到？' + '只读调查并说明具体来源、证据和限制。'.repeat(30);
  const parts = goalParts(goal);
  expect(Array.from(parts.title).length).toBeLessThanOrEqual(72);
  expect(parts.title).toBe('为什么有些 CLI 版本看不到？');
  expect(parts.description).toBe(goal);
});
it('keeps explicit short goals unchanged and bounds unbroken legacy titles', () => {
  expect(goalParts('A short task')).toEqual({title: 'A short task', description: ''});
  const text = 'x'.repeat(300);
  expect(goalParts(text).description).toBe(text);
  expect(goalParts(text).title.length).toBeLessThanOrEqual(72);
});

it('keeps generated legacy titles stable across repeated edits', () => {
  let parts = goalParts('x'.repeat(300));
  const original = parts;
  for (let i = 0; i < 3; i++) {
    parts = goalParts(taskGoal(parts.title, parts.description));
    expect(parts).toEqual(original);
  }
});

it('keeps completion evidence attached to the matching execution, including recurring runs', async () => {
  const { runCompletion } = await import('../shared/task-presentation');
  const earlier: CompletionEvidence = { completedBy: 'checks', sourceRunId: 'run-1', artifactVersions: [], acceptedAt: '2026-10-17T00:00:00Z' };
  const latest = { ...earlier, sourceRunId: 'run-2' };
  expect(runCompletion({ id: 'run-1', completion: earlier }, latest)).toBe(earlier);
  expect(runCompletion({ id: 'run-1' }, latest)).toBeNull();
  expect(runCompletion({ id: 'run-2' }, latest)).toBe(latest);
});
