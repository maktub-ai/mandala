import type {RouteReview} from '../shared/blueprint-routing';
import type {Config} from '../shared/types';
import {api} from './api';
import {BlueprintDecision} from './BlueprintDecision';
import {useLanguage} from './i18n';
import OperationCard,{OperationLink} from './OperationCard';

export const maySuggestRoute=(config:Config,projectId:string)=>config.projects.some(p=>!p.archivedAt&&(!projectId||p.id===projectId)&&(p.blueprintEnabled??config.blueprintDefaultEnabled));
export function BlueprintRouteReview({reviewId,initial,onCreated,onDismiss,onOpen}:{reviewId:string;initial?:RouteReview;onCreated?:(id:string)=>Promise<void>;onDismiss?:()=>void;onOpen?:(path:string)=>void}){
 const {text:t}=useLanguage();
 return <OperationCard attention icon="project" title={t('蓝图分派建议','Blueprint routing suggestion')}><BlueprintDecision url={'/v2/tasks/route-reviews/'+encodeURIComponent(reviewId)} call={api<RouteReview>} initial={initial} onCreated={onCreated} onDismiss={onDismiss} created={onOpen?id=><OperationLink path={'/tasks/'+encodeURIComponent(id)} onOpen={onOpen}>{t('查看已创建的任务','View created task')}</OperationLink>:undefined}/></OperationCard>;
}
