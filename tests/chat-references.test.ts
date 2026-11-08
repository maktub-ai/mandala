import { expect, it } from 'vitest';
import { appendChatReference, fileReference, terminalReference, selectedLineRange } from '../src/chat-references';

it('keeps the existing draft and cites the exact preview lines rather than a searched substring', () => {
  const ref = fileReference('src/demo.ts', 'same\nsecond\nsame\n', { start: 2, end: 3 });
  expect(ref).toBe('引用文件：src/demo.ts:2-3（当前预览）\n```\nsecond\nsame\n```');
  expect(appendChatReference('Please fix this', ref)).toBe('Please fix this\n\n' + ref);
  expect(fileReference('src/demo.ts')).toBe('引用文件：src/demo.ts');
});
it('keeps embedded Markdown fences inside the quoted code and bounds selected text', () => {
  expect(fileReference('a.md', '```\nvalue', { start: 1, end: 2 })).toContain('````\n```\nvalue\n````');
  expect(() => fileReference('a.ts', 'one\ntwo', { start: 0, end: 2 })).toThrow();
  expect(() => fileReference('a.ts', 'one\ntwo', { start: 2, end: 3 })).toThrow();
});
it('makes terminal output a reviewable draft reference with its directory', () => {
  expect(terminalReference('/tmp/sample', 'FAIL: expected 3, got 2')).toBe('终端输出（启动目录：/tmp/sample）：\n```text\nFAIL: expected 3, got 2\n```');
  expect(appendChatReference('', 'Reference')).toBe('Reference');
});
it('maps repeated text and newline boundaries to the selected preview positions', () => {
  expect(selectedLineRange('same\nsecond\nsame\n', 12, 16)).toEqual({ start: 3, end: 3 });
  expect(selectedLineRange('one\ntwo\nthree', 4, 8)).toEqual({ start: 2, end: 2 });
  expect(selectedLineRange('one\ntwo', 0, 7)).toEqual({ start: 1, end: 2 });
  expect(selectedLineRange('one', 0, 0)).toBeNull();
  expect(selectedLineRange('one', 0, 10)).toBeNull();
});
it('rejects an oversized Unicode reference before it produces an unsendable draft', () => {
  expect(() => appendChatReference('Keep this draft', '界'.repeat(90_000))).toThrow(/引用内容太长/);
  expect(() => appendChatReference('x'.repeat(230_000), 'y'.repeat(20_000))).toThrow(/引用内容太长/);
  expect(appendChatReference('draft', '界'.repeat(10_000))).toContain('draft\n\n界');
});
