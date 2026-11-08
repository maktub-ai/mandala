import { legacyWiki } from '../legacy-wiki-fixture';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../../server/store';
import type { KnowledgeBase } from '../../server/knowledge-base';
import { readConfig, writeConfig } from '../../server/config';
import { createAssets } from '../../server/assets';
import { createAssetFiles } from '../../server/asset-files';
import { workspacePrincipal } from '../../server/workspace-identity';
import type { SystemGenerator } from '../../server/system-tasks';
export const wikiFixtureGenerate:SystemGenerator=async(_config,prompt)=>{
 const input=JSON.parse(prompt.split('INPUT_JSON:\n')[1]);
 if(input.mode==='capture')return JSON.stringify({outcomes:input.events.filter((e:any)=>e.kind==='reply').map((e:any)=>({text:e.text,eventIds:[e.id,...input.events.filter((e:any)=>e.kind==='tool').map((e:any)=>e.id)]}))});
 return JSON.stringify({pages:input.sources.length?[{id:'retention',title:'保留策略',body:input.currentPages?.find((page:any)=>page.id==='retention')?.body??'记录已发布的保留策略；来源分歧保留供维护者判断。',links:[],claims:input.sources.map((source:any)=>({key:'retention-days',text:source.text,sourceId:source.id,quote:source.text}))}]:[]});
};
export async function wikiFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store,wiki:KnowledgeBase){
 if(req.method!=='POST'||!req.url?.startsWith('/__test__/wiki/'))return false;
 const root=workspacePrincipal(store);
 if(req.url==='/__test__/wiki/drain'){await wiki.reconcile();await wiki.drain();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));return true;}
 if(req.url!=='/__test__/wiki/seed')return false;
 const initial=await readConfig(home),agent={id:'wiki-maintainer',name:'知识维护员',instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]};
 await writeConfig(home,{...initial.config,agents:[...initial.config.agents.filter(a=>a.id!==agent.id),agent],projects:[...initial.config.projects.filter(p=>p.id!=='wiki-fixture-project'),{id:'wiki-fixture-project',name:'Wiki fixture project',cwd:home,agentIds:[agent.id],resources:[],skills:[],mcp:[]}]},initial.revision);
 const files=createAssetFiles(home),assets=createAssets(store,files),refs=[];
 for(const [index,text]of ['日志保留 30 天。','日志保留 90 天。'].entries()){
  const name='policy-'+index+'.md';await writeFile(join(home,name),text);const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:name,manifestPath:name}]);const item=assets.importAsset(root,{kind:'file',title:index?'审计政策':'运行政策',agentId:agent.id,submissionId:stage.submissionId},'wiki-fixture-'+randomUUID());refs.push({assetId:item.asset.id,versionId:item.version.id});
 }
 const base=await legacyWiki(home,store,wiki,{name:'运行知识库',purpose:'保存有依据的运行决策，保留尚未解决的分歧。',maintainerAgentId:agent.id,automatic:false,reception:{enabled:false,agentId:agent.id}});
 for(const ref of refs)await wiki.addSource(root,base.id,{...ref,replace:false});await wiki.refresh(root,base.id);await wiki.drain();
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({base:wiki.get(root,base.id),sources:refs}));return true;
}
