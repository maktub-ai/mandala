import type { RemoteKey } from '../shared/remote-crypto';
import { fromBase64 } from '../shared/remote-crypto';
import type { ComposerCacheValue } from './composer-drafts';

type Ciphertext = { iv: Uint8Array<ArrayBuffer>; bytes: ArrayBuffer };
export type EncryptedComposerRecord = { format: 'remote-composer-v1'; manifest: Ciphertext; files: Ciphertext[] };
const encoder = new TextEncoder();

export function remoteComposerCodec(identity:RemoteKey, scope:string, ownsEditor:()=>boolean) {
  const cryptoKey = crypto.subtle.importKey('raw', new Uint8Array(fromBase64(identity.secretKey)), 'HKDF', false, ['deriveKey'])
    .then(key => crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(scope),info:encoder.encode('mandala:remote-composer:v1')},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']));
  const operations = new Map<string,Promise<unknown>>();
  const ordered = <T,>(key:string,operation:()=>Promise<T>):Promise<T> => {
    const result=(operations.get(key)??Promise.resolve()).catch(()=>{}).then(operation);
    operations.set(key,result);
    return result.finally(()=>{if(operations.get(key)===result)operations.delete(key);});
  };
  const encryptedFiles = new WeakMap<File,{id:string;cipher:Promise<Ciphertext>}>();
  const encrypt = async (id:string, bytes:BufferSource):Promise<Ciphertext> => {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    return {iv,bytes:await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(id)},await cryptoKey,bytes)};
  };
  const decrypt = async (id:string, cipher:Ciphertext) => crypto.subtle.decrypt({name:'AES-GCM',iv:cipher.iv,additionalData:encoder.encode(id)},await cryptoKey,cipher.bytes);
  return {
    ownsEditor, ordered,
    async encode(key:string,{files=[],...value}:ComposerCacheValue):Promise<EncryptedComposerRecord> {
      const descriptors = files.map(file=>{
        let cached=encryptedFiles.get(file);
        if(!cached) {
          const id=crypto.randomUUID();
          cached={id,cipher:file.arrayBuffer().then(bytes=>encrypt(id,bytes))};
          encryptedFiles.set(file,cached);
        }
        return {...cached,name:file.name,type:file.type,lastModified:file.lastModified};
      });
      const manifest=await encrypt(key,encoder.encode(JSON.stringify({...value,files:descriptors.map(({cipher,...item})=>item)})));
      return {format:'remote-composer-v1',manifest,files:await Promise.all(descriptors.map(item=>item.cipher))};
    },
    async decode(key:string,value:EncryptedComposerRecord):Promise<ComposerCacheValue> {
      const {files,...data}=JSON.parse(new TextDecoder().decode(await decrypt(key,value.manifest))) as Omit<ComposerCacheValue,'files'>&{files:{id:string;name:string;type:string;lastModified:number}[]};
      // File bytes are independently authenticated. Preserve the verified text, receipt and metadata when a file is missing.
      const restored=await Promise.allSettled(files.map(async(item,index)=>{
        const cipher=value.files[index];
        const file=new File([await decrypt(item.id,cipher)],item.name,{type:item.type,lastModified:item.lastModified});
        encryptedFiles.set(file,{id:item.id,cipher:Promise.resolve(cipher)});
        return file;
      }));
      return {...data,files:restored.flatMap(result=>result.status==='fulfilled'?[result.value]:[])};
    },
  };
}
export type RemoteComposerCodec=ReturnType<typeof remoteComposerCodec>;
