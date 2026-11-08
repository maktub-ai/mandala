import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import type { Element, Root, Text } from 'hast';
import { revealStreamingText } from '../src/streaming-text';

function render(text: string, from: number) {
  const tree = toHast(fromMarkdown(text)) as Root;
  revealStreamingText(from, text)(tree);
  const spans: Element[] = [];
  function walk(node: Root | Element | Text): string {
    if (node.type === 'text') return node.value;
    if (node.type === 'element' && node.properties.className?.includes('stream-character')) spans.push(node);
    return node.children.map(child => ['text', 'element'].includes(child.type) ? walk(child as Element | Text) : '').join('');
  }
  const content = walk(tree);
  return { content, spans, letters: spans.map(span => (span.children[0] as Text).value) };
}

describe('streamed prose reveal', () => {
  it('reveals only appended characters and preserves readable text', () => {
    const result = render('已有正文新增字', 4);
    expect(result.content).toBe('已有正文新增字');
    expect(result.letters).toEqual(['新', '增', '字']);
    expect(render('已有正文', 4).spans).toHaveLength(0);
  });
  it('bounds long bursts and keeps emoji and combining marks intact', () => {
    const result = render('旧' + '文'.repeat(100) + '👨‍👩‍👧‍👦é', 1);
    expect(result.content).toBe('旧' + '文'.repeat(100) + '👨‍👩‍👧‍👦é');
    expect(result.spans.length).toBeLessThanOrEqual(32);
    expect(result.letters.slice(-2)).toEqual(['👨‍👩‍👧‍👦', 'é']);
  });
  it('leaves code and diagram source unwrapped and preserves Markdown links', () => {
    const result = render('已有[新增](https://example.com) `inline`\n\n```mermaid\ngraph LR; A-->B\n```', 2);
    expect(result.letters).toEqual(['新', '增']);
    expect(result.content).toContain('inline');
    expect(result.content).toContain('graph LR; A-->B');
  });
  it('locates new letters after escaped Markdown and HTML entities', () => {
    expect(render('A &amp; Z', 8).letters).toEqual(['Z']);
    expect(render('A \\* Z', 5).letters).toEqual(['Z']);
    expect(render('A &amp; Z', 5).letters).toEqual(['Z']);
    expect(render('A &#12345; Z', 6).letters).toEqual(['〹', 'Z']);
  });
});
