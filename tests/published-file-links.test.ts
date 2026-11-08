import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import MarkdownMessage from '../src/MarkdownMessage';

const file={name:'reading_list_last_30d.xlsx',assetId:'asset-one',versionId:'fixed-one',fileId:'0'};
const render=(text:string,files=[file])=>renderToStaticMarkup(React.createElement(MarkdownMessage,{text,publishedFiles:files}));

it('opens an inline published filename at its recorded version, retaining the code formatting',()=>{
 const html=render('**`'+file.name+'`**（366KB，已通过 assets publish 发布，assetId `asset-one`）');
 expect(html).toContain('href="/assets/asset-one?version=fixed-one"');
 expect(html).toContain('<code>'+file.name+'</code>');
 expect(html).not.toContain('href="asset-one"');
});

it('never links invented filenames, fenced commands, or ambiguous published names',()=>{
 expect(render('`invented.xlsx`')).not.toContain('<a ');
 expect(render('```text\n'+file.name+'\n```')).not.toContain('<a ');
 expect(render('`'+file.name+'`',[file,{...file,assetId:'other'}])).not.toContain('<a ');
});

it('supports manifest subdirectories and explicit filename links without altering external links',()=>{
 const html=render('[Workbook]('+file.name+') and `'+file.name+'` and [Help](https://example.com)',[{...file,name:'reports/'+file.name}]);
 expect((html.match(/href="\/assets\/asset-one\?version=fixed-one"/g)??[])).toHaveLength(2);
 expect(html).toContain('href="https://example.com"');
});

for(const name of ['资产.xlsx','my report.xlsx','报告%20.xlsx'])it('opens the exact published filename '+name,()=>{
 expect(render('`'+name+'`',[{...file,name}])).toContain('href="/assets/asset-one?version=fixed-one"');
});

it('keeps literal percent names distinct from Unicode names before Markdown URI normalization',()=>{
 const html=render('`资产.xlsx` and `%E8%B5%84%E4%BA%A7.xlsx`',[{...file,name:'资产.xlsx'},{...file,name:'%E8%B5%84%E4%BA%A7.xlsx',assetId:'literal-percent'}]);
 expect(html).toMatch(/href="\/assets\/asset-one\?version=fixed-one"[^>]*>[\s\S]*?<code>资产.xlsx<\/code>/);
 expect(html).toMatch(/href="\/assets\/literal-percent\?version=fixed-one"[^>]*>[\s\S]*?<code>%E8%B5%84%E4%BA%A7.xlsx<\/code>/);
});
