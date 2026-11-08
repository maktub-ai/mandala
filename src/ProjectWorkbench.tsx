import {isSystemAgent} from '../shared/chat-context';
import {useState} from 'react';
import type {Config, Project} from '../shared/types';
import {projectWorkspaces} from '../shared/workspaces';
import {useLanguage} from './i18n';
import {WorkspacePage} from './ui/WorkspacePage';
import Button from './ui/Button';
import Select from './ui/Select';
import Icon from './ui/Icon';
import IdentityAvatar from './IdentityAvatar';
import ProjectNavigation from './ProjectNavigation';
import DocumentLinks from './DocumentLinks';
import {ProjectAssets} from './AssetLibrary';
import {SidebarToggle} from './AppSidebar';
import {ObjectAssociations, ObjectGroup, ObjectHeader, ObjectRow, ObjectText} from './ObjectExperience';
import ObjectSummary from './ObjectSummary';

export default function ProjectWorkbench({project,config,onChange,onStartChat,onNavigate,onMobileNav,onDelete,pending,disabled,saveStatus,preferredAgentId=''}: {
 project:Project;config:Config;onChange:(update:(config:Config)=>Config)=>void;onStartChat:(id:string)=>void;onNavigate:(path:string)=>void;onMobileNav:()=>void;onDelete:()=>void;pending:boolean;disabled:boolean;saveStatus:React.ReactNode;preferredAgentId?:string;
}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const active=location.pathname.endsWith('/library')?'assets':'overview';
 const collaborators=config.agents.filter(agent=>(isSystemAgent(config,agent)||!agent.systemRole&&project.agentIds.includes(agent.id))),workspaces=projectWorkspaces(project);
 const [choice,setChoice]=useState<string|null>(null),candidate=choice??preferredAgentId;
 const selectedAgent=collaborators.some(agent=>agent.id===candidate)?candidate:'';
 const patch=(value:Partial<Project>)=>onChange(current=>({...current,projects:current.projects.map(item=>item.id===project.id?{...item,...value}:item)}));
 const resources='/projects/'+encodeURIComponent(project.id)+'/settings?tab=resources';
 return <WorkspacePage className="project-workbench object-experience">
  <div className="object-page-status"><SidebarToggle onClick={onMobileNav}/>{saveStatus}</div>
  <div data-page-width="compact" data-page-canvas className="object-content">
   <ObjectHeader kind="project" object={project} config={config} disabled={disabled} pending={pending} onNavigate={onNavigate} onChange={patch} onDelete={onDelete}>
    <Select ariaLabel={say('选择对话智能体','Start with Agent')} value={selectedAgent} disabled={disabled||pending} onChange={setChoice} options={[{value:'',label:say('直接对话','Direct chat'),icon:<Icon name="message" size={16}/>},...collaborators.map(agent=>({value:agent.id,label:agent.name,group:isSystemAgent(config,agent)?say('系统智能体','System Agent'):say('智能体','Agents'),icon:<IdentityAvatar identity={agent} kind="agent" size={20}/>}))]}/>
    <Button className="primary" disabled={disabled||pending} onClick={()=>onStartChat(selectedAgent)}>{say('开始对话','Start chat')}</Button>
   </ObjectHeader>
   <ProjectNavigation project={project} active={active} disabled={disabled||pending} onNavigate={onNavigate}/>
   {active==='assets'?<><ProjectAssets projectId={project.id} disabled={disabled||pending} onOpen={onNavigate}/><ObjectGroup title={say('参考知识','Reference knowledge')}><div className="object-settings-editor"><DocumentLinks embedded key={project.id} ids={project.knowledgeIds??[]} projectId={project.id} onChange={knowledgeIds=>patch({knowledgeIds})}/></div></ObjectGroup></>:<>
    <ObjectSummary kind="project" id={project.id} disabled={disabled||pending} onNavigate={onNavigate}/>
    <ObjectText maxLength={20000} key={project.id} label={say('项目背景','Project background')} value={project.background??''} onChange={background=>patch({background})} disabled={disabled} pending={pending}/>
    <ObjectAssociations kind="project" id={project.id} config={config} disabled={disabled} pending={pending} onChange={onChange} onNavigate={onNavigate} onStartChat={onStartChat}/>
    <ObjectGroup title={say('工作资源','Work resources')} actions={<Button disabled={disabled||pending} onClick={()=>onNavigate(resources)}>{say('管理','Manage')}</Button>}>
     <ObjectRow stacked label={say('主工作目录','Primary working directory')}><code className="object-path" title={workspaces[0]?.cwd}>{workspaces[0]?.cwd||say('尚未关联目录','No directory linked')}</code></ObjectRow>
     <ObjectRow label={say('附加资源','Additional resources')} hint={say('执行目录与附加路径','Execution directories and additional paths')}><Button disabled={disabled||pending} onClick={()=>onNavigate(resources)}>{workspaces.reduce((count,item)=>count+item.resources.length,0)} {say('项资源','resources')}<Icon name="arrowRight" size={14}/></Button></ObjectRow>
    </ObjectGroup>
   </>}
  </div>
 </WorkspacePage>;
}
