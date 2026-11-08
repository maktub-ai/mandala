import { expect, test } from 'vitest';
import { conversationMatchOffsets } from '../src/ConversationFind';

test('find offsets refer to original text even after Unicode case mapping', () => {
  expect(conversationMatchOffsets('İ foo', 'foo')).toEqual([{ start: 2, end: 5 }]);
  expect(conversationMatchOffsets('İ foo bar', 'foo')).toEqual([{ start: 2, end: 5 }]);
  expect(conversationMatchOffsets('Needle needle', 'NEEDLE')).toEqual([{ start: 0, end: 6 }, { start: 7, end: 13 }]);
});
test('find treats regex punctuation as literal text and supports Chinese', () => {
  expect(conversationMatchOffsets('x [a]+ [a]+ 内容', '[a]+')).toEqual([{ start: 2, end: 6 }, { start: 7, end: 11 }]);
  expect(conversationMatchOffsets('中文内容 中文', '中文')).toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }]);
  expect(conversationMatchOffsets('content', '')).toEqual([]);
});
