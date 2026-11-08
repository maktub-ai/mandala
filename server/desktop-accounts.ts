import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountUser } from './account-store';

export type DesktopLease={user:AccountUser;token:string;expiresAt:number;csrfToken:string;localToken:string};
type State={issuer?:string;active?:DesktopLease;profiles:Record<string,{legacy:boolean}>};
export function desktopPartition(id:string){return createHash('sha256').update(id).digest('hex');}
export function validateDesktopLease(lease: Omit<DesktopLease,'localToken'>) {
 if(typeof lease.user?.id!=='string'||!lease.user.id||lease.user.id.length>200||!Number.isFinite(lease.expiresAt)||lease.expiresAt<=Date.now()||typeof lease.token!=='string'||!lease.token||typeof lease.csrfToken!=='string'||!lease.csrfToken)throw Error('Invalid account session');
}
/** Account data stays on disk; this index holds identity/session metadata, never conversations. */
export function openDesktopAccounts(root:string,issuer?:string){
 const dir=join(root,'account-gateway');mkdirSync(dir,{recursive:true,mode:0o700});
 const file=join(dir,'desktop-accounts.json');
 let state:State=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{profiles:{}};
 if(issuer&&state.issuer&&state.issuer!==issuer)throw Error('Account service changed; use a separate data root');
 if(issuer)state.issuer=issuer;
 const save=()=>{writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(file+'.tmp',file);};
 return {
  current(){return state.active&&state.active.expiresAt>Date.now()?state.active:undefined;},
  legacyAvailable(){return existsSync(join(root,'state.sqlite'))&&!Object.values(state.profiles).some(p=>p.legacy);},
  plannedHome(id:string,claimLegacy:boolean){const profile=state.profiles[desktopPartition(id)];return (profile?profile.legacy:claimLegacy&&this.legacyAvailable())?root:join(root,'profiles',desktopPartition(id));},
  home(id:string){const key=desktopPartition(id);if(!state.profiles[key])throw Error('Unknown account profile');return state.profiles[key].legacy?root:join(root,'profiles',key);},
  activate(lease:Omit<DesktopLease,'localToken'>,claimLegacy:boolean){
   validateDesktopLease(lease);
   const key=desktopPartition(lease.user.id);
   if(!state.profiles[key])state.profiles[key]={legacy:claimLegacy&&this.legacyAvailable()};
   state.active={...lease,localToken:randomBytes(32).toString('base64url')};save();return state.active;
  },
  logout(){state.active=undefined;save();},
 };
}
