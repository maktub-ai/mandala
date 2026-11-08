import type {LatestProgress} from '../shared/conversation-progress';
import {useLanguage} from './i18n';
import Disclosure from './ui/Disclosure';
import Icon from './ui/Icon';
import './explicit-progress.css';

/** Public observations only. Lifecycle status remains the responsibility of the caller. */
export default function ExplicitProgressView({progress,latest=true,compact=false,hideOutputLabel=false,live=false}:{progress:LatestProgress;latest?:boolean;compact?:boolean;hideOutputLabel?:boolean;live?:boolean}){
 const {text: localize, language}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const labels={pending:say('待处理','Pending'),running:say('执行中','Running'),completed:say('完成','Completed'),blocked:say('受阻','Blocked')};
 const label=progress.source==='commentary'?say(progress.historical?'历史过程说明':'过程说明',progress.historical?'Past commentary':'Commentary'):progress.source==='output'?say(progress.historical?'历史输出':'最近输出',progress.historical?'Past output':'Recent output'):say(progress.historical?'历史进展':latest?'最新进展':'进展上报',progress.historical?'Historical progress':latest?'Latest progress':'Progress report');
 return <section className="explicit-progress" data-progress-event-id={progress.sourceEventId} data-progress-source={progress.source} data-compact={compact} aria-label={label}>
  <div className="explicit-progress-meta">{progress.source==='cli'?<Icon name="activity" size={13}/>:<span className="progress-dot" data-live={live||undefined} aria-hidden="true"/>}{progress.source!=='commentary'&&!(hideOutputLabel&&progress.source==='output')&&<span>{label}</span>}<time dateTime={progress.updatedAt} title={new Date(progress.updatedAt).toLocaleString()}>{new Date(progress.updatedAt).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})}</time></div>
  <p title={compact?progress.text:undefined}>{progress.text}</p>
  {!!progress.steps?.length&&<Disclosure title={say('上报步骤','Reported steps')+' · '+progress.steps.filter(step=>step.status==='completed').length+'/'+progress.steps.length}><ol className="explicit-progress-steps">{progress.steps.map((step,index)=><li key={index}><Icon name={step.status==='completed'?'check':step.status==='blocked'?'error':step.status==='running'?'play':'clock'} size={13}/><span>{step.text}</span><small>{progress.historical&&step.status==='running'?say('上报时执行中','Running when reported'):labels[step.status]}</small></li>)}</ol></Disclosure>}
 </section>;
}
