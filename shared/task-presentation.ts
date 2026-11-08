import type { CompletionEvidence, Run } from './tasks';

// Keep the existing execution goal contract: first line is the title, followed by details.
export function goalParts(goal: string): { title: string; description: string } {
  const text = goal.trim(), [first, ...notes] = text.split(/\r?\n/);
  if (Array.from(first).length <= 72) return { title: first, description: notes.join('\n').trim() };
  const sentence = first.match(/^.*?[。！？!?](?:\s|$)?|^.*?\.(?:\s|$)/)?.[0]?.trim();
  const title = sentence && Array.from(sentence).length <= 72 ? sentence : Array.from(first).slice(0, 71).join('') + '…';
  return { title, description: text };
}

export function taskGoal(title: string, description: string): string {
  return [title.trim(), description.trim()].filter(Boolean).join('\n\n');
}

export function runCompletion(run: Pick<Run, 'id' | 'completion'>, completion: CompletionEvidence | null): CompletionEvidence | null {
  return run.completion ?? (completion?.sourceRunId === run.id ? completion : null);
}
