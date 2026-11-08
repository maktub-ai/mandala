import Button from './Button';
import Input from './Input';
import Textarea from './Textarea';
import Field from './Field';
import Tabs, { TabPanel } from './Tabs';
import SegmentedControl from './SegmentedControl';
import Notice from './Notice';
import EmptyState from './EmptyState';
import { useTheme } from '../ThemeProvider';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { LanguageProvider } from '../i18n';
import { ThemeProvider } from '../ThemeProvider';
import Dialog from '../Dialog';
import Select from './Select';
import Icon from './Icon';
import LoadingState from './LoadingState';
import { PageHeader, WorkspacePage, ListDetail, DetailSection } from './WorkspacePage';
import StatusLabel from './StatusLabel';
import MetadataList from './MetadataList';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../components/ui/dropdown-menu';
import './tokens.css';
import './tailwind.css';
import './primitives.css';
import '../styles.css';
import './catalog.css';
import CatalogFoundations from './catalog-foundations';
const options=[{value:'one',label:'第一项'},{value:'two',label:'第二项'}];
function Catalog(){
 const {changeMode}=useTheme();
 const [tab,setTab]=useState('one'),[choice,setChoice]=useState('one'),[submits,setSubmits]=useState(0);
 const [outer,setOuter]=useState(false),[inner,setInner]=useState(false),[value,setValue]=useState('one'),[custom,setCustom]=useState('');
 const [lockedDialog,setLockedDialog]=useState(false),[locked,setLocked]=useState(true),[detail,setDetail]=useState(true),[rowState,setRowState]=useState('review');
 const [filter,setFilter]=useState('');
 return <main className="ui-catalog"><header className="catalog-header"><div><h1>Mandala 设计系统</h1><p>颜色、字号、状态与共享组件的实时参考，与 DESIGN.md 对应；切换明暗主题查看两套取值</p></div>
 <div className="catalog-actions"><Button onClick={()=>changeMode('light')}><Icon name="sun"/>浅色</Button><Button onClick={()=>changeMode('dark')}><Icon name="moon"/>深色</Button></div></header>
 <CatalogFoundations/>
 <div className="catalog-grid">
 <form onSubmit={event=>{event.preventDefault();setSubmits(value=>value+1);}}>
 <h2><Icon name="edit"/>输入与表单</h2>
 <Field label="名称" hint="可使用中文或英文。"><Input/></Field>
 <Field label="验证错误" error="请填写有效的名称。"><Input/></Field>
 <Field label="任务描述"><Textarea rows={2}/></Field>
 <Field label="选择字段" hint="已关联的提示"><Select id="catalog-selection" ariaLabel="选择字段" value={value} onChange={setValue} options={options}/></Field>
 <div className="catalog-actions"><Button variant="primary" type="submit">提交示例</Button><Button onClick={()=>setOuter(true)}>表单内操作</Button><Button busy>处理中</Button></div>
 <output aria-label="提交次数">{submits}</output>
 </form>
 <section className="catalog-controls"><h2><Icon name="settings"/>选择与导航</h2>
 <Tabs id="catalog" label="组件分类" value={tab} onChange={setTab} options={[{value:'one',label:'基础控件'},{value:'disabled',label:'不可选',disabled:true},{value:'two',label:'反馈与内容'}]}/>
 <TabPanel id="catalog" value={tab}>{tab==='one'?<p>输入与选择</p>:<><Notice>连接暂时不可用，请重试。</Notice><EmptyState>没有匹配项</EmptyState></>}</TabPanel>
 <SegmentedControl label="密度示例" value={choice} onChange={setChoice} options={[{value:'one',label:'舒适'},{value:'disabled',label:'不可选密度',disabled:true},{value:'two',label:'紧凑'}]}/>
 <div className="catalog-long"><Button>保留完整的中文操作说明与长标签</Button></div>
 <Select ariaLabel="无搜索选项" value={value} onChange={setValue} options={options} searchable={false}/>
 <Select ariaLabel="自定义模型" value={custom} onChange={setCustom} options={[{value:'model-123',label:'模型名称'}]} allowCustom/>
 <Select ariaLabel="长选项与禁用状态" value={value} onChange={setValue} searchable={false} options={[options[0],{value:'disabled',label:'不可选择的选项',disabled:true},options[1],{value:'long',label:'跨项目资料更新与交付物审阅 · A long bilingual option that remains readable'}]}/>
 <Button onClick={()=>{setLocked(true);setLockedDialog(true);}}>打开锁定对话框</Button>
 {lockedDialog&&<Dialog label="锁定示例" locked={locked} onClose={()=>setLockedDialog(false)} className="catalog-dialog"><h2>受保护的操作</h2><p>锁定时 Escape 和外部点击不会关闭。</p><Button onClick={()=>setLocked(false)}>解除锁定</Button><Button disabled={locked} onClick={()=>setLockedDialog(false)}>关闭锁定示例</Button></Dialog>}
 <Button type="button" onClick={()=>setOuter(true)}>打开对话框</Button>
 {outer&&<Dialog label="外层示例" onClose={()=>setOuter(false)} className="catalog-dialog"><Input aria-label="弹窗名称"/><Select ariaLabel="弹窗选项" value={value} onChange={setValue} options={options}/><Button type="button" onClick={()=>setInner(true)}>打开内层</Button>
 <DropdownMenu><DropdownMenuTrigger asChild><Button>弹窗菜单<Icon name="chevronDown"/></Button></DropdownMenuTrigger><DropdownMenuContent aria-label="弹窗操作"><DropdownMenuItem><Icon name="file"/>查看资料</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
 {inner&&createPortal(<Dialog label="内层示例" className="catalog-dialog" onClose={()=>setInner(false)}><Button type="button" onClick={()=>setInner(false)}>关闭内层</Button></Dialog>,document.body)}</Dialog>}
 </section></div>
 <WorkspacePage className="catalog-workspace">
   <PageHeader title="组件组合示例" icon="plan" context="本地交互样例" actions={<Tooltip><TooltipTrigger asChild><Button aria-label="切换详情" onClick={()=>setDetail(!detail)}><Icon name="panel"/></Button></TooltipTrigger><TooltipContent>显示或收起详情</TooltipContent></Tooltip>}>
     <Input aria-label="样例搜索" placeholder="筛选样例…" value={filter} onChange={event=>setFilter(event.target.value)}/>
     <DropdownMenu><DropdownMenuTrigger asChild><Button>显示状态<Icon name="chevronDown"/></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={()=>setRowState('review')}><Icon name="circleCheck"/>待审阅</DropdownMenuItem><DropdownMenuItem onSelect={()=>setRowState('loading')}><Icon name="refresh"/>加载中</DropdownMenuItem><DropdownMenuItem onSelect={()=>setRowState('empty')}><Icon name="inbox"/>空状态</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
   </PageHeader>
   <ListDetail list={rowState==='loading'?<LoadingState label="加载样例"/>:rowState==='empty'||!('审阅跨项目交付资料与引用'.includes(filter))?<EmptyState action={<Button onClick={()=>{setRowState('review');setFilter('');}}>恢复样例</Button>}>当前筛选没有匹配项。</EmptyState>:<Button className="catalog-task-row" onClick={()=>setDetail(true)}><Icon name="circleCheck"/><span><strong>审阅跨项目交付资料与引用</strong><small>已完成执行，等待验收 · Execution completed; review pending</small></span><StatusLabel icon="circleCheck">待审阅</StatusLabel></Button>} detail={detail&&<>
     <Button variant="ghost" onClick={()=>setDetail(false)}><Icon name="arrowLeft"/>返回列表</Button>
     <DetailSection title="交付审阅" icon="file"><p>此区域演示共享组件，不会创建任务或触发 Agent 执行。</p><MetadataList items={[{label:'Agent',icon:'agent',value:'Research assistant'},{label:'Project',icon:'project',value:'Interface verification'},{label:'执行',icon:'activity',value:<StatusLabel icon="circleCheck" tone="success">已成功</StatusLabel>},{label:'验收',icon:'approval',value:'等待用户审阅'}]}/></DetailSection>
     <DetailSection title="反馈与恢复" icon="info"><Notice tone="info">离线内容保存为草稿，重连后手动发送。</Notice></DetailSection>
   </>}/>
 </WorkspacePage>
 </main>;
}
createRoot(document.getElementById('root')!).render(<LanguageProvider><ThemeProvider><TooltipProvider><Catalog/></TooltipProvider></ThemeProvider></LanguageProvider>);
