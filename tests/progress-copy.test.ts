import {describe,it,expect} from 'vitest';
import {progressExcerpt,progressTitle} from '../src/progress-presentation';
describe('Progress readable copy',()=>{
 it('does not repeat a title prefix as its request excerpt',()=>{
  expect(progressExcerpt('请盘点当前会话可用的 skills 和 MCP 工具：1）列出技能；2）列出工具', '请盘点当前会话可用的 skills 和 MCP 工具：1）列出技能；2）…')).toBe('');
  expect(progressExcerpt('Release plan','Check rollback first')).toBe('Check rollback first');
 });
 it('keeps the compact title bounded without changing the source',()=>{
  const full='Check release readiness '.repeat(15);
  expect(progressTitle(full).length).toBeLessThanOrEqual(81);
  expect(progressTitle(full)).toContain('…');
  expect(progressTitle('Short title')).toBe('Short title');
 });
});
