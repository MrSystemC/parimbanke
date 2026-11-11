"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Image as ImageIcon, LoaderCircle, LockKeyhole, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import './prize-fields.css';

export const PRIZE_TYPES = [
 {value:'Товар',label:'Товар'},
 {value:'Сертификат',label:'Сертификат'},
 {value:'Услуга',label:'Услуга'},
 {value:'Набор',label:'Набор'},
 {value:'Другое',label:'Другое'},
] as const;
export function prizeTypeLabel(value:string){return PRIZE_TYPES.find(item=>item.value===value)?.label||value||'Приз'}
type UploadState = 'idle'|'uploading'|'error';
type UploadedImage = {imageId:string;imageUrl:string};
type Props = {
 defaultPrizeType?:string;
 defaultPrizeName?:string;
 defaultImageId?:string|null;
 defaultImageUrl?:string|null;
 disabled?:boolean;
 identityLocked?:boolean;
 onReadyChange?:(ready:boolean)=>void;
};
const MAX_SIZE=5*1024*1024;
const ALLOWED_TYPES=new Set(['image/jpeg','image/png','image/webp']);
function fileError(file:File){if(!ALLOWED_TYPES.has(file.type))return 'Выберите изображение в формате JPEG, PNG или WebP.';if(file.size>MAX_SIZE)return 'Файл слишком большой. Максимальный размер — 5 МБ.';if(file.size===0)return 'Файл пустой. Выберите другое изображение.';return ''}
function sizeLabel(size:number){return size>=1024*1024?`${(size/(1024*1024)).toLocaleString('ru-RU',{maximumFractionDigits:1})} МБ`:`${Math.max(1,Math.round(size/1024))} КБ`}

/** Uploads to the server before the parent event form can be submitted. */
export function PrizeFields({defaultPrizeType='Товар',defaultPrizeName='',defaultImageId=null,defaultImageUrl=null,disabled=false,identityLocked=false,onReadyChange}:Props){
 const inputId=useId(),helpId=useId(),errorId=useId();
 const containerRef=useRef<HTMLDivElement>(null),fileRef=useRef<HTMLInputElement>(null),chooseRef=useRef<HTMLButtonElement>(null);
 const [image,setImage]=useState<UploadedImage>({imageId:defaultImageId||'',imageUrl:defaultImageUrl||''});
 const [selectedFile,setSelectedFile]=useState<File|null>(null),[localPreview,setLocalPreview]=useState(''),[state,setState]=useState<UploadState>('idle'),[error,setError]=useState('');
 const requestRef=useRef<AbortController|null>(null),generation=useRef(0),previewRef=useRef(''),stateRef=useRef<UploadState>('idle'),readyCallback=useRef(onReadyChange);
 readyCallback.current=onReadyChange;stateRef.current=state;
 useEffect(()=>{readyCallback.current?.(state==='idle')},[state]);
 useEffect(()=>{const form=containerRef.current?.closest('form');const block=(event:Event)=>{if(stateRef.current==='idle')return;event.preventDefault();event.stopImmediatePropagation();setError(stateRef.current==='uploading'?'Дождитесь завершения загрузки изображения.':'Повторите загрузку или отмените выбранное изображение перед сохранением.');chooseRef.current?.focus()};form?.addEventListener('submit',block,true);return()=>form?.removeEventListener('submit',block,true)},[]);
 useEffect(()=>()=>{generation.current++;requestRef.current?.abort();if(previewRef.current)URL.revokeObjectURL(previewRef.current)},[]);
 useEffect(()=>{if(!identityLocked)return;cancelSelected();setImage({imageId:defaultImageId||'',imageUrl:defaultImageUrl||''})},[identityLocked,defaultImageId,defaultImageUrl]);

 function setUploadState(next:UploadState){stateRef.current=next;setState(next)}
 function clearPreview(){if(previewRef.current)URL.revokeObjectURL(previewRef.current);previewRef.current='';setLocalPreview('')}
 function cancelSelected(){generation.current++;requestRef.current?.abort();requestRef.current=null;setSelectedFile(null);clearPreview();setUploadState('idle');setError('');if(fileRef.current)fileRef.current.value=''}
 function removeImage(){cancelSelected();setImage({imageId:'',imageUrl:''})}
 async function upload(file:File){
  if(identityLocked||disabled)return;
  const current=++generation.current;requestRef.current?.abort();const validation=fileError(file);setSelectedFile(file);setError(validation);clearPreview();
  if(!validation){const url=URL.createObjectURL(file);previewRef.current=url;setLocalPreview(url)}
  if(validation){setUploadState('error');return}
  setUploadState('uploading');const controller=new AbortController();requestRef.current=controller;const timeout=setTimeout(()=>controller.abort(),60000);
  try{const body=new FormData();body.append('file',file);const response=await fetch('/api/prize-images',{method:'POST',body,signal:controller.signal});let result:Partial<UploadedImage>&{error?:string};try{result=await response.json() as Partial<UploadedImage>&{error?:string}}catch{throw new Error('Не удалось получить подтверждение загрузки. Повторите попытку.')}if(!result||typeof result!=='object')throw new Error('Не удалось получить подтверждение загрузки. Повторите попытку.');if(!response.ok)throw new Error(result.error||'Не удалось загрузить изображение. Попробуйте ещё раз.');if(typeof result.imageId!=='string'||!result.imageId||typeof result.imageUrl!=='string'||!result.imageUrl.startsWith('/api/prize-images/'))throw new Error('Сервер не подтвердил загрузку изображения. Повторите попытку.');if(current!==generation.current)return;setImage({imageId:result.imageId,imageUrl:result.imageUrl});setSelectedFile(null);clearPreview();setUploadState('idle');setError('');if(fileRef.current)fileRef.current.value=''}
  catch(cause){if(current!==generation.current)return;setUploadState('error');setError(cause instanceof DOMException&&cause.name==='AbortError'?'Загрузка заняла слишком много времени. Проверьте соединение и повторите попытку.':cause instanceof TypeError?'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.':cause instanceof Error?cause.message:'Не удалось загрузить изображение. Повторите попытку.')}
  finally{clearTimeout(timeout);if(current===generation.current)requestRef.current=null}
 }
 const preview=localPreview||image.imageUrl;
 return <div className="prize-fields" ref={containerRef}>
  <div className="pf-heading"><span><ImagePlus size={17}/>Информация о призе</span><small>Показывается в карточке розыгрыша</small></div>
  <div className="pf-field-grid"><label>Тип приза<input key={identityLocked?`locked-type-${defaultPrizeType}`:'editable-type'} name="prizeType" list={`${inputId}-types`} required maxLength={80} defaultValue={defaultPrizeType} disabled={disabled||identityLocked} placeholder="Выберите или введите свой тип"/><datalist id={`${inputId}-types`}>{PRIZE_TYPES.map(item=><option key={item.value} value={item.value}/>)}</datalist></label><label>Название приза<input key={identityLocked?`locked-name-${defaultPrizeName}`:'editable-name'} name="prizeName" required maxLength={120} defaultValue={defaultPrizeName} disabled={disabled||identityLocked} placeholder="Например: беспроводные наушники"/></label></div>
  {identityLocked&&<><input type="hidden" name="prizeType" value={defaultPrizeType}/><input type="hidden" name="prizeName" value={defaultPrizeName}/></>}
  <input type="hidden" name="imageId" value={identityLocked?(defaultImageId||''):image.imageId}/><input type="hidden" name="imageUploadState" value={state}/>
  <div className={`pf-upload ${state==='error'?'has-error':''}`}>
   <div className="pf-preview">{preview?<img src={preview} alt="Предпросмотр изображения приза"/>:<div className="pf-image-empty"><ImageIcon size={32}/><span>Фото приза</span></div>}{state==='uploading'&&<span className="pf-upload-overlay"><LoaderCircle size={25} className="spin"/><span>Загружаем…</span></span>}</div>
   <div className="pf-upload-info"><b>{selectedFile?selectedFile.name:image.imageId?'Изображение загружено':image.imageUrl?'Текущее изображение':identityLocked?'Изображение не задано':'Добавьте изображение с устройства'}</b><p id={helpId}>{identityLocked?'Фото приза зафиксировано':selectedFile?sizeLabel(selectedFile.size):'JPEG, PNG или WebP · до 5 МБ'}</p>
    <input id={inputId} ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="pf-file-input" disabled={disabled||identityLocked} tabIndex={-1} aria-label="Выбрать изображение приза" aria-describedby={`${helpId}${error?' '+errorId:''}`} onChange={event=>{const file=event.currentTarget.files?.[0];if(file)void upload(file)}}/>
    {!identityLocked&&<div className="pf-upload-actions"><button ref={chooseRef} type="button" className="pf-choose" disabled={disabled||identityLocked} onClick={()=>fileRef.current?.click()}><Upload size={15}/>{preview||selectedFile?'Выбрать другое':'Выбрать файл'}</button>{state==='error'&&selectedFile&&!fileError(selectedFile)&&<button type="button" className="pf-action" disabled={disabled||identityLocked} onClick={()=>void upload(selectedFile)}><RefreshCw size={14}/>Повторить</button>}{selectedFile?<button type="button" className="pf-action" disabled={disabled||identityLocked} onClick={cancelSelected}><X size={14}/>{image.imageUrl?'Отменить замену':'Отменить выбор'}</button>:image.imageUrl&&<button type="button" className="pf-action pf-remove" disabled={disabled||identityLocked} onClick={removeImage}><Trash2 size={14}/>Удалить</button>}</div>}
    {identityLocked&&<span className="pf-ready"><LockKeyhole size={13}/>Изменение приза недоступно</span>}{!identityLocked&&state==='idle'&&image.imageId&&<span className="pf-ready"><CheckCircle2 size={13}/>Готово к сохранению</span>}{state==='uploading'&&<span className="pf-status" role="status">Загружаем файл. Сохранение станет доступно после завершения.</span>}
   </div>
  </div>
  {error&&<p className="pf-error" id={errorId} role="alert">{error}</p>}
  <p className="pf-note">{identityLocked?"Тип, название и изображение приза зафиксированы. Это сохраняет объявленные участникам условия.":"Изменения изображения применятся после сохранения розыгрыша. Без изображения в карточке будет показан значок приза."}</p>
 </div>
}
