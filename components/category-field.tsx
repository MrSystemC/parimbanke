"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, Plus, X } from 'lucide-react';
import { cleanCategoryName, categoryKey } from '@/lib/categories';
import './category-field.css';

type Act=(payload:Record<string,unknown>,success?:string)=>Promise<boolean>;
type Props={categories:string[];act:Act;defaultValue?:string;disabled?:boolean;className?:string};
const normalize=categoryKey;

export function CategoryField({categories,act,defaultValue='',disabled=false,className=''}:Props){
 const selectId=useId(),draftId=useId(),messageId=useId();
 const options=Array.from(new Set([...categories,...(defaultValue?[defaultValue]:[])]));
 const [selected,setSelected]=useState(defaultValue||categories[0]||''),[adding,setAdding]=useState(false),[draft,setDraft]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const host=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null),selectInput=useRef<HTMLSelectElement>(null),pendingName=useRef<string|null>(null),latestCategories=useRef(categories),editingRef=useRef(false),inFlight=useRef(false),mounted=useRef(true);
 latestCategories.current=categories;editingRef.current=adding||saving;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 function finish(name:string,created:boolean){setSelected(name);setAdding(false);setDraft('');setError('');setNotice(created?'Категория сохранена и выбрана.':'Выбрана существующая категория.');pendingName.current=null;selectInput.current?.focus()}
 useEffect(()=>{if(!selected&&categories.length)setSelected(categories[0]);const requested=pendingName.current;if(requested){const canonical=categories.find(name=>normalize(name)===normalize(requested));if(canonical)finish(canonical,true)}},[categories,selected]);
 useEffect(()=>{const form=host.current?.closest('form');const guard=(event:Event)=>{if(!editingRef.current)return;event.preventDefault();event.stopImmediatePropagation();setError(saving?'Дождитесь сохранения категории.':'Добавьте категорию или отмените её создание перед сохранением розыгрыша.');nameInput.current?.focus()};form?.addEventListener('submit',guard,true);return()=>form?.removeEventListener('submit',guard,true)},[saving]);
 useEffect(()=>{if(adding)nameInput.current?.focus()},[adding]);
 function cancel(){if(inFlight.current)return;setAdding(false);setDraft('');setError('');pendingName.current=null;selectInput.current?.focus()}
 async function saveCategory(){
  if(disabled||inFlight.current)return;const name=cleanCategoryName(draft);setNotice('');
  if(!name||name.length>50){setError('Введите название от 1 до 50 символов.');nameInput.current?.focus();return}
  const existing=latestCategories.current.find(item=>normalize(item)===normalize(name));if(existing){finish(existing,false);return}
  inFlight.current=true;setSaving(true);setError('');pendingName.current=name;
  try{const saved=await act({kind:'createCategory',name});if(!mounted.current)return;if(!saved){pendingName.current=null;setError('Не удалось сохранить категорию. Проверьте сообщение об ошибке и повторите попытку.');return}const canonical=latestCategories.current.find(item=>normalize(item)===normalize(name));if(canonical)finish(canonical,true)}catch{if(mounted.current){pendingName.current=null;setError('Не удалось сохранить категорию. Проверьте соединение и повторите попытку.')}}finally{inFlight.current=false;if(mounted.current)setSaving(false)}
 }
 return <div ref={host} className={`category-field ${className}`}>
  <div className="cf-heading"><label htmlFor={selectId}>Категория</label>{!adding&&<button type="button" className="cf-add" disabled={disabled||saving} onClick={()=>{setAdding(true);setError('');setNotice('')}}><Plus size={14}/>Добавить категорию</button>}</div>
  <select ref={selectInput} id={selectId} name="category" required value={selected} disabled={disabled||saving} onChange={event=>{setSelected(event.target.value);setNotice('')}}><option value="" disabled>Выберите категорию</option>{options.map(name=><option key={name} value={name}>{name}</option>)}</select>
  {adding&&<div className="cf-create"><label htmlFor={draftId}>Название новой категории</label><input ref={nameInput} id={draftId} value={draft} maxLength={50} disabled={disabled||saving} aria-describedby={error?messageId:undefined} placeholder="Например: Аксессуары" onChange={event=>{setDraft(event.target.value);setError('')}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void saveCategory()}else if(event.key==='Escape'&&!saving){event.preventDefault();event.stopPropagation();cancel()}}}/><div className="cf-create-actions"><small>{draft.length} / 50</small><button type="button" className="cf-cancel" disabled={disabled||saving} onClick={cancel}><X size={13}/>Отмена</button><button type="button" className="cf-save" disabled={disabled||saving||!draft.trim()} onClick={()=>void saveCategory()}>{saving?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>} {saving?'Сохраняем…':'Добавить'}</button></div><p className="cf-help">Категория сохранится в общем списке. Сам розыгрыш сохраняется отдельной кнопкой основной формы.</p></div>}
  {error&&<p className="cf-error" id={messageId} role="alert">{error}</p>}{notice&&<p className="cf-notice" role="status"><CheckCircle2 size={13}/>{notice}</p>}
 </div>
}
