import {useSyncExternalStore} from 'react';
import {preferenceSaveFailed,subscribePreferenceStatus,retryDevicePreferences} from './devicePreferences';
import {useLanguage} from './i18n';
import Notice from './ui/Notice';
import Button from './ui/Button';
import './device-preferences.css';
export default function DevicePreferenceStatus(){
 const failed=useSyncExternalStore(subscribePreferenceStatus,preferenceSaveFailed,()=>false),{text: localize}=useLanguage();
 if(!failed)return null;
 return <Notice className="device-preference-notice"><span>{localize('界面偏好暂未保存，当前选择仍保留。', 'Interface preferences could not be saved. Your current choices are kept.')}</span><Button type="button" onClick={retryDevicePreferences}>{localize('重试', 'Retry')}</Button></Notice>;
}
