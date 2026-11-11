// Regression coverage for direct administration entry and its real authorization boundary.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import assert from 'node:assert/strict';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load=source=>import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
let requestHeaders=new Headers();
globalThis.__adminEntryAuth={headers:async()=>requestHeaders,redirect:location=>{const error=new Error('redirect');error.location=location;throw error;}};
const auth=await load((await readFile(new URL('../app/chatgpt-auth.ts',import.meta.url),'utf8'))
  .replace('import { headers } from "next/headers";','const headers=globalThis.__adminEntryAuth.headers;')
  .replace('import { redirect } from "next/navigation";','const redirect=globalThis.__adminEntryAuth.redirect;'));
assert.equal(auth.chatGPTSignInPath('/admin'),'/signin-with-chatgpt?return_to=%2Fadmin');
assert.equal(auth.chatGPTSignOutPath('/admin'),'/signout-with-chatgpt?return_to=%2Fadmin');
for(const path of ['https://outside.invalid/admin','//outside.invalid/admin','/\\outside.invalid/admin','/signin-with-chatgpt','/signout-with-chatgpt','/callback']) {
  assert.equal(auth.chatGPTSignInPath(path),'/signin-with-chatgpt?return_to=%2F');
}
assert.equal(await auth.getChatGPTUser(),null);
await assert.rejects(()=>auth.requireChatGPTUser('/admin'),error=>error.location==='/signin-with-chatgpt?return_to=%2Fadmin');
requestHeaders=new Headers({'oai-authenticated-user-id':'member'});
assert.equal(await auth.getChatGPTUser(),null,'Incomplete identity must not authenticate');
requestHeaders=new Headers({'oai-authenticated-user-id':'member','oai-authenticated-user-email':'member@example.test','oai-authenticated-user-full-name':encodeURIComponent('Ирина Иванова'),'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'});
assert.equal((await auth.getChatGPTUser()).displayName,'Ирина Иванова');
assert.equal((await auth.requireChatGPTUser('/admin')).userId,'member');
console.log('PASS direct /admin sign-in return, account-switch return, safe redirects and verified identity parsing');

const database=new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for(const filename of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) database.exec(await readFile(new URL('../drizzle/'+filename,import.meta.url),'utf8'));
class Statement {
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){assert(values.length<=100);return new Statement(this.sql,values);}
  async first(){return database.prepare(this.sql).get(...this.values)||null;}
  async all(){return {results:database.prepare(this.sql).all(...this.values)};}
  async run(){return {meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}
}
const DB={prepare:sql=>new Statement(sql),async batch(statements){database.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());database.exec('COMMIT');return results;}catch(error){database.exec('ROLLBACK');throw error;}}};
let identity=null;
const runtime={DB,APP_OWNER_EMAIL:'OWNER@example.test'};
const cities=JSON.parse(await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8'));
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+JSON.stringify(cities)+';'));
globalThis.__adminEntryService={env:runtime,getIdentity:async()=>identity,isValidLocation:regions.isValidLocation};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
  .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__adminEntryService.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__adminEntryService.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__adminEntryService.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false'));
const actor=(userId,email)=>({userId,email,displayName:userId,fullName:userId});
const action=body=>service.performAction(new Request('https://test.local/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://test.local'},body:JSON.stringify(body)}));
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===401);
identity=actor('member','member@example.test');
let state=await service.getState();
assert.equal(state.user.isAdmin,false);
assert.deepEqual(state.adminUsers,[]);
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
await assert.rejects(()=>action({kind:'updateSettings',isAdmin:true,role:'owner',settings:state.settings}),error=>error.status===403);
assert.equal((await service.getState()).user.isAdmin,false,'Client fields must not elevate a direct admin-page visitor');
identity=actor('owner','owner@example.test');
let context=await service.getAdministrativeContext();
assert.equal(context.role,'owner');
assert.equal(context.isOwner,true);
state=await service.getState();
assert.equal(state.user.isAdmin,true);
assert.equal(state.user.role,'owner');
await action({kind:'updateUser',userId:'member',role:'admin',reason:'Назначение сотрудника'});
identity=actor('member','member@example.test');
context=await service.getAdministrativeContext();
assert.equal(context.role,'admin');
assert.equal(context.isOwner,false);
identity=actor('owner','owner@example.test');
await action({kind:'updateUser',userId:'member',status:'blocked',reason:'Доступ сотрудника отозван'});
identity=actor('member','member@example.test');
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
assert.equal((await service.getState()).user.isAdmin,false,'Blocked staff must lose direct administration access');
identity=actor('owner','different@example.test');
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403,'A stored owner ID alone must not authorize a different verified email');
identity=actor('owner','owner@example.test');
assert.equal((await service.getAdministrativeContext()).isOwner,true);
console.log('PASS production admin entry authorization: anonymous, member, explicit owner, delegated staff and revoked staff');
const Home=()=>null;
let stateCalls=0;
globalThis.__adminEntryRoute={Home,requireChatGPTUser:auth.requireChatGPTUser,getState:async()=>{stateCalls++;return service.getState();}};
let routeSource=(await readFile(new URL('../app/admin/page.tsx',import.meta.url),'utf8'))
  .replace("import Home from '../page';",'const Home=globalThis.__adminEntryRoute.Home;')
  .replace("import { requireChatGPTUser } from '../chatgpt-auth';",'const requireChatGPTUser=globalThis.__adminEntryRoute.requireChatGPTUser;')
  .replace("import { getState } from '@/lib/event-service';",'const getState=globalThis.__adminEntryRoute.getState;')
  .replace("import { ArrowRight, ShieldCheck } from 'lucide-react';",'const ArrowRight=()=>null,ShieldCheck=()=>null;')
  .replaceAll('import.meta.env.DEV','false');
const routeJS=ts.transpileModule(routeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  .replace(/import \{[^\n]+\} from "react\/jsx-runtime";/,'const _jsx=(type,props)=>({type,props}),_jsxs=_jsx;');
const route=await import('data:text/javascript;base64,'+Buffer.from(routeJS).toString('base64'));
assert.equal(route.dynamic,'force-dynamic');
identity=null;requestHeaders=new Headers();stateCalls=0;
await assert.rejects(()=>route.default(),error=>error.location==='/signin-with-chatgpt?return_to=%2Fadmin');
await assert.rejects(()=>route.default({searchParams:Promise.resolve({tab:'guide'})}),error=>error.location==='/signin-with-chatgpt?return_to=%2Fadmin%3Ftab%3Dguide');
for(const tab of ['https://outside.invalid','guide&return_to=https://outside.invalid','../settings',['guide']]) {
  await assert.rejects(()=>route.default({searchParams:Promise.resolve({tab})}),error=>error.location==='/signin-with-chatgpt?return_to=%2Fadmin','Unknown or malformed tabs must not enter the authentication return URL');
}
assert.equal(stateCalls,0,'Anonymous administration page must redirect before fetching application state');
function enterAs(userId,email){identity=actor(userId,email);requestHeaders=new Headers({'oai-authenticated-user-id':userId,'oai-authenticated-user-email':email});}
enterAs('visitor','visitor@example.test');
let page=await route.default();
assert.equal(page.type,'main','A nonstaff visitor must receive the denied view, not the hydrated administration app');
const nodes=[];function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}nodes.push(node);visit(node.props?.children);}
visit(page);
assert(!nodes.some(node=>node.type===Home),'Restricted application state must not serialize into a nonstaff Home component');
assert(nodes.some(node=>node.type==='a'&&node.props.href==='/signout-with-chatgpt?return_to=%2Fadmin'&&node.props.target==='_top'),'Denied view must provide top-level account-switch access returning to administration');
page=await route.default({searchParams:Promise.resolve({tab:'guide'})});
assert.equal(page.type,'main');nodes.length=0;visit(page);
assert(nodes.some(node=>node.type==='a'&&node.props.href==='/signout-with-chatgpt?return_to=%2Fadmin%3Ftab%3Dguide'&&node.props.target==='_top'),'Account switching must preserve the whitelisted guide tab');
page=await route.default({searchParams:Promise.resolve({tab:'guide&return_to=https://outside.invalid'})});
nodes.length=0;visit(page);
assert(nodes.some(node=>node.type==='a'&&node.props.href==='/signout-with-chatgpt?return_to=%2Fadmin'),'Invalid tabs must be dropped from account-switch return URLs');
enterAs('owner','owner@example.test');
page=await route.default();
assert.equal(page.type,Home);assert.equal(page.props.initialPage,'admin');assert.equal(page.props.initialData.user.role,'owner');
enterAs('member','member@example.test');
assert.equal((await route.default()).type,'main','Revoked staff must not render administration on a direct request');
enterAs('visitor','visitor@example.test');await service.getState();
enterAs('owner','owner@example.test');await action({kind:'updateUser',userId:'visitor',role:'moderator',reason:'Назначение модератора'});
enterAs('visitor','visitor@example.test');
page=await route.default();assert.equal(page.type,Home);assert.equal(page.props.initialData.user.role,'moderator');
console.log('PASS actual /admin server route: safe guide-tab returns, anonymous redirect before reads, denied views, owner/moderator hydration and revoked staff');
database.close();
