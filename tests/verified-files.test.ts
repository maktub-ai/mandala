import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownMessage from '../src/MarkdownMessage';
import { conversationFiles } from '../src/conversationFiles';
import { isInlineFileReference } from '../shared/local-file-links';

it('leaves unverified local links plain and out of the conversation file list', () => {
 const text='[unknown](/tmp/missing-report.md) `outputs/report.md` [External](https://example.com/report.md)';
 const html=renderToStaticMarkup(React.createElement(MarkdownMessage,{text}));
 expect(html).not.toContain('data-source="local"');
 expect(html).not.toContain('role="link"');
 expect(html).toContain('href="https://example.com/report.md"');
 expect(conversationFiles([{kind:'text',key:1,text}],'chat')).toEqual([]);
});
it('rejects cloud, template, glob and remote path examples before resolution', () => {
 for (const path of ['.../data/BILLING_PERIOD=YYYY-MM/*.parquet','data/*.parquet','/tmp/*.md','/tmp/{name}.md','outputs/YYYY-MM/report.csv','s3://bucket/file.parquet','gs://bucket/file.csv','user@host:/tmp/file.md','\\\\host\\share\\file.md']) expect(isInlineFileReference(path),path).toBe(false);
});
it('batch resolves only authorized existing files and retains secret/symlink boundaries', async () => {
 const {resolveConversationLocalFiles}=await import('../server/local-files');
 const home=await realpath(await mkdtemp(join(tmpdir(),'mana-resolve-'))),cwd=join(home,'workspace');
 try {
  await mkdir(cwd); await writeFile(join(cwd,'report.md'),'report'); await writeFile(join(cwd,'.env'),'secret');
  await writeFile(join(home,'outside.md'),'outside'); await symlink(join(home,'outside.md'),join(cwd,'escape.md'));
  const literal=join(cwd,'report[1]*.md');
  await writeFile(literal,'Literal filename, not an inferred delivery');
  expect(await resolveConversationLocalFiles([literal],{cwd,roots:[cwd],linkedPaths:new Set([literal]),absoluteLinkedPaths:new Set([literal])})).toEqual({hrefs:[]});
  const outside=join(home,'outside.md');
  expect(await resolveConversationLocalFiles([outside],{cwd,roots:[cwd],linkedPaths:new Set([outside]),absoluteLinkedPaths:new Set([outside])})).toEqual({hrefs:[]});
  const hrefs=['./report.md','./missing.md','./.env','./escape.md','./unlinked.md'];
  await writeFile(join(cwd,'unlinked.md'),'unlinked');
  const linkedPaths=new Set(hrefs.slice(0,4).map(href=>join(cwd,href)));
  expect(await resolveConversationLocalFiles(hrefs,{cwd,roots:[cwd,home],linkedPaths,absoluteLinkedPaths:new Set()})).toEqual({hrefs:['./report.md']});
  await expect(resolveConversationLocalFiles(Array(4097).fill('./report.md'),{cwd,roots:[cwd],linkedPaths,absoluteLinkedPaths:new Set()})).rejects.toMatchObject({status:400});
  await expect(resolveConversationLocalFiles(Array(1000).fill('./'+ '报告'.repeat(100) + '.md'),{cwd,roots:[cwd],linkedPaths,absoluteLinkedPaths:new Set()})).rejects.toMatchObject({status:400});
 } finally { await rm(home,{recursive:true,force:true}); }
});

it('normalizes both verified and rendered mixed-encoded hrefs exactly once', async () => {
 const {VerifiedFilesContext,hasVerifiedFile}=await import('../src/VerifiedFilesContext');
 for (const href of ['/tmp/报告%20one.md','/tmp/报告%25one.md','/tmp/报告%2520one.md']) {
  const html=renderToStaticMarkup(React.createElement(VerifiedFilesContext.Provider,{value:new Set([href]),children:React.createElement(MarkdownMessage,{text:`[report](<${href}>)`})}));
  expect(html,href).toContain('role="link"');
 }
 expect(hasVerifiedFile(new Set(['/tmp/报告%2520one.md']),'/tmp/%E6%8A%A5%E5%91%8A%2520one.md')).toBe(true);
 expect(hasVerifiedFile(new Set(['/tmp/报告%2520one.md']),'/tmp/%E6%8A%A5%E5%91%8A%20one.md')).toBe(false);
 expect(hasVerifiedFile(new Set(['/tmp/报告%20one.md']),'/tmp/%E6%8A%A5%E5%91%8A%2520one.md')).toBe(false);
});
it('uses one bounded batch for4096 short refs and byte-bounds longer unicode paths', async () => {
 const {fileReferenceBatches}=await import('../src/VerifiedFilesContext');
 const short=Array.from({length:4096},(_,i)=>`./reports/${i}.md`);
 expect(fileReferenceBatches(short)).toHaveLength(1);
 const long=Array.from({length:1000},(_,i)=>`./reports/${'报告'.repeat(100)}${i}.md`);
 const batches=fileReferenceBatches(long);
 expect(batches.length).toBeGreaterThan(1);
 expect(batches.flat()).toEqual(long);
 for(const batch of batches) expect(Buffer.byteLength(JSON.stringify({hrefs:batch}))).toBeLessThanOrEqual(240*1024);
});
it('publishes completed batches and retains them when a later batch times out', async () => {
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext');
 vi.useFakeTimers();
 const candidates=Array.from({length:4097},(_,i)=>`./reports/${i}.md`);
 const published:ReadonlySet<string>[]=[];
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hrefs:[candidates[0]]})})
  .mockImplementationOnce((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')))));
 vi.stubGlobal('fetch',fetcher);
 try {
  const pending=resolveFileReferenceBatches('chat',candidates,new AbortController().signal,files=>published.push(files));
  const failed=expect(pending).rejects.toMatchObject({name:'AbortError'});
  await vi.advanceTimersByTimeAsync(10001);
  await failed;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(published.map(files=>[...files])).toEqual([[candidates[0]]]);
 } finally {vi.unstubAllGlobals();vi.useRealTimers();}
});

it('retries a conflicting read-only batch once and preserves completed batches', async()=>{
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext');
 const candidates=Array.from({length:4097},(_,i)=>`./reports/${i}.md`),published:ReadonlySet<string>[]=[];
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({hrefs:[candidates[0]]})))
  .mockResolvedValueOnce(new Response('',{status:409}))
  .mockResolvedValueOnce(new Response(JSON.stringify({hrefs:[candidates[4096],'./unrequested.md']})));
 vi.stubGlobal('fetch',fetcher);
 try{
  await resolveFileReferenceBatches('chat',candidates,new AbortController().signal,files=>published.push(files));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[2][1].body);
  expect(published.map(files=>[...files])).toEqual([[candidates[0]],[candidates[0],candidates[4096]]]);
 }finally{vi.unstubAllGlobals();}
});
it.each([403,404,500,409])('stops after a retry returns HTTP %s without publishing unauthorized files',async status=>{
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext'),publish=vi.fn();
 const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:409})).mockResolvedValueOnce(new Response('',{status}));vi.stubGlobal('fetch',fetcher);
 try{await expect(resolveFileReferenceBatches('chat',['./report.md'],new AbortController().signal,publish)).rejects.toThrow('File resolution unavailable');expect(fetcher).toHaveBeenCalledTimes(2);expect(publish).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it.each([403,404,500])('never retries an initial HTTP %s',async status=>{
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext'),fetcher=vi.fn().mockResolvedValue(new Response('',{status}));vi.stubGlobal('fetch',fetcher);
 try{await expect(resolveFileReferenceBatches('chat',['./report.md'],new AbortController().signal,vi.fn())).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);}finally{vi.unstubAllGlobals();}
});
it('does not retry a conflict after cancellation',async()=>{
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext'),controller=new AbortController(),publish=vi.fn();
 const fetcher=vi.fn().mockImplementation(async()=>{controller.abort();return new Response('',{status:409});});vi.stubGlobal('fetch',fetcher);
 try{await resolveFileReferenceBatches('chat',['./report.md'],controller.signal,publish);expect(fetcher).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it('shares the original ten-second batch deadline across the conflict retry',async()=>{
 const {resolveFileReferenceBatches}=await import('../src/VerifiedFilesContext');vi.useFakeTimers();const publish=vi.fn();
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>setTimeout(()=>resolve(new Response('',{status:409})),9000)))
  .mockImplementationOnce((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')))));vi.stubGlobal('fetch',fetcher);
 try{const outcome=resolveFileReferenceBatches('chat',['./report.md'],new AbortController().signal,publish).catch(error=>error);await vi.advanceTimersByTimeAsync(9000);expect(fetcher).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1000);expect(await outcome).toMatchObject({name:'AbortError'});expect(publish).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();vi.useRealTimers();}
});
