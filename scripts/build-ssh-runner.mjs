import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let build;try{({build}=require('../desktop/node_modules/esbuild/lib/main.js'));}catch{({build}=require('esbuild'));}
import {mkdir,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const outdir=fileURLToPath(new URL('../release/ssh-runner/',import.meta.url));
await mkdir(outdir,{recursive:true});
await build({entryPoints:{'ssh-runner':root+'server/ssh-runner.ts','mandala':root+'cli/mandala.mjs'},outdir,outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'},logLevel:'info'});

await cp(root+'server/pi-permission-extension.mjs',outdir+'pi-permission-extension.mjs');
