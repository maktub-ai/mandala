import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it.each(['Approve','Deny',undefined,'error'])('permission gate executes a tool only after explicit approval: %s',async result=>{
 const source=await readFile(new URL('../server/pi-permission-extension.mjs',import.meta.url),'utf8');
 const extension=(await import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
 let hook: any;extension({registerCommand(){},on:(name:string,handler:any)=>{expect(name).toBe('tool_call');hook=handler;}});
 let effect=false;const response=await hook({toolName:'write',toolCallId:'call',input:{path:'file',content:'x'}},{ui:{select:async(title:string,options:string[])=>{expect(title).toContain('Mandala tool approval: ');expect(options).toEqual(['Approve','Deny']);if(result==='error')throw Error('UI unavailable');return result;}}});
 if(!response?.block)effect=true;
 expect(effect).toBe(result==='Approve');
});
