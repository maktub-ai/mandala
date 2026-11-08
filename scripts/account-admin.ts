import { productEnv, productHome } from "../cli/product-env.mjs";
import { openAccountStore } from '../server/account-store';

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const username = value('--username');
if(args.includes('--stats')){
 if(args.some(arg=>!['--stats','--home',value('--home')].includes(arg)))throw Error('Usage: account-admin --stats [--home ACCOUNT_DIRECTORY]');
 const statsStore=openAccountStore(value('--home')??productEnv('CONTROL_HOME')??productHome('control'));
 console.log(JSON.stringify(statsStore.statistics(),null,2));statsStore.close();process.exit(0);
}
if (!username || args.some(arg => !['--username', '--home', username, value('--home')].includes(arg))) throw new Error('Usage: account-admin --username NAME [--home ACCOUNT_DIRECTORY]; password via stdin or MANDALA_ACCOUNT_PASSWORD (or OPEN_MANA_ACCOUNT_PASSWORD)');
const home = value('--home') ?? productEnv('ACCOUNT_HOME') ?? productHome();
let password = productEnv('ACCOUNT_PASSWORD') ?? '';
if (!password) {
  if (process.stdin.isTTY) throw new Error('Supply password through piped stdin or MANDALA_ACCOUNT_PASSWORD (or OPEN_MANA_ACCOUNT_PASSWORD); it is never accepted as a command argument');
  for await (const chunk of process.stdin) { password += chunk; if (password.length > 1026) throw new Error('Password too long'); }
  password = password.replace(/\r?\n$/, '');
}
const store = openAccountStore(home);
try { const user = await store.createUser(username, password); console.log(`Created account ${user.username} (${user.id})`); } finally { store.close(); }
