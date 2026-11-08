import SegmentedControl from './ui/SegmentedControl';
import Input from './ui/Input';
import Button from './ui/Button';
import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Upload, ImagePlus, Sun, Moon, Monitor, SlidersHorizontal, X } from 'lucide-react';
import { useLanguage } from './i18n';
import Select from './ui/Select';
import { useTheme } from './ThemeProvider';
import { allPalettes, themeTokens, contrastRatio, exportThemePackage, maxImageBytes, maxPackageBytes, parseThemePackage, resolvePalette, type Appearance, type Background, type Palette, type ThemeMode, type ThemePreferences, type Variant } from './themes';

async function verifyImage(image: string) {
  if(!image)return;
  const bitmap=await createImageBitmap(await (await fetch(image)).blob());
  const valid=bitmap.width>0&&bitmap.height>0&&bitmap.width*bitmap.height<=40000000;
  bitmap.close(); if(!valid)throw Error('image dimensions');
}
/** Miniatures render the same resolved roles as the app shell: recessed sidebar, inset workspace, primary action. */
function miniatureStyle(p: Palette, appearance: Appearance): React.CSSProperties {
  const t = themeTokens(p, appearance);
  return {'--sample-bg':t['--bg'],'--sample-panel':t['--panel'],'--sample-surface':t['--surface'],'--sample-ink':t['--text'],'--sample-muted':t['--muted'],'--sample-line':t['--border-soft'],'--sample-selected':t['--accent-bg'],'--sample-accent':t['--button'],'--sample-font':t['--font-ui']} as React.CSSProperties;
}
export default function ThemeSettings() {
  const {text: localize}=useLanguage(), label=(zh:string,english:string)=>localize(zh, english);
  const {saved,systemDark,save}=useTheme();
  const [draft,setDraft]=useState<ThemePreferences>(saved);
  const [variant,setVariant]=useState<Variant>(resolvePalette(saved,systemDark).variant);
  const [customizing,setCustomizing]=useState(false);
  const [error,setError]=useState('');
  const [reading,setReading]=useState(false);
  const fileRef=useRef<HTMLInputElement>(null), imageRef=useRef<HTMLInputElement>(null), readGeneration=useRef(0);
  const selected=resolvePalette(draft,systemDark,variant);
  useEffect(()=>{readGeneration.current++;setReading(false);setDraft(saved);},[saved]);
  useEffect(()=>{setVariant(resolvePalette(draft,systemDark).variant);},[draft.mode,systemDark]);
  useEffect(()=>()=>{readGeneration.current++;},[]);
  const update=(patch:Partial<ThemePreferences>)=>{
    const next={...draft,...patch};setDraft(next);
    if(next.custom.some(p=>!p.name.trim())){setError(label('主题名称不能为空。','Theme name cannot be empty.'));return;}
    try{save(next);setError('');}
    catch{setError(label('自动保存失败，本机存储空间不足。请缩小背景图片后重试。','Could not save automatically. Local storage is full. Try a smaller background image.'));}
  };
  const appearance=(patch:Partial<Appearance>)=>update({appearance:{...draft.appearance,...patch}});
  const background=(patch:Partial<Background>)=>update({background:{...draft.background,...patch}});
  function editPalette(patch: Partial<Palette>) {
    const existing=draft.custom.some(p=>p.id===selected.id);
    if(!existing&&draft.custom.length>=20){setError(label('最多保存 20 个自定义主题，请先移除一个。','Remove a custom theme before adding more (limit 20).'));return;}
    const next={...selected,id:existing?selected.id:crypto.randomUUID(),name:existing?selected.name:selected.name+label(' · 自定义',' · Custom'),...patch};
    update({[variant]:next.id,custom:existing?draft.custom.map(p=>p.id===next.id?next:p):[...draft.custom,next]});
  }
  async function importTheme(file?:File) {
    if(!file)return;
    const generation=++readGeneration.current;setReading(true);setError('');
    try {
      if(file.size>maxPackageBytes)throw Error('size');
      const imported=parseThemePackage(await file.text()); await verifyImage(imported.background.image);
      if(generation!==readGeneration.current)return;
      if(draft.custom.length>=20)throw Error('count');
      const theme={...imported.theme,id:crypto.randomUUID()};
      update({mode:theme.variant,custom:[...draft.custom,theme],[theme.variant]:theme.id,appearance:imported.appearance,background:imported.background});
      setVariant(theme.variant);
    }catch {if(generation===readGeneration.current)setError(label('无法导入：请使用有效的 Mandala 主题文件（最大 4 MiB），最多保留 20 个自定义主题。','Import failed. Use a valid Mandala theme file (up to 4 MiB, 20 custom themes).'));}
    finally {if(generation===readGeneration.current)setReading(false);}
  }
  async function uploadImage(file?:File) {
    if(!file)return;
    const generation=++readGeneration.current;setReading(true);setError('');
    try {
      if(file.size>maxImageBytes||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('image type');
      const image=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onerror=reject;r.onload=()=>resolve(String(r.result));r.readAsDataURL(file);});
      await verifyImage(image);if(generation!==readGeneration.current)return;background({image});
    }catch {if(generation===readGeneration.current)setError(label('请选择不超过 2 MiB、4000 万像素的 PNG、JPEG 或 WebP 图片。','Choose a PNG, JPEG or WebP image up to 2 MiB and 40 megapixels.'));}
    finally {if(generation===readGeneration.current)setReading(false);}
  }
  function exportTheme() {
    const url=URL.createObjectURL(new Blob([exportThemePackage(draft,variant)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=selected.name.replace(/[^\p{L}\p{N} _-]/gu,'')+'.mandala-theme.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const range=(title:string,value:number,min:number,max:number,change:(v:number)=>void,suffix='')=><label className="theme-range"><span>{title}</span><Input type="range" aria-label={title} value={value} min={min} max={max} onChange={e=>change(Number(e.target.value))}/><output>{value}{suffix}</output></label>;
  return <section className="settings-card theme-settings" aria-label={label('主题与外观','Themes and appearance')}>
    <header className="theme-heading"><div><h2>{label('主题与外观','Themes and appearance')}</h2><p>{label('设置主题配色与背景。','Choose colors and an optional background for your theme.')}</p></div><div className="theme-file-actions">
      <Button type="button" disabled={reading} onClick={()=>fileRef.current?.click()}><Upload size={15}/>{label('导入','Import')}</Button>
      <Button type="button" onClick={exportTheme}><Download size={15}/>{label('导出','Export')}</Button>
      <Input ref={fileRef} type="file" hidden accept=".json" aria-label={label('导入主题文件','Import theme file')} onChange={e=>{void importTheme(e.target.files?.[0]);e.target.value='';}}/>
    </div></header>
    <fieldset className="theme-editor" disabled={reading}>
    <div className="theme-mode-row"><h3 className="theme-subheading">{label('显示模式','Display mode')}</h3><SegmentedControl role="group" label={label('显示模式','Display mode')} value={draft.mode} onChange={value=>{const mode=value as ThemeMode;update({mode});setVariant(mode==='system'?(systemDark?'dark':'light'):mode);}} options={([['system',Monitor,label('跟随系统','System')],['light',Sun,label('浅色','Light')],['dark',Moon,label('深色','Dark')]] as const).map(([value,ModeIcon,title])=>({value,label:<><ModeIcon size={16}/>{title}</>}))}/></div>
    <section className="theme-composition" aria-label={label('配色与背景','Colors and background')}>
    <h3 className="theme-subheading">{label('配色与背景','Colors and background')}</h3>
    <div className="theme-picker-heading"><div className="theme-variant-tabs" role="group" aria-label={label('配置配色','Configure palette')}>
      {(['light','dark'] as const).map(v=><Button type="button" key={v} aria-pressed={variant===v} onClick={()=>{setVariant(v);}}>{v==='light'?label('浅色配色','Light palettes'):label('深色配色','Dark palettes')}</Button>)}
    </div><span>{label('当前选择','Selected')}: {selected.name}</span></div>
    <div className="theme-palette-grid" role="group" aria-label={label('主题配色','Theme palettes')}>
      {allPalettes(draft).filter(p=>p.variant===variant).map(p=><Button type="button" className="theme-palette" key={p.id} aria-label={p.name} aria-pressed={draft[variant]===p.id} onClick={()=>{update({[variant]:p.id,...(resolvePalette(draft,systemDark).variant!==variant?{mode:variant}:{})});}}>
        <span className="theme-miniature" aria-hidden="true" style={miniatureStyle(p,draft.appearance)}>
          <span className="theme-mini-sidebar"><i/><i/><i/><i/></span><span className="theme-mini-main"><b>Aa</b><i/><i/><span className="theme-mini-code" style={{color:p.colors.keyword}}>const <span style={{color:p.colors.string}}>theme</span></span><span className="theme-mini-composer"><span className="theme-mini-input"/><span className="theme-mini-send"/></span></span>
        </span><span className="theme-palette-caption"><span>{p.name}</span>{draft[variant]===p.id&&<Check size={16}/>}</span>
      </Button>)}
    </div>
    <Button type="button" className="theme-customize-toggle" aria-expanded={customizing} onClick={()=>setCustomizing(!customizing)}><SlidersHorizontal size={16}/>{label('自定义外观','Customize appearance')}</Button>
    {customizing&&<div className="theme-customize">
      <div className="theme-custom-section"><h4>{label('配色','Colors')}</h4><div className="theme-colors">
        {(['accent','bg','surface','text'] as const).map((key,i)=><label key={key}><span>{[label('强调色','Accent'),label('背景','Background'),label('面板','Surface'),label('文字','Text')][i]}</span><Input type="color" aria-label={[label('强调色','Accent'),label('背景颜色','Background color'),label('面板颜色','Surface color'),label('文字颜色','Text color')][i]} value={selected.colors[key]} onChange={e=>editPalette({colors:{...selected.colors,[key]:e.target.value}})}/><code>{selected.colors[key]}</code></label>)}
      </div>
      {draft.custom.some(p=>p.id===selected.id)&&<div className="theme-name-row"><label>{label('主题名称','Theme name')}<Input maxLength={80} value={selected.name} onChange={e=>editPalette({name:e.target.value})}/></label><Button type="button" onClick={()=>update({custom:draft.custom.filter(p=>p.id!==selected.id),[variant]:variant==='light'?'mandala-light':'mandala-dark'})}>{label('移除主题','Remove theme')}</Button></div>}
      {(contrastRatio(selected.colors.text,selected.colors.bg)<4.5||contrastRatio(selected.colors.text,selected.colors.surface)<4.5)&&<p role="alert" className="theme-warning">{label('文字对比度偏低，请调整文字、背景或面板颜色。','Low text contrast. Adjust text, background or surface colors.')}</p>}
      {range(label('对比度','Contrast'),draft.appearance.contrast,0,100,v=>appearance({contrast:v}))}</div>
      <div className="theme-custom-section"><h4>{label('字体与布局','Typography and spacing')}</h4><div className="theme-fonts">
        <label>{label('界面字体','Interface font')}<Select value={draft.appearance.uiFont} onChange={value=>appearance({uiFont:value})} ariaLabel={label('界面字体','Interface font')} searchable={false} options={[{value:'geist',label:'Geist'},{value:'system',label:'Inter'},{value:'serif',label:label('衬线','Serif')},{value:'rounded',label:label('圆体','Rounded')}]}/></label>
        <label>{label('代码字体','Code font')}<Select value={draft.appearance.codeFont} onChange={value=>appearance({codeFont:value})} ariaLabel={label('代码字体','Code font')} searchable={false} options={[{value:'geist',label:'Geist Mono'},{value:'system',label:label('系统等宽','System mono')},{value:'menlo',label:'Menlo'},{value:'monaco',label:'Monaco'}]}/></label>
      </div>{range(label('界面字号','Interface size'),draft.appearance.fontSize,12,18,v=>appearance({fontSize:v}),'px')}{range(label('代码字号','Code size'),draft.appearance.codeSize,11,20,v=>appearance({codeSize:v}),'px')}{range(label('圆角','Corners'),draft.appearance.radius,0,16,v=>appearance({radius:v}),'px')}
      <label className="theme-select-row"><span>{label('布局密度','Density')}</span><Select value={draft.appearance.density} onChange={value=>appearance({density:value as Appearance['density']})} ariaLabel={label('布局密度','Density')} searchable={false} options={[{value:'comfortable',label:label('舒适','Comfortable')},{value:'compact',label:label('紧凑','Compact')}]}/></label></div>
    </div>}
    <div className="theme-background-section"><div className="theme-background-heading"><div><h4>{label('背景图片','Background image')}</h4><p>{label('可选，与配色一起导入和导出。','Optional. Imported and exported with the palette.')}</p></div><Button type="button" disabled={reading} onClick={()=>imageRef.current?.click()}><ImagePlus size={16}/>{label(draft.background.image?'更换图片':'选择图片',draft.background.image?'Replace image':'Choose image')}</Button><Input ref={imageRef} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={label('上传背景图片','Upload background image')} onChange={e=>{void uploadImage(e.target.files?.[0]);e.target.value='';}}/></div>
      {draft.background.image&&<div className="theme-background-editor"><div className="theme-image-preview"><img style={{objectFit:draft.background.size,objectPosition:draft.background.position,filter:`blur(${draft.background.blur}px)`,transform:`scale(${draft.background.zoom/100})`}} src={draft.background.image} alt={label('背景预览','Background preview')}/><span className="theme-image-overlay" style={{opacity:draft.background.overlay/100}}/><span className="theme-image-sample">Aa</span><Button type="button" className="icon-button" aria-label={label('移除背景','Remove background')} onClick={()=>background({image:''})}><X size={16}/></Button></div><div className="theme-background-controls">
        <label className="theme-select-row"><span>{label('显示区域','Image area')}</span><Select value={draft.background.scope} onChange={value=>background({scope:value as Background['scope']})} ariaLabel={label('显示区域','Image area')} searchable={false} options={[{value:'chat',label:label('仅对话区域','Conversations only')},{value:'app',label:label('整个应用','Entire app')}]}/></label>
        <div className="theme-fonts"><label>{label('位置','Position')}<Select value={draft.background.position} onChange={value=>background({position:value as Background['position']})} ariaLabel={label('位置','Position')} searchable={false} options={[{value:'center',label:label('居中','Center')},{value:'top',label:label('顶部','Top')},{value:'bottom',label:label('底部','Bottom')}]}/></label><label>{label('适应方式','Fit')}<Select value={draft.background.size} onChange={value=>background({size:value as Background['size']})} ariaLabel={label('适应方式','Fit')} searchable={false} options={[{value:'cover',label:label('填充','Cover')},{value:'contain',label:label('完整显示','Contain')}]}/></label></div>
        {range(label('缩放','Zoom'),draft.background.zoom,100,200,v=>background({zoom:v}),'%')}{range(label('模糊','Blur'),draft.background.blur,0,24,v=>background({blur:v}),'px')}{range(label('遮罩','Overlay'),draft.background.overlay,0,95,v=>background({overlay:v}),'%')}
      </div></div>}
    </div>
    </section>
    </fieldset>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {(reading||error)&&<footer className="theme-save-bar"><span role="status">{reading?label('正在读取文件…','Reading file…'):label('修改尚未保存','Changes not saved')}</span>{error&&<Button type="button" onClick={()=>update({})}>{label('重试自动保存','Retry automatic save')}</Button>}</footer>}
  </section>;
}
