/** Retain old bookmarks while keeping work and memory in their own modules. */
export function canonicalObjectPath(path:string) {
 const url=new URL(path,'http://mandala.local'),query=url.searchParams;
 const project=url.pathname.match(/^\/projects\/([^/]+)\/(tasks|agents|workbench)$/);
 if(project){
  const id=decodeURIComponent(project[1]);
  if(project[2]==='tasks')return '/tasks?'+new URLSearchParams({project:id,type:'tasks',scope:'all',state:'all'});
  return '/projects/'+encodeURIComponent(id)+'/overview'+(project[2]==='agents'?'#associations':'');
 }
 if(['/agents','/settings/agents','/settings/runtime'].includes(url.pathname)&&query.get('agent')&&['memory','work'].includes(query.get('tab')??'')){const id=query.get('agent')!;query.delete('agent');return canonicalObjectPath('/agents/'+encodeURIComponent(id)+'?'+query);}
 const agent=url.pathname.match(/^\/agents\/([^/]+)(\/memory)?$/);
 if(agent&&(agent[2]||['work','memory'].includes(query.get('tab')??''))){
  const memory=!!agent[2]||query.get('tab')==='memory';query.delete('tab');query.delete('from');query.set('agent',decodeURIComponent(agent[1]));
  if(memory){query.set('tab','memory');return '/mana?'+query;}
  query.set('type','tasks');query.set('scope','all');query.set('state','all');return '/tasks?'+query;
 }
 const settings=url.pathname.match(/^\/projects\/([^/]+)\/settings$/);
 const legacy=url.pathname==='/projects/manage'&&query.get('project');
 if((settings||legacy)&&query.get('tab')==='members')return '/projects/'+(settings?settings[1]:encodeURIComponent(query.get('project')!))+'/overview#associations';
 return path;
}
