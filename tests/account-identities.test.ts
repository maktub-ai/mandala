import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccountStore } from '../server/account-store';

test('provider subject identifies users; matching email never silently links identities', () => {
 const home=mkdtempSync(join(tmpdir(),'mandala-identities-'));
 try {
  const store=openAccountStore(home);
  const a=store.identityUser('google','google-sub','same@example.com','Alice');
  expect(store.identityUser('google','google-sub','changed@example.com','Alice').id).toBe(a.id);
  expect(store.identityUser('github','123','same@example.com','Alice').id).not.toBe(a.id);
  expect(store.identityUser('email','same@example.com','same@example.com').id).not.toBe(a.id);
  const session=store.createSession(a.id);
  expect(store.session(session.token)?.user.lastLoginAt).toBeTruthy();
  expect(store.statistics().registeredUsers).toBe(3);
  expect(JSON.stringify(store.listUsers())).not.toMatch(/passwordHash|salt|tokenHash/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
