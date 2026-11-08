import './controls.css';
import { Skeleton } from '../components/ui/skeleton';
export default function LoadingState({label,rows=3}:{label:string;rows?:number}) {
 return <div className="ui-loading" role="status" aria-label={label} aria-busy="true"><span className="sr-only">{label}</span>{Array.from({length:rows},(_,i)=><div className="ui-loading-row" key={i} aria-hidden="true"><Skeleton className="ui-loading-symbol"/><div className="ui-loading-lines"><Skeleton/><Skeleton/></div></div>)}</div>;
}
