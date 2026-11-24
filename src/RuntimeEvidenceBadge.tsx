import type {CliStatus} from '../shared/types';
import {useLanguage} from './i18n';
import StatusLabel from './ui/StatusLabel';

function evidence(status:CliStatus) {
 const detail=status.diagnostics;
 if(status.status==='unavailable')return 'failed';
 if(detail?.auth==='configuration-required')return 'setup';
 if(status.status==='login-required'||detail?.auth==='login-required')return 'sign-in';
 if(detail?.auth==='native-account-ready'&&detail.probe==='account')return 'account';
 if(detail?.probe==='version-only')return 'version';
 if(detail?.probe==='rpc'||detail?.probe==='acp'||detail?.probe==='gateway-session')return 'connection';
 return 'unknown';
}

/** Presents the evidence the check returned, not a prediction about the first task. */
export default function RuntimeEvidenceBadge({status}:{status:CliStatus}) {
 const {text:l}=useLanguage();
 switch(evidence(status)){
  case 'failed':return <StatusLabel icon="info" tone="warning">{l('检测失败','Check failed')}</StatusLabel>;
  case 'setup':return <StatusLabel icon="settings" tone="warning">{l('需要配置','Setup needed')}</StatusLabel>;
  case 'sign-in':return <StatusLabel icon="user" tone="warning">{l('需要登录','Sign-in needed')}</StatusLabel>;
  case 'account':return <StatusLabel icon="circleCheck" tone="success" title={l('未运行任务。','No task was run.')}>{l('账户检查通过','Account check passed')}</StatusLabel>;
  case 'connection':return <StatusLabel icon="circleCheck" tone="success" title={l('未验证登录或任务执行。','Sign-in and task execution were not verified.')}>{l('连接检查通过','Connection check passed')}</StatusLabel>;
  case 'version':return <StatusLabel icon="info" title={l('未验证连接、登录或任务执行。','Connection, sign-in and task execution were not verified.')}>{l('仅检查了版本','Version check only')}</StatusLabel>;
  default:return <StatusLabel icon="info">{l('检测详情不可用','Check details unavailable')}</StatusLabel>;
 }
}
