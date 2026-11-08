import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Prevent the specific browser-default UI regressions found during the design audit.
// This guards components, not aesthetic quality; screenshots still require review.
function sources(directory: string): string[] {
 return readdirSync(directory, {withFileTypes:true}).flatMap(item => item.isDirectory()
  ? sources(join(directory,item.name)) : item.name.endsWith('.tsx') ? [join(directory,item.name)] : []);
}
test('product controls use the shared Select, Disclosure and icon library', () => {
 const violations: string[] = [];
 for(const file of sources('src')) {
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(node: ts.Node) {
   if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) {
    const tag=node.tagName.getText(ast),location=relative('src',file);
    if(tag==='select')violations.push(location+': native select');
    if(tag==='details'&&location!=='ui/Disclosure.tsx') {
     const specialized=location==='ExecutionTrace.tsx'&&node.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(ast)==='className'&&attr.initializer?.getText(ast)==='"operation-card"');
     if(!specialized)violations.push(location+': unmanaged disclosure');
    }
   }
   if(ts.isJsxText(node)&&/[←▶▼]/.test(node.text))violations.push(file+': text used as navigation icon');
   ts.forEachChild(node,visit);
  }
  visit(ast);
 }
 expect(violations).toEqual([]);
});

// Visual language v2 (DESIGN.md "Page anatomy and type roles"). These guard the shared scale and
// page skeleton; they do not judge layout quality, which still needs rendered review.
function stylesheets(directory: string): string[] {
 return readdirSync(directory, {withFileTypes:true}).flatMap(item => item.isDirectory()
  ? stylesheets(join(directory,item.name)) : item.name.endsWith('.css') ? [join(directory,item.name)] : []);
}
const tokenSources = new Set(['ui/tokens.css']);
// Fixed content tones approved in DESIGN.md: code syntax, diff lines and Memory layer kinds.
const colorSources = new Set([...tokenSources, 'code-highlight.css', 'diff-preview.css', 'memory.css']);
const productCss = () => stylesheets('src').map(file => ({ location: relative('src', file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
test('product stylesheets use the shared type roles and weights', () => {
 const violations: string[] = [];
 for (const { location, text } of productCss()) {
  if (tokenSources.has(location)) continue;
  for (const match of text.matchAll(/font-size:\s*(1[234])px\b/g)) violations.push(`${location}: font-size ${match[1]}px (use --type-meta / --type-ui / --type-body)`);
  for (const match of text.matchAll(/font-weight:\s*(\d+)\b/g)) if (!['400', '500', '600'].includes(match[1])) violations.push(`${location}: font-weight ${match[1]}`);
 }
 expect(violations).toEqual([]);
});
test('colors come from theme roles outside approved content tones', () => {
 const violations: string[] = [];
 for (const { location, text } of productCss()) {
  if (colorSources.has(location)) continue;
  // A literal is allowed only as the fallback of a role, e.g. var(--success,#52a879).
  const withoutFallbacks = text.replace(/var\(--[\w-]+\s*,[^)]*\)/g, '');
  for (const match of withoutFallbacks.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) violations.push(`${location}: ${match[0]}`);
 }
 expect(violations).toEqual([]);
});
test('page headers carry no rule; space separates header, toolbar and content', () => {
 const violations: string[] = [];
 for (const { location, text } of productCss()) {
  for (const rule of text.matchAll(/([^{}]*workspace-page-header[^{}]*)\{([^}]*)\}/g)) {
   const selector = rule[1].trim().split(',').filter(part => /workspace-page-header\s*$/.test(part.trim()));
   if (!selector.length) continue;
   for (const declaration of rule[2].matchAll(/border(?:-bottom)?\s*:\s*([^;]+)/g)) if (!/^(0|none)\b/.test(declaration[1].trim())) violations.push(`${location}: ${selector.join(',').trim()} { border: ${declaration[1].trim()} }`);
  }
 }
 expect(violations).toEqual([]);
});
