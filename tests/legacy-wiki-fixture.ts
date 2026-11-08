import { randomUUID } from 'node:crypto';
import type { Store } from '../server/store';
import type { KnowledgeBase } from '../server/knowledge-base';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { workspacePrincipal } from '../server/workspace-identity';
import type { WikiPolicy } from '../shared/knowledge-base';
// Persist the pre-upgrade shape directly: new creation must never produce legacy Agent ownership.
export async function legacyWiki(home:string,store:Store,wiki:KnowledgeBase,input:Pick<WikiPolicy,'name'|'purpose'|'maintainerAgentId'|'automatic'|'reception'>&{projectId?:string|null}){
 const root=workspacePrincipal(store),base:WikiPolicy={...input,id:randomUUID(),projectId:input.projectId??null,revision:1,receptionEpoch:1,enabledAfter:Number(store.database.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()!.id)};
 createAssets(store,createAssetFiles(home)).createAsset(root,{kind:'wiki',title:base.name,owner:{userId:root.userId,agentId:base.maintainerAgentId!}},asset=>{base.id=asset.id;store.database.prepare('INSERT INTO wiki_bases VALUES(?,?)').run(base.id,JSON.stringify(base));const binding={ownerType:base.projectId?'project':'agent',ownerId:base.projectId??base.maintainerAgentId!,assetId:base.id,versionPolicy:'latest'};store.database.prepare('INSERT INTO asset_bindings VALUES(?,?,?,?)').run(binding.ownerType,binding.ownerId,base.id,JSON.stringify(binding));});return wiki.get(root,base.id);
}
