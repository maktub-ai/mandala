import { test,expect,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDesktopAccounts } from '../server/desktop-accounts';
const grant=(id:string)=>({user:{id,username:id,createdAt:new Date().toISOString()},token:'cloud-session',csrfToken:'csrf',expiresAt:Date.now()+60000});
test('each account has a stable private profile; legacy data is claimed once, logout and expiry lock access',()=>{
 const root=mkdtempSync(join(tmpdir(),'mandala-profiles-'));
 try{
  writeFileSync(join(root,'state.sqlite'),'legacy sentinel');const a=openDesktopAccounts(root);
  expect(a.current()).toBeUndefined();a.activate(grant('alice'),true);expect(a.home('alice')).toBe(root);
  const old=a.current()!.localToken;a.logout();expect(a.current()).toBeUndefined();
  a.activate(grant('bob'),true);expect(a.home('bob')).not.toBe(root);expect(a.current()!.localToken).not.toBe(old);
  expect(a.legacyAvailable()).toBe(false);a.logout();a.activate(grant('alice'),false);expect(a.home('alice')).toBe(root);
  expect(openDesktopAccounts(root).current()?.user.id).toBe('alice');
  expect(()=>a.activate({...grant('expired'),expiresAt:Date.now()-1},false)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('offline leases expire and profiles cannot be reused under another account issuer',()=>{
 const root=mkdtempSync(join(tmpdir(),'mandala-issuer-'));
 const now=Date.now();
 try{
  const accounts=openDesktopAccounts(root,'https://account.mandala.pub');accounts.activate(grant('alice'),false);
  expect(openDesktopAccounts(root,'https://account.mandala.pub').current()?.user.id).toBe('alice');
  expect(()=>openDesktopAccounts(root,'https://another.example')).toThrow('Account service changed');
  vi.spyOn(Date,'now').mockReturnValue(now+120000);
  expect(accounts.current()).toBeUndefined();expect(openDesktopAccounts(root).current()).toBeUndefined();
 }finally{vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});}
});
