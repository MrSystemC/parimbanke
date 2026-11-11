import { DatabaseSync } from 'node:sqlite';
import { readFile,readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';

const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');
for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())database.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
for(const id of ['staff','visitor'])database.prepare('INSERT INTO users(id,name,balance,is_demo,created_at,role,status) VALUES(?,?,0,0,1,?,?)').run(id,id,id==='staff'?'admin':'user','active');
let failInsert=false;
class Statement {
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  async first(){return database.prepare(this.sql).get(...this.values)||null;}
  async run(){if(failInsert&&this.sql.startsWith('INSERT INTO prize_images'))throw new Error('database-internals-must-not-leak');return {meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}
}
const db={prepare:sql=>new Statement(sql)};
class AppError extends Error {constructor(message,status=400){super(message);this.status=status;}}
let actor='staff',blocked=false;
const authenticated=async()=>{if(!actor)throw new AppError('Войдите в аккаунт.',401);return {db,id:actor,isAdmin:actor==='staff'&&!blocked};};
const administrative=async()=>{const ctx=await authenticated();if(!ctx.isAdmin)throw new AppError('Недостаточно прав.',403);return ctx;};
const objects=new Map(),calls={put:0,get:0,delete:0};let failPut=false;
const bucket={
  async put(key,bytes,options){calls.put++;if(failPut)throw new Error('storage-secret-must-not-leak');objects.set(key,{bytes:new Uint8Array(bytes),options});return {key};},
  async get(key){calls.get++;const object=objects.get(key);return object?{body:new Blob([object.bytes]).stream()}:null;},
  async delete(key){calls.delete++;objects.delete(key);},
};
const runtime={BUCKET:bucket};
globalThis.__prizeImageTest={env:runtime,AppError,getAdministrativeContext:administrative,getAuthenticatedContext:authenticated};
let source=await readFile(new URL('../lib/prize-images.ts',import.meta.url),'utf8');
source=source.replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__prizeImageTest.env;')
  .replace("import { AppError, getAdministrativeContext, getAuthenticatedContext } from './event-service';",'const {AppError,getAdministrativeContext,getAuthenticatedContext}=globalThis.__prizeImageTest;');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {uploadPrizeImage,readPrizeImage,MAX_PRIZE_IMAGE_BYTES}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPU3T6dgYGBiYGBgYGBAQARhAF/gwB8UAAAAABJRU5ErkJggg==','base64');
const webp=Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAABwAQCdASoCAAIAAUAmJaACdAIHgAD+yL8GW2xUf+xm//6d3//Tu/tEAAA=','base64');
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwC1RRRWx8If/9k=','base64');
const formRequest=(bytes=png,type='image/png',name='prize.png',modify)=>{const form=new FormData();form.set('file',new File([bytes],name,{type}));modify?.(form);return new Request('https://test.local/api/prize-images',{method:'POST',headers:{Origin:'https://test.local'},body:form});};
const count=()=>Number(database.prepare('SELECT COUNT(*) AS n FROM prize_images').get().n);
const rejectStatus=(fn,status)=>assert.rejects(fn,error=>error.status===status);

actor=null;await rejectStatus(()=>uploadPrizeImage(formRequest()),401);await rejectStatus(()=>readPrizeImage('bad-id'),401);
actor='visitor';await rejectStatus(()=>uploadPrizeImage(formRequest()),403);
actor='staff';blocked=true;await rejectStatus(()=>uploadPrizeImage(formRequest()),403);blocked=false;
const foreign=formRequest();foreign.headers.set('Origin','https://attacker.invalid');await rejectStatus(()=>uploadPrizeImage(foreign),403);
assert.equal(calls.put,0);assert.equal(count(),0);
runtime.BUCKET=undefined;await rejectStatus(()=>uploadPrizeImage(formRequest()),503);runtime.BUCKET=bucket;
console.log('PASS anonymous, ordinary/blocked visitor and foreign-origin upload rejection before storage writes');

for(const [bytes,type] of [[png,'image/png'],[jpeg,'image/jpeg'],[webp,'image/webp']]) {
  const result=await uploadPrizeImage(formRequest(bytes,type,'../../untrusted".svg'));
  assert.equal(result.contentType,type);assert.equal(result.size,bytes.length);
  assert.match(result.imageId,/^[0-9a-f-]{36}$/);assert.equal(result.imageUrl,`/api/prize-images/${result.imageId}`);
  const record=database.prepare('SELECT * FROM prize_images WHERE id=?').get(result.imageId);
  assert.equal(record.created_by,'staff');assert.equal(record.size,bytes.length);assert.equal(record.content_type,type);
  assert.match(record.storage_key,/^prize-images\/[0-9a-f-]{36}\.(png|jpg|webp)$/);assert(!record.storage_key.includes('untrusted'));
  assert.deepEqual([...objects.get(record.storage_key).bytes],[...bytes]);
  assert.equal(objects.get(record.storage_key).options.httpMetadata.contentType,type);
  actor='visitor';const response=await readPrizeImage(result.imageId);assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Type'),type);assert.equal(response.headers.get('Content-Length'),String(bytes.length));
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.match(response.headers.get('Cache-Control'),/^private/);
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.match(response.headers.get('Content-Disposition'),/^inline; filename="prize-[0-9a-f-]+\.(png|jpg|webp)"$/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[...bytes]);actor='staff';
}
await uploadPrizeImage(formRequest(png,'application/octet-stream'));
const beforeInvalid=count(),putBeforeInvalid=calls.put;
for(const [bytes,type] of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),'image/svg+xml'],[Buffer.from('GIF89a bad'),'image/png'],[png,'image/jpeg'],[png.subarray(0,25),'image/png'],[Buffer.concat([png,Buffer.from('<script>bad</script>')]),'image/png'],[jpeg.subarray(0,jpeg.length-2),'image/jpeg']]) {
  await rejectStatus(()=>uploadPrizeImage(formRequest(bytes,type)),400);
}
const hugeDimensions=Buffer.from(png);hugeDimensions.writeUInt32BE(40_000,16);await rejectStatus(()=>uploadPrizeImage(formRequest(hugeDimensions)),400);
const malformedWebp=Buffer.from(webp);malformedWebp.writeUInt32LE(500,4);await rejectStatus(()=>uploadPrizeImage(formRequest(malformedWebp,'image/webp')),400);
await rejectStatus(()=>uploadPrizeImage(formRequest(new Uint8Array(0))),400);
await rejectStatus(()=>uploadPrizeImage(formRequest(png,'image/png','prize.png',form=>form.append('file',new File([png],'second.png',{type:'image/png'})))),400);
await rejectStatus(()=>uploadPrizeImage(formRequest(png,'image/png','prize.png',form=>form.set('other','unexpected'))),400);
await rejectStatus(()=>uploadPrizeImage(new Request('https://test.local/api/prize-images',{method:'POST',body:'not multipart'})),415);
await rejectStatus(()=>uploadPrizeImage(new Request('https://test.local/api/prize-images',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=missing'},body:'malformed body'})),400);
assert.equal(count(),beforeInvalid);assert.equal(calls.put,putBeforeInvalid);
console.log('PASS all three binary image formats, opaque names, authenticated reads and malformed/MIME/SVG/container rejection');

await rejectStatus(()=>uploadPrizeImage(formRequest(new Uint8Array(MAX_PRIZE_IMAGE_BYTES+1))),413);
let cancelled=false;
const unbounded=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
await rejectStatus(()=>uploadPrizeImage(new Request('https://test.local/api/prize-images',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test','Content-Length':'1'},body:unbounded,duplex:'half'})),413);
assert.equal(cancelled,true,'Over-limit streamed body must be cancelled before multipart parsing');
assert.equal(calls.put,putBeforeInvalid);assert.equal(count(),beforeInvalid);
console.log('PASS exact file size cap and bounded multipart stream despite a false Content-Length header');

const objectCount=objects.size,deleteBefore=calls.delete;
failInsert=true;
await assert.rejects(()=>uploadPrizeImage(formRequest()),error=>error.status===503&&!error.message.includes('database-internals'));
failInsert=false;
assert.equal(count(),beforeInvalid);assert.equal(objects.size,objectCount);assert.equal(calls.delete,deleteBefore+1);
failPut=true;await assert.rejects(()=>uploadPrizeImage(formRequest()),error=>error.status===503&&!error.message.includes('storage-secret'));failPut=false;
assert.equal(count(),beforeInvalid);
await rejectStatus(()=>readPrizeImage('not-a-valid-id'),404);
await rejectStatus(()=>readPrizeImage(crypto.randomUUID()),404);
const missingObject=database.prepare('SELECT id,storage_key FROM prize_images LIMIT 1').get();objects.delete(missingObject.storage_key);await rejectStatus(()=>readPrizeImage(missingObject.id),404);
runtime.BUCKET=undefined;const validId=database.prepare('SELECT id FROM prize_images WHERE id<>? LIMIT 1').get(missingObject.id).id;await rejectStatus(()=>readPrizeImage(validId),503);runtime.BUCKET=bucket;
console.log('PASS failed-write compensation, safe storage errors, missing object/record responses and read configuration errors');
console.log('Prize image integration checks passed.');
database.close();
