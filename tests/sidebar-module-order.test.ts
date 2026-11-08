import { afterEach, expect, test, vi } from 'vitest';
import { sidebarItems, readModulePins, readModuleOrder, moduleOrderKey, orderedSidebarItems, moveSidebarItem } from '../src/sidebar-modules';
afterEach(()=>vi.unstubAllGlobals());
test('saved navigation order removes obsolete and duplicate entries and appends new modules',()=>{
 vi.stubGlobal('localStorage',{getItem:(key:string)=>key===moduleOrderKey?'["settings","memory","memory","removed",4]':'{"assets":false,"memory":true}'});
 const order=readModuleOrder();
 expect(order.slice(0,2)).toEqual(['settings','memory']);
 expect(new Set(order).size).toBe(sidebarItems.length);
 expect(orderedSidebarItems(order).map(item=>item.id)).toEqual(order);
 expect(readModulePins()).toEqual({library:false,memory:true});
});
test('malformed or non-array order falls back without losing module access',()=>{
 for(const value of ['{broken','{}','null']){
  vi.stubGlobal('localStorage',{getItem:()=>value});
  expect(readModuleOrder()).toEqual(sidebarItems.map(item=>item.id));
 }
});
test('moving an entry changes only adjacent navigation order and bounds preserve the list',()=>{
 const order=sidebarItems.map(item=>item.id);
 expect(moveSidebarItem(order,order[1],-1)).toEqual([order[1],order[0],...order.slice(2)]);
 expect(moveSidebarItem(order,order[0],-1)).toEqual(order);
 expect(moveSidebarItem(order,order.at(-1)!,1)).toEqual(order);
 expect(moveSidebarItem(order,'unknown',1)).toEqual(order);
 expect(sidebarItems.map(item=>item.id)).toEqual(order);
});

test('legacy files placement and visibility migrate to Library while Projects stays independent',()=>{
 vi.stubGlobal('localStorage',{getItem:(key:string)=>key===moduleOrderKey?'["assets","agents","tasks"]':'{"assets":true}'});
 expect(readModuleOrder().slice(0,3)).toEqual(['library','agents','tasks']);
 expect(readModulePins()).toEqual({library:true});
 expect(sidebarItems.find(item=>item.id==='projects')?.defaultPinned).toBe(true);
});
