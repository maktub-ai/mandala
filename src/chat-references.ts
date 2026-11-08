export function appendChatReference(draft: string, reference: string): string {
  const next = draft ? draft + '\n\n' + reference : reference;
  // Leave room for the remaining fields in the 256 KiB chat request.
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 240_000)
    throw new Error('引用内容太长，请缩小选区后再加入对话。');
  return next;
}
export function selectedLineRange(text: string, start: number, end: number): { start: number; end: number } | null {
  if (start < 0 || end <= start || end > text.length) return null;
  return { start: text.slice(0, start).split('\n').length, end: text.slice(0, text[end - 1] === '\n' ? end - 1 : end).split('\n').length };
}
function quoted(text: string, language = '') {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return fence + language + '\n' + text + '\n' + fence;
}
export function fileReference(path: string, text?: string, range?: { start: number; end: number }, english = false) {
  const label = english ? 'File reference: ' : '引用文件：';
  if (!range || text === undefined) return label + path;
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > lines.length)
    throw new Error('Invalid line selection');
  return label + path + ':' + range.start + '-' + range.end + (english ? ' (current preview)' : '（当前预览）') + '\n' + quoted(lines.slice(range.start - 1, range.end).join('\n'));
}
export function terminalReference(cwd: string, text: string, english = false) {
  return (english ? 'Terminal output (starting directory: ' : '终端输出（启动目录：') + cwd + (english ? '):\n' : '）：\n') + quoted(text, 'text');
}
