import { expect, it } from 'vitest';
import { newRemoteKey, sealRemote, openRemote, remoteKeyFingerprint, ReplayWindow } from '../shared/remote-crypto';
it('authenticates encrypted records to both pinned peers and detects tampering', () => {
 const host=newRemoteKey(),phone=newRemoteKey(),stranger=newRemoteKey();
 const wire=sealRemote({id:'private-marker',value:[0,255]},host.publicKey,phone.secretKey);
 expect(wire).not.toContain('private-marker');
 expect(openRemote(wire,phone.publicKey,host.secretKey)).toEqual({id:'private-marker',value:[0,255]});
 expect(()=>openRemote(wire,stranger.publicKey,host.secretKey)).toThrow();
 expect(()=>openRemote(wire,phone.publicKey,stranger.secretKey)).toThrow();
 const changed=JSON.parse(wire);changed.box=(changed.box[0]==='A'?'B':'A')+changed.box.slice(1);
 expect(()=>openRemote(JSON.stringify(changed),phone.publicKey,host.secretKey)).toThrow();
 expect(remoteKeyFingerprint(host.publicKey)).toBe(remoteKeyFingerprint(host.publicKey));
});
it('rejects stale, replayed and excessive request IDs rather than evicting live replay protection',()=>{
 const replay=new ReplayWindow(2),now=Date.now();
 replay.accept('a'.repeat(32),now);expect(()=>replay.accept('a'.repeat(32),now)).toThrow();
 expect(()=>replay.accept('b'.repeat(32),now-600000)).toThrow();
 replay.accept('b'.repeat(32),now);expect(()=>replay.accept('c'.repeat(32),now)).toThrow();
});
