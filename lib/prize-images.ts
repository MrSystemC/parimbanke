import { env } from 'cloudflare:workers';
import { AppError, getAdministrativeContext, getAuthenticatedContext } from './event-service';

export const MAX_PRIZE_IMAGE_BYTES=5*1024*1024;
const MAX_MULTIPART_BYTES=MAX_PRIZE_IMAGE_BYTES+64*1024;
const MAX_IMAGE_PIXELS=40_000_000;
type ImageType='image/jpeg'|'image/png'|'image/webp';
type ImageRecord={id:string;storage_key:string;content_type:ImageType;size:number;created_by:string;created_at:number};
const extensions:Record<ImageType,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ascii=(bytes:Uint8Array,start:number,size:number)=>String.fromCharCode(...bytes.subarray(start,start+size));
function dimensions(width:number,height:number) {
  if(!width||!height||width>20_000||height>20_000||width*height>MAX_IMAGE_PIXELS) throw new AppError('Изображение должно быть не больше 40 мегапикселей и 20 000 пикселей по стороне.');
}
function invalidImage():never {throw new AppError('Файл повреждён или имеет неподдерживаемый формат. Выберите JPEG, PNG или WebP.');}

/** Verify binary signatures and bounded container headers; never trust filename/MIME alone. */
function detectImageType(bytes:Uint8Array):ImageType {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const pngSignature=[137,80,78,71,13,10,26,10];
  if(bytes.length>=45 && pngSignature.every((byte,index)=>bytes[index]===byte)) {
    if(view.getUint32(8)!==13||ascii(bytes,12,4)!=='IHDR')invalidImage();
    dimensions(view.getUint32(16),view.getUint32(20));
    let offset=8,hasData=false;
    while(offset+12<=bytes.length) {
      const length=view.getUint32(offset),kind=ascii(bytes,offset+4,4),end=offset+12+length;
      if(end>bytes.length)invalidImage();
      if(kind==='IDAT'&&length>0)hasData=true;
      if(kind==='IEND'){if(length!==0||end!==bytes.length||!hasData)invalidImage();return 'image/png';}
      offset=end;
    }
    invalidImage();
  }
  if(bytes.length>=12 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) {
    // JPEG segments before SOS have a two-byte length; SOF gives the decoded dimensions.
    if(bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9)invalidImage();
    let offset=2,hasFrame=false;
    while(offset+1<bytes.length) {
      if(bytes[offset++]!==0xff)invalidImage();
      while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];
      if(marker===0xd9||marker===0xd8||marker===0)invalidImage();
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>bytes.length)invalidImage();
      const length=view.getUint16(offset);
      if(length<2||offset+length>bytes.length)invalidImage();
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if(length<8)invalidImage();
        dimensions(view.getUint16(offset+5),view.getUint16(offset+3));hasFrame=true;
      }
      if(marker===0xda) {
        if(!hasFrame||length<6||offset+length>=bytes.length-2)invalidImage();
        return 'image/jpeg';
      }
      offset+=length;
    }
    invalidImage();
  }
  if(bytes.length>=20 && ascii(bytes,0,4)==='RIFF' && ascii(bytes,8,4)==='WEBP') {
    if(view.getUint32(4,true)+8!==bytes.length)invalidImage();
    let offset=12,hasImage=false,hasDimensions=false,first=true;
    while(offset+8<=bytes.length) {
      const kind=ascii(bytes,offset,4),length=view.getUint32(offset+4,true),start=offset+8,end=start+length;
      if(end>bytes.length)invalidImage();
      if(first&&!['VP8 ','VP8L','VP8X'].includes(kind))invalidImage();
      first=false;
      if(kind==='VP8X') {
        if(length!==10)invalidImage();
        dimensions(1+bytes[start+4]+(bytes[start+5]<<8)+(bytes[start+6]<<16),1+bytes[start+7]+(bytes[start+8]<<8)+(bytes[start+9]<<16));hasDimensions=true;
      } else if(kind==='VP8 ') {
        if(length<10||bytes[start+3]!==0x9d||bytes[start+4]!==0x01||bytes[start+5]!==0x2a)invalidImage();
        dimensions(view.getUint16(start+6,true)&0x3fff,view.getUint16(start+8,true)&0x3fff);hasImage=true;hasDimensions=true;
      } else if(kind==='VP8L') {
        if(length<5||bytes[start]!==0x2f)invalidImage();
        const bits=view.getUint32(start+1,true);dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);hasImage=true;hasDimensions=true;
      } else if(kind==='ANMF') {
        if(length<24||!hasDimensions)invalidImage();hasImage=true;
      }
      offset=end+(length&1);
    }
    if(offset!==bytes.length||!hasImage||!hasDimensions)invalidImage();
    return 'image/webp';
  }
  invalidImage();
}

async function readMultipartBounded(request:Request):Promise<FormData> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;'))throw new AppError('Ожидается загрузка файла через форму.',415);
  const declared=request.headers.get('content-length');
  if(declared&&Number(declared)>MAX_MULTIPART_BYTES)throw new AppError('Размер изображения не должен превышать 5 МиБ.',413);
  const reader=request.body?.getReader();if(!reader)throw new AppError('Добавьте файл изображения.');
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_MULTIPART_BYTES){await reader.cancel();throw new AppError('Размер изображения не должен превышать 5 МиБ.',413);}chunks.push(chunk.value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('content-type')!},body:bytes}).formData();}
  catch{throw new AppError('Не удалось прочитать файл. Повторите загрузку.');}
}

export async function uploadPrizeImage(request:Request) {
  const ctx=await getAdministrativeContext();
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)throw new AppError('Загрузка с другого сайта запрещена.',403);
  const bucket=env.BUCKET;if(!bucket)throw new AppError('Хранилище изображений ещё не подключено.',503);
  const form=await readMultipartBounded(request);
  const files=form.getAll('file');
  if(files.length!==1||typeof files[0]==='string'||[...form.keys()].some(key=>key!=='file'))throw new AppError('Добавьте один файл изображения.');
  const file=files[0];
  if(file.size<1)throw new AppError('Выбран пустой файл.');
  if(file.size>MAX_PRIZE_IMAGE_BYTES)throw new AppError('Размер изображения не должен превышать 5 МиБ.',413);
  const bytes=new Uint8Array(await file.arrayBuffer()),contentType=detectImageType(bytes);
  const declaredType=file.type.toLowerCase().split(';')[0].trim();
  if(declaredType&&declaredType!=='application/octet-stream'&&declaredType!==contentType)throw new AppError('Тип файла не соответствует содержимому. Выберите JPEG, PNG или WebP.');
  const imageId=crypto.randomUUID(),storageKey=`prize-images/${imageId}.${extensions[contentType]}`;
  try {
    await bucket.put(storageKey,bytes,{httpMetadata:{contentType},customMetadata:{imageId}});
    try {
      await ctx.db.prepare('INSERT INTO prize_images (id,storage_key,content_type,size,created_by,created_at) VALUES (?,?,?,?,?,?)').bind(imageId,storageKey,contentType,bytes.byteLength,ctx.id,Date.now()).run();
    }catch(error){try{await bucket.delete(storageKey);}catch{/* A failed cleanup can be retried operationally; never expose object internals. */}throw error;}
  }catch{throw new AppError('Не удалось сохранить изображение. Попробуйте ещё раз.',503);}
  return {imageId,imageUrl:`/api/prize-images/${imageId}`,contentType,size:bytes.byteLength};
}

export async function readPrizeImage(imageId:string):Promise<Response> {
  const ctx=await getAuthenticatedContext();
  if(!uuidPattern.test(imageId))throw new AppError('Изображение не найдено.',404);
  const record=await ctx.db.prepare('SELECT id,storage_key,content_type,size,created_by,created_at FROM prize_images WHERE id=?').bind(imageId).first<ImageRecord>();
  if(!record||!extensions[record.content_type])throw new AppError('Изображение не найдено.',404);
  const bucket=env.BUCKET;if(!bucket)throw new AppError('Хранилище изображений ещё не подключено.',503);
  const object=await bucket.get(record.storage_key);if(!object)throw new AppError('Изображение не найдено.',404);
  return new Response(object.body,{headers:{
    'Content-Type':record.content_type,
    'Content-Length':String(record.size),
    'X-Content-Type-Options':'nosniff',
    'Content-Disposition':`inline; filename="prize-${record.id}.${extensions[record.content_type]}"`,
    'Cache-Control':'private, max-age=86400',
    'Cross-Origin-Resource-Policy':'same-origin',
  }});
}
