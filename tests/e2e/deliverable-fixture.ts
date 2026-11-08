// Real publication and lineage in an isolated E2E home; no production endpoint.
import type {IncomingMessage,ServerResponse} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Store} from '../../server/store';
import {workspacePrincipal} from '../../server/workspace-identity';
import {createAssets} from '../../server/assets';
import {createAssetFiles} from '../../server/asset-files';
import {createRunArtifacts} from '../../server/run-artifacts';

export async function deliverableFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store){
 if(req.method!=='POST'||req.url!=='/__test__/published-deliverable')return false;
 let body='';for await(const part of req)body+=part;
 const {conversationId}=JSON.parse(body),chat=store.getConversation(conversationId)!;
 const runId=randomUUID(),principal={...workspacePrincipal(store),agentId:chat.agentId,runId};
 store.database.prepare('INSERT INTO file_execution_scopes VALUES(?,?,?,?,?)').run(runId,principal.userId,chat.agentId,null,conversationId);
 const outputRoot=join(home,'outputs',runId),name='reading_list_last_30d.xlsx';
 await mkdir(outputRoot,{recursive:true});await writeFile(join(outputRoot,name),'Synthetic workbook bytes');
 const files=createAssetFiles(home),assets=createAssets(store,files);
 const result=await createRunArtifacts({store,files,assets,principal,outputRoot,sourceVersions:[],assertActive(){}}).publish({title:'近30天阅读书目清单',files:[{path:name}]},runId);
 store.appendEvent(conversationId,'user',{text:'导出阅读书目，交付 Excel。',runId});
 const text='导出完成。\n\n**`'+name+'`**（366KB，已通过 assets publish 发布，assetId `'+result.asset.id.slice(0,8)+'`）';
 store.appendEvent(conversationId,'tool',{method:'item/completed',params:{item:{id:'delivery-final',type:'agentMessage',phase:'final_answer',text}},runId});
 store.appendEvent(conversationId,'status',{status:'idle',runId});
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...result,name}));return true;
}
