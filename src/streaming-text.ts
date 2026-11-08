import type { Element, Root, Text } from 'hast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Keep a burst bounded: the rest is immediately readable, never queued for typing.
export function revealStreamingText(from: number, source: string) {
  return (tree: Root) => {
    let remaining = 32;
    function walk(parent: Root | Element) {
      if (parent.type === 'element' && ['code', 'pre'].includes(parent.tagName)) return;
      for (let i = parent.children.length - 1; i >= 0 && remaining; i--) {
        const node = parent.children[i];
        if (node.type === 'element') { walk(node); continue; }
        if (node.type !== 'text' || node.position?.start.offset === undefined) continue;
        const start = node.position.start.offset;
        if ((node.position.end.offset ?? start) <= from) continue;
        const rawPrefix = source.slice(start, Math.max(start, from));
        // Markdown entities/escapes occupy more source bytes than visible text.
        const visible = (node: Nodes): string => 'value' in node ? node.value : 'children' in node ? node.children.map(visible).join('') : '';
        const decodedPrefix = /[&\\]/.test(rawPrefix) ? visible(fromMarkdown('x' + rawPrefix + 'x')).slice(1, -1) : rawPrefix;
        let boundary = 0;
        while (boundary < decodedPrefix.length && decodedPrefix[boundary] === node.value[boundary]) boundary++;
        const segments = Array.from(graphemes.segment(node.value));
        const fresh = segments.filter(part => part.index >= boundary).slice(-remaining);
        if (!fresh.length) continue;
        remaining -= fresh.length;
        const prefix: Text = { type: 'text', value: node.value.slice(0, fresh[0].index) };
        const characters: (Element | Text)[] = fresh.map((part, index) => /^\s+$/.test(part.segment) ? { type: 'text', value: part.segment } : ({ type: 'element', tagName: 'span',
          properties: { className: ['stream-character'], dataStreamKey: `${from}:${start + part.index}`, style: `animation-delay:${Math.min(index * 30, 60)}ms` },
          children: [{ type: 'text', value: part.segment }],
        }));
        parent.children.splice(i, 1, prefix, ...characters);
      }
    }
    walk(tree);
  };
}
