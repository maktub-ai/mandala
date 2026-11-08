import type {Approval,DisplayEvent} from '../shared/types';
import {approvalChoices,type ApprovalDecision} from '../shared/approvals';
import Button from './ui/Button';
import Icon from './ui/Icon';
import NativeQuestions from './NativeQuestions';
import {ApprovalContent} from './ExecutionTrace';
import {useLanguage} from './i18n';

export default function ApprovalRequest({approval,events,pending,onDecision,onAnswer}:{
 approval:Approval;events:DisplayEvent[];pending:boolean;
 onDecision:(id:string,decision:ApprovalDecision)=>void;
 onAnswer:(id:string,answers:Record<string,{answers:string[]}>)=>void;
}){
 const {text: localize, t}=useLanguage();
 if(approval.method==='item/tool/requestUserInput')return <div className="approval-card">
  <NativeQuestions approval={approval} pending={pending} onSubmit={answers=>onAnswer(approval.id,answers)}/>
 </div>;
 const choices=approvalChoices(approval);
 return <section className="approval-card" aria-label={t('需要你的审批')}>
  <div className="approval-heading"><Icon name="approval" size={16}/>{t('需要你的审批')}</div>
  <ApprovalContent approval={approval} events={events}/>
  {(approval.params as {wholeTurnApproval?:boolean}).wholeTurnApproval&&<p className="approval-rule-scope">{localize('授权本轮使用原生工具，包括执行命令和读写文件；本轮内的单个工具不会再次请求审批。', 'Allow all native tools for this turn, including commands and file changes. Individual tools will not prompt again.')}</p>}
  {choices.includes('approve-rule')&&<p className="approval-rule-scope">
   {t('保存原生命令规则，今后匹配此前缀的命令可免审批：')} <code>{JSON.stringify((approval.params as {proposedExecpolicyAmendment:string[]}).proposedExecpolicyAmendment)}</code>
  </p>}
  {choices.includes('approve-conversation')&&<p className="approval-rule-scope">{t('对话授权会批准此对话后续的工具请求，范围不限于当前命令；可在输入区撤销，不适用于其他对话。')}</p>}
  {approval.method==='acp/permission'&&choices.includes('approve-always')&&<p className="approval-rule-scope">{t('长期授权由执行端按原生范围保存；请在对应 CLI 中管理和撤销。')}</p>}
  <div className="approval-actions">{choices.map(decision=><Button key={decision} type="button"
   className={decision==='approve'?'primary':undefined} disabled={pending}
   title={decision==='approve-session'?t('由 CLI 记住本会话的审批范围，不保存长期规则。'):undefined}
   onClick={()=>onDecision(approval.id,decision)}>
   {t(decision==='reject'?'拒绝':decision==='reject-stop'?'拒绝并停止':decision==='approve-session'?'本会话内批准':
    decision==='approve-rule'?'始终允许此前缀':decision==='approve-conversation'?'授权本对话后续工具':decision==='approve-always'?(approval.method==='acp/permission'?'始终允许（原生范围）':'始终允许此工具'):(approval.params as {grantRoot?:string}).grantRoot?'批准目录权限申请':'允许本次')}
  </Button>)}</div>
 </section>;
}
