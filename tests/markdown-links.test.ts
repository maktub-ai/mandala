import React from 'react';
import { renderChineseMarkup } from './helpers/render-ui';
import { expect, it } from 'vitest';
import MarkdownMessage, { tableTsv } from '../src/MarkdownMessage';
import { VerifiedFilesContext } from '../src/VerifiedFilesContext';
import { conversationFiles, messageLinks } from '../src/conversationFiles';
const renderVerified = (text: string) => renderChineseMarkup(React.createElement(VerifiedFilesContext.Provider, { value: new Set(messageLinks(text).map(link => link.href)), children: React.createElement(MarkdownMessage,{text}) }));
it('renders local file links as compact open controls', () => {
 const html=renderVerified("[查看任务清单](/Users/example/workspace/docs/tasks.md)");
 expect(html).not.toContain('href="/Users/');
 expect(html).not.toContain('本地文件，点击复制路径');
 expect(html).toContain('role="link"');
 expect(html).toContain('打开文件');
 expect(html).toContain('查看任务清单');
});

it('makes delivered inline paths clickable and discoverable without linking commands or fenced examples', () => {
 const text='Delivered `/tmp/report one.md` and `outputs/接入要求 one.md` and `.mandala/outputs/conversations/chat/result.md`.\n\n`cat /tmp/report.md` `npm run build` `../private/report.md` `outputs/../private.md`\n\n```text\n/tmp/example.md\n```\n\n[Named](/tmp/named.md)';
 const html=renderVerified(text);
 expect((html.match(/role="link"/g)??[])).toHaveLength(4);
 expect(html).toContain('<code>outputs/接入要求 one.md</code>');
 expect(messageLinks(text).map(link=>link.href)).toEqual(['/tmp/report one.md','outputs/接入要求 one.md','.mandala/outputs/conversations/chat/result.md','/tmp/named.md']);
 expect(conversationFiles([{kind:'text',key:1,text}],'chat',new Set(messageLinks(text).map(link=>link.href))).map(file=>file.detail)).toEqual(['/tmp/named.md','.mandala/outputs/conversations/chat/result.md','outputs/接入要求 one.md','/tmp/report one.md']);
});

it('keeps code inside named links a single link and excludes encoded traversal and shell fragments', () => {
 const text='[`outputs/report.md`](/tmp/real.md) `outputs/%2e%2e/secret.md` `outputs/report.md;cat` `https://example.com/report.md` `cat outputs/report.md` `python ./scripts/run.py` `./scripts/run.py --out=result.md`';
 const html=renderVerified(text);
 expect((html.match(/role="link"/g)??[])).toHaveLength(1);
 expect(messageLinks(text).map(link=>link.href)).toEqual(['/tmp/real.md']);
});

it('keeps nested reference definitions consistent with rendered Markdown links', () => {
 const text='> [Nested][report]\n>\n> [report]: /tmp/nested.md';
 const html=renderVerified(text);
 expect(html).toContain('role="link"');
 expect(messageLinks(text).map(link=>link.href)).toEqual(['/tmp/nested.md']);
});

it('gives each table its own copy action and preserves spreadsheet values and empty cells', () => {
 const text='Before\n\n| Name | Empty | Value |\n| --- | --- | --- |\n| **alpha** | | 001.20 |\n| beta | | 9007199254740993 |\n\nBetween\n\n| Second |\n| --- |\n| other |\n\nAfter';
 const html=renderVerified(text);
 expect((html.match(/aria-label="复制表格"/g)??[])).toHaveLength(2);
 expect(tableTsv([['Name','Empty','Value'],['alpha','','001.20'],['beta','','9007199254740993']])).toBe('Name\tEmpty\tValue\nalpha\t\t001.20\nbeta\t\t9007199254740993');
 expect(tableTsv([['a\tb','line\nbreak','a"b','']])).toBe('"a\tb"\t"line\nbreak"\t"a""b"\t');
});
it('keeps authorized asset and external links usable without allowing script URLs', () => {
 const html=renderChineseMarkup(React.createElement(MarkdownMessage, { text: "[清单](/assets?asset=example) [网站](https://example.com) [恶意](javascript:alert%281%29)" }));
 expect(html).toContain('href="/assets?asset=example"');
 expect(html).toContain('href="https://example.com"');
 expect(html).not.toContain('href="javascript:');
});

it('opts Wiki into only canonical Library and conversation links without changing default Markdown permissions',()=>{
 const text='[Library](/library/asset-id?version=v1) [Chat](/?conversation=chat-id) [Other](/settings) [Host](//evil.example) [Script](javascript:alert%281%29)';
 const normal=renderChineseMarkup(React.createElement(MarkdownMessage,{text}));expect(normal).not.toContain('href="/library/');expect(normal).not.toContain('href="/?conversation=');
 const wiki=renderChineseMarkup(React.createElement(MarkdownMessage,{text,workspaceLinks:true}));expect(wiki).toContain('href="/library/asset-id?version=v1"');expect(wiki).toContain('href="/?conversation=chat-id"');expect(wiki).not.toContain('href="/settings"');expect(wiki).not.toContain('javascript:');
});

it('maps actual legacy Wiki anchors while preserving inline and fenced code literals',()=>{
 const literal='[source](/assets/asset-id?version=v1) [conversation](/chat/chat-id)';
 const text=literal+'\n\n`'+literal+'`\n\n```text\n'+literal+'\n```';
 const html=renderChineseMarkup(React.createElement(MarkdownMessage,{text,workspaceLinks:true}));
 expect(html).toContain('href="/library/asset-id?version=v1"');expect(html).toContain('href="/?conversation=chat-id"');
 expect(html).toContain('<code>'+literal+'</code>');expect(html).toContain(literal+'\n</code>');
 const normal=renderChineseMarkup(React.createElement(MarkdownMessage,{text:literal}));expect(normal).toContain('href="/assets/asset-id?version=v1"');expect(normal).not.toContain('href="/?conversation=');
});
