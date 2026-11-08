import { expect, it } from 'vitest';
import { conversationFiles, linkSource } from '../src/conversationFiles';
import { diffRows, splitRows } from '../src/diffRows';

it('collects only visible message file links and uploads, deduplicating recent references',()=>{
 const messages=[{kind:'text' as const,key:1,text:'[Report][r]\n\n[r]: /tmp/report.md\n\n`[fake](/tmp/no.md)`\n\n```\n[x](/tmp/code.md)\n```\n\n[Website](https://openai.com)'},
 {kind:'user' as const,key:2,text:'[Updated](/tmp/report.md)',attachments:[{id:'a',name:'brief.txt',mimeType:'text/plain',size:10,path:'/private/brief.txt'}]}];
 expect(conversationFiles(messages,'chat',new Set(['/tmp/report.md'])).map(item=>item.name)).toEqual(['brief.txt','Updated']);
 expect(conversationFiles(messages,'chat',new Set(['/tmp/report.md']))[0].target).toMatchObject({kind:'attachment',name:'brief.txt'});
 expect(linkSource('/tmp/report.md')).toBe('local');
 expect(linkSource('https://github.com/example/repo')).toBe('repository');
 expect(linkSource('/api/v2/assets/abc/versions/v1/files/f')).toBe('material');
 expect(linkSource('/assets/doc?version=v1')).toBe('material');
 expect(linkSource('https://example.org')).toBe('web');
});
it('numbers multiple diff hunks and aligns replacements without treating headers as content',()=>{
 const rows=diffRows('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,2 +4,3 @@\n-old\n+new\n+extra\n keep\n@@ -20 +21 @@\n-last\n+end\n\\ No newline at end of file\n');
 expect(rows.filter(r=>r.kind==='add').map(r=>r.newLine)).toEqual([4,5,21]);
 expect(rows.filter(r=>r.kind==='remove').map(r=>r.oldLine)).toEqual([4,20]);
 const split=splitRows(rows);
 expect(split[1]).toMatchObject({left:{text:'old',oldLine:4},right:{text:'new',newLine:4}});
 expect(split[2]).toMatchObject({right:{text:'extra',newLine:5}});
 expect(split[2].left).toBeUndefined();
});

it('decorates links in user messages without interpreting the surrounding literal text or unsafe URLs',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {LinkedMessageText}=await import('../src/MarkdownMessage');
 const html=renderToStaticMarkup(React.createElement(LinkedMessageText,{text:'<custom> **literal** [report](/tmp/report.md) [unsafe](javascript:alert) `code`'}));
 expect(html).toContain('&lt;custom&gt; **literal**');
 expect(html).not.toContain('data-source="local"');
 expect(html).toContain('report');
 expect(html).toContain('[unsafe](javascript:alert) `code`');
 expect(html).not.toContain('href="javascript:');
});
