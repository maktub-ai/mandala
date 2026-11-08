import type {Config} from '../shared/types';
import AppSidebar,{type SidebarNavigation} from './AppSidebar';
import AutomationWorkspace from './AutomationWorkspace';
import {WorkspacePage,PageHeader} from './ui/WorkspacePage';
import {useLanguage} from './i18n';
export default function SchedulesPage({navigation,mobileNav,onMobileNav,config,onOpenConversation,onNavigationLockChange}:{navigation:SidebarNavigation;mobileNav:boolean;onMobileNav:(open:boolean)=>void;config:Config;onOpenConversation:(id:string)=>void;onNavigationLockChange:(locked:boolean)=>void}){
 const {text: localize}=useLanguage(),title=localize('计划', 'Schedules');
 return <div className="app-shell"><AppSidebar navigation={navigation} open={mobileNav} onClose={()=>onMobileNav(false)}/><main data-page-width="standard" className="workspace-main"><WorkspacePage width="standard" className="schedules-page"><AutomationWorkspace config={config} onOpenConversation={onOpenConversation} onEditingChange={onNavigationLockChange} header={actions=><PageHeader onMobileNav={()=>onMobileNav(true)} title={title} icon="schedule" actions={actions||undefined}/>}/></WorkspacePage></main></div>;
}
