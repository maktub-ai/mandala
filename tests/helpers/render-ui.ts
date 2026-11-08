import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {vi} from 'vitest';
import {devicePreferences} from '../../src/devicePreferences';
import {LanguageProvider} from '../../src/i18n';

export function renderChineseMarkup(component:ReactNode) {
 const original=devicePreferences.getItem;
 const preference=vi.spyOn(devicePreferences,'getItem').mockImplementation(key=>key==='mana-language'?'zh-CN':original(key));
 try{return renderToStaticMarkup(createElement(LanguageProvider,null,component));}
 finally{preference.mockRestore();}
}
