import { expect, it } from 'vitest';
import { slashReferenceQuery, mentionReferenceQuery, matchesReferenceQuery } from '../src/ComposerReferences';

it('recognizes a composer slash search at the caret and preserves surrounding text', () => {
  expect(slashReferenceQuery('Please /review then continue', 14)).toEqual({ start: 7, end: 14, query: 'review' });
  expect(slashReferenceQuery('/', 1)).toEqual({ start: 0, end: 1, query: '' });
  expect(slashReferenceQuery('Please\n/skill', 13)).toEqual({ start: 7, end: 13, query: 'skill' });
});
it('does not turn file paths or URL slashes into reference searches', () => {
  expect(slashReferenceQuery('/tmp/file.md', 12)).toBeNull();
  expect(slashReferenceQuery('https://example.com', 19)).toBeNull();
  expect(slashReferenceQuery('review/skill', 12)).toBeNull();
});


it('matches the beginning of Skill and MCP names, ignoring descriptions and paths', () => {
  expect(matchesReferenceQuery({name: 'backend-patterns', kind: 'skill'}, 'b')).toBe(true);
  expect(matchesReferenceQuery({name: 'Backend', kind: 'mcp'}, 'b')).toBe(true);
  expect(matchesReferenceQuery({name: 'debugging', kind: 'skill'}, 'b')).toBe(false);
  expect(matchesReferenceQuery({name: 'alpha', kind: 'mcp'}, 'b')).toBe(false);
  expect(matchesReferenceQuery({name: 'Review billing', kind: 'task'}, 'bill')).toBe(false);
  expect(matchesReferenceQuery({name: 'Billing review', kind: 'task'}, 'bill')).toBe(true);
  expect(matchesReferenceQuery({name: 'alpha', kind: 'skill'}, '')).toBe(true);
});

it('recognizes Agent mentions but ignores addresses and paths', () => {
  expect(mentionReferenceQuery('Ask @reviewer',13)).toEqual({start:4,end:13,query:'reviewer'});
  expect(mentionReferenceQuery('mail@example.com',16)).toBeNull();
  expect(mentionReferenceQuery('src/@types/node',15)).toBeNull();
});
