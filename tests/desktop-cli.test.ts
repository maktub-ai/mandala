import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync,fsyncSync,readdirSync,renameSync,linkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {desktopCliStatus,installDesktopCli} from '../desktop/cli-registration';
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();return{...actual,fsyncSync:vi.fn(actual.fsyncSync),renameSync:vi.fn(actual.renameSync),linkSync:vi.fn(actual.linkSync)};});
const roots:string[]=[];
function fixture(){const root=mkdtempSync(join(tmpdir(),"mandala-cli 'quoted-"));roots.push(root);const runtime=join(root,'App Resources','runtime'),userHome=join(root,'user'),home=join(root,'workspace');mkdirSync(join(runtime,'bin'),{recursive:true});mkdirSync(join(runtime,'scripts'));mkdirSync(join(runtime,'cli'));mkdirSync(userHome);writeFileSync(join(runtime,'bin','node'),'#!/bin/sh\nprintf \'%s\\n\' "$@"\n',{mode:0o755});writeFileSync(join(runtime,'scripts','desktop-cli.mjs'),'');writeFileSync(join(runtime,'cli','mandala.mjs'),'');return{runtime,userHome,home,platform:'darwin' as NodeJS.Platform,path:''};}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('installs only an explicit user launcher and reports actual PATH availability',()=>{const options=fixture(),before=desktopCliStatus(options);expect(before).toMatchObject({installed:false,inPath:false,runtimeReady:true});const installed=installDesktopCli(options);expect(installed).toMatchObject({installed:true,inPath:false,shadowed:false});expect(execFileSync(installed.launcherPath,['--value','a b',"single'quote"],{encoding:'utf8'}).trim().split('\n')).toEqual([join(options.runtime,'scripts','desktop-cli.mjs'),options.home,'--value','a b',"single'quote"]);expect(desktopCliStatus({...options,path:join(options.userHome,'.local','bin')})).toMatchObject({installed:true,inPath:true,shadowed:false});});
it('preserves foreign files, dangling symlinks and redirected directories',()=>{for(const kind of ['file','symlink','directory'] as const){const options=fixture(),directory=join(options.userHome,'.local','bin');mkdirSync(directory,{recursive:true});const target=join(directory,'mandala');if(kind==='file')writeFileSync(target,'foreign');else if(kind==='symlink')symlinkSync(join(options.userHome,'missing'),target);else mkdirSync(target);expect(()=>installDesktopCli(options)).toThrow();if(kind==='file')expect(readFileSync(target,'utf8')).toBe('foreign');}const options=fixture();symlinkSync(join(options.runtime,'bin'),join(options.userHome,'.local'));expect(()=>installDesktopCli(options)).toThrow();});
it('backs up an outdated managed launcher and preserves an earlier PATH command',()=>{const options=fixture();installDesktopCli(options);const other=join(options.userHome,'existing');mkdirSync(other);writeFileSync(join(other,'mandala'),'#!/bin/sh\nexit 0\n',{mode:0o755});const next={...options,home:join(options.home,'changed'),path:other+':'+join(options.userHome,'.local','bin')};expect(desktopCliStatus(next)).toMatchObject({updateAvailable:true,installed:false,shadowed:true});const original=readFileSync(join(options.userHome,'.local','bin','mandala'),'utf8');const updated=installDesktopCli(next);expect(updated.installed).toBe(true);expect(readFileSync(updated.backupPath!,'utf8')).toBe(original);expect(readFileSync(join(other,'mandala'),'utf8')).toContain('exit 0');chmodSync(join(options.runtime,'bin','node'),0o600);expect(()=>installDesktopCli(next)).toThrow();});
it('does not claim Windows registration support',()=>{expect(desktopCliStatus({...fixture(),platform:'win32'})).toMatchObject({supported:false,installed:false});});
it('packages and executes the bootstrap with bundled Node, help offline and no fallback runtime',async()=>{
 const {build}=await import('esbuild'),{copyFileSync,cpSync}=await import('node:fs'),{spawnSync}=await import('node:child_process');
 const options=fixture();copyFileSync(process.execPath,join(options.runtime,'bin','node'));chmodSync(join(options.runtime,'bin','node'),0o755);cpSync('cli',join(options.runtime,'cli'),{recursive:true});
 await build({entryPoints:['desktop/cli-entry.ts'],outfile:join(options.runtime,'scripts','desktop-cli.mjs'),bundle:true,platform:'node',format:'esm',target:'node22'});
 expect(readFileSync('scripts/build-desktop.mjs','utf8')).toContain("'scripts/desktop-cli': join(desktop, 'cli-entry.ts')");
 const installed=installDesktopCli(options),env={PATH:'/usr/bin:/bin',HOME:options.userHome};
 const help=spawnSync(installed.launcherPath,['--help'],{env,encoding:'utf8'});expect(help.status,help.stderr).toBe(0);const lines=help.stdout.trim().split('\n');expect(lines).toHaveLength(1);expect(JSON.parse(lines[0]).ok).toBe(true);
 const request=spawnSync(installed.launcherPath,['tasks','list'],{env,encoding:'utf8'});expect(request.status).toBe(1);expect(JSON.parse(request.stderr).error.code).toBe('desktop_runtime_unavailable');expect(request.stderr).not.toContain('4332');
});

it('cleans only its staged file after a write failure and allows an explicit retry',()=>{
 const options=fixture();vi.mocked(fsyncSync).mockImplementationOnce(()=>{throw Error('Synthetic disk failure');});
 expect(()=>installDesktopCli(options)).toThrow('Synthetic disk failure');
 expect(readdirSync(join(options.userHome,'.local','bin'))).toEqual([]);
 expect(installDesktopCli(options).installed).toBe(true);
 const original=readFileSync(join(options.userHome,'.local','bin','mandala'),'utf8');
 vi.mocked(fsyncSync).mockImplementationOnce(()=>{throw Error('Synthetic update failure');});
 expect(()=>installDesktopCli({...options,home:options.home+'-changed'})).toThrow('Synthetic update failure');
 expect(readFileSync(join(options.userHome,'.local','bin','mandala'),'utf8')).toBe(original);
});

it('recognizes the legacy App launcher and backs it up before explicit registration',()=>{
 const options=fixture(),directory=join(options.userHome,'.local','bin');mkdirSync(directory,{recursive:true});
 const legacy='#!/bin/sh\nexec "'+join(options.runtime,'bin','node')+'" "'+join(options.runtime,'cli','mandala.mjs')+'" "$@"\n';
 writeFileSync(join(directory,'mandala'),legacy,{mode:0o755});
 expect(desktopCliStatus(options)).toMatchObject({installed:false,conflict:false,updateAvailable:true});
 const updated=installDesktopCli(options);expect(updated.installed).toBe(true);expect(updated.backupPath).toBeTruthy();expect(readFileSync(updated.backupPath!,'utf8')).toBe(legacy);
});

it('restores foreign files or symlinks swapped in during a managed update',async()=>{
 const actual=await vi.importActual<typeof import('node:fs')>('node:fs');
 for(const kind of ['file','symlink'] as const){
  const options=fixture();installDesktopCli(options);const path=join(options.userHome,'.local','bin','mandala');
  vi.mocked(renameSync).mockImplementationOnce((from,to)=>{rmSync(path);if(kind==='file')writeFileSync(path,'foreign replacement');else symlinkSync(join(options.userHome,'foreign-target'),path);actual.renameSync(from,to);});
  expect(()=>installDesktopCli({...options,home:options.home+'-new'})).toThrow();
  if(kind==='file')expect(readFileSync(path,'utf8')).toBe('foreign replacement');else expect(lstatSync(path).isSymbolicLink()).toBe(true);
 }
});
it('restores the previous command if publishing its update fails',()=>{
 const options=fixture();installDesktopCli(options);const path=join(options.userHome,'.local','bin','mandala'),original=readFileSync(path,'utf8');
 vi.mocked(linkSync).mockImplementationOnce(()=>{throw Error('Synthetic publication failure');});
 expect(()=>installDesktopCli({...options,home:options.home+'-new'})).toThrow('Synthetic publication failure');expect(readFileSync(path,'utf8')).toBe(original);
});
