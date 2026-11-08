import {Component,type ReactNode} from 'react';
import Button from './ui/Button';
import {WorkspacePage,PageHeader} from './ui/WorkspacePage';
import {useLanguage} from './i18n';
function Recovery({retry,navigate}:{retry:()=>void;navigate:(path:string)=>void}){
 const {text: localize}=useLanguage();
 return <main className="workspace-main"><WorkspacePage width="compact"><PageHeader title={localize('当前页面无法显示', 'This page could not be displayed')} icon="error"/><div className="page-recovery" role="alert"><p>{localize('本地工作继续运行。可重试页面或打开其他工作区，不会重新发送请求。', 'Local work continues. Retry the page or open another workspace; no request will be resent.')}</p><div><Button onClick={retry}>{localize('重试页面', 'Retry page')}</Button><Button onClick={()=>navigate('/projects')}>{localize('打开项目', 'Open Projects')}</Button><Button onClick={()=>navigate('/schedules')}>{localize('打开计划', 'Open Schedules')}</Button></div></div></WorkspacePage></main>;
}
export default class PageErrorBoundary extends Component<{children:ReactNode;onRecover:(path?:string)=>void},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<Recovery retry={()=>{this.props.onRecover();this.setState({failed:false});}} navigate={path=>this.props.onRecover(path)}/>:this.props.children;}
}
