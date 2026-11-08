import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Native settings may contain hooks and extensions; only import Anthropic routing.
export async function claudeNativeEnv(explicit:Record<string,string>={},home=homedir()):Promise<Record<string,string>> {
 let settings:{env?:Record<string,unknown>};
 try {settings=JSON.parse(await readFile(join(explicit.CLAUDE_CONFIG_DIR??process.env.CLAUDE_CONFIG_DIR??join(home,'.claude'),'settings.json'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return explicit;throw new Error('Cannot read native Claude authentication settings');}
 const native=Object.fromEntries(Object.entries(settings.env??{}).filter(([key,value])=>/^ANTHROPIC_[A-Z_]+$/.test(key)&&typeof value==='string')) as Record<string,string>;
 // Ambient authentication is also an explicit launch choice.
 for(const key of Object.keys(native))if(process.env[key]!==undefined)native[key]=process.env[key]!;
 return {...native,...explicit};
}
