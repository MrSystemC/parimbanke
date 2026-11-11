// Exercise invitation-based administration using the actual production service.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import assert from 'node:assert/strict';

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
// D1 serializes transactional batches; reproduce that for concurrent grant checks.
let pendingBatch=Promise.resolve();
const DB={prepare:sql=>new Statement(sql),batch(statements){
  const operation=pendingBatch.then(async()=>{
    database.exec('BEGIN');
    try {const results=[];for(const statement of statements)results.push(await statement.run());database.exec('COMMIT');return results;}
    catch(error){database.exec('ROLLBACK');throw error;}
  });
  pendingBatch=operation.catch(()=>{});return operation;
}};
let identity=null;
const runtime={DB,APP_OWNER_EMAIL:'owner@example.test',APP_ADMIN_EMAILS:'  INVITED@EXAMPLE.TEST,\n moderator@example.test\n owner@example.test, blocked@example.test, existing-admin@example.test,\n invited@example.test,  , '};
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load=source=>import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
const cities=JSON.parse(await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8'));
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+JSON.stringify(cities)+';'));
globalThis.__invitedAdminsTest={env:runtime,getIdentity:async()=>identity,isValidLocation:regions.isValidLocation};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
  .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__invitedAdminsTest.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__invitedAdminsTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__invitedAdminsTest.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false'));
const as=(id,email)=>{identity={userId:id,email,displayName:id,fullName:id};};
const action=body=>service.performAction(new Request('https://test.local/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://test.local'},body:JSON.stringify(body)}));
const grantAudits=id=>Number(database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.invited_admin' AND target_id=?").get(id).n);
const grantMarker=id=>database.prepare('SELECT value FROM app_meta WHERE key=?').get(`invited_admin_granted:${id}`)?.value||null;

await assert.rejects(()=>service.getState(),error=>error.status===401);
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===401);
as('ordinary','ordinary@example.test');
let state=await service.getState();
assert.equal(state.user.role,'user');assert.equal(state.user.isAdmin,false);
assert.deepEqual(state.adminUsers,[]);
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
await assert.rejects(()=>action({kind:'createEvent',isAdmin:true,role:'admin',email:'invited@example.test',userId:'invitee'}),error=>error.status===403);
assert.equal(grantAudits('ordinary'),0);
console.log('PASS anonymous and noninvited visitors remain outside administration; client identity/role fields cannot grant access');

as('owner','owner@example.test');
state=await service.getState();assert.equal(state.user.role,'owner');assert.equal(state.user.isOwner,true);
assert.equal((await service.getAdministrativeContext()).role,'owner');
assert.equal(database.prepare('SELECT role FROM users WHERE id=?').get('owner').role,'user','Invitation grant must not rewrite the protected owner record');
assert.equal(grantAudits('owner'),0);assert.equal(grantMarker('owner'),null);
console.log('PASS configured owner remains owner even when owner email appears in invitation allowlist');

as('invitee','InViTeD@ExAmPlE.TeSt');
const concurrent=await Promise.all([service.getState(),service.getState(),service.getState()]);
assert(concurrent.every(result=>result.user.role==='admin'&&result.user.isAdmin&&!result.user.isOwner),'Every concurrent first login must return the persisted invitation grant');
assert.equal(database.prepare('SELECT role,status FROM users WHERE id=?').get('invitee').role,'admin');
assert.equal(grantAudits('invitee'),1,'Concurrent first login must produce exactly one invitation grant audit');
assert.equal(grantMarker('invitee'),'1');
for(let attempt=0;attempt<3;attempt++)await service.getState();
assert.equal(grantAudits('invitee'),1,'Repeated polling must not create repeated grants/audit entries');
assert.equal((await service.getAdministrativeContext()).role,'admin');
const grant=database.prepare("SELECT actor_id,details FROM admin_audit WHERE action='user.invited_admin' AND target_id=?").get('invitee');
assert.equal(grant.actor_id,'invitee');assert.match(grant.details,/по приглашению владельца/);
// Administration really reaches the guarded financial action, not just a badge.
state=await action({kind:'adjustBalance',userId:'ordinary',amount:25,reason:'Проверка роли приглашённого',requestId:'invite-credit-01'});
assert.equal(state.adminUsers.find(user=>user.id==='ordinary').balance,25);
state=await action({kind:'updateSettings',settings:{...state.settings,announcement:'Настройка приглашённым администратором'}});
assert.equal(state.settings.announcement,'Настройка приглашённым администратором');assert.equal(state.user.role,'admin');assert.equal(state.user.isOwner,false,'Equal application rights must not change owner identity');
state=await action({kind:'updateUser',userId:'ordinary',role:'moderator',reason:'Приглашённый администратор назначает роль'});assert.equal(state.adminUsers.find(user=>user.id==='ordinary').role,'moderator');
await action({kind:'updateUser',userId:'ordinary',role:'user',reason:'Приглашённый администратор отзывает роль'});
console.log('PASS first-login invitation grant, normalized case/comma/newline entries, concurrent idempotency, audit and real administrator permissions');

const createExisting=database.prepare('INSERT INTO users (id,name,balance,is_demo,created_at,role,status) VALUES (?,?,0,0,?,?,?)');
createExisting.run('moderator','Существующий модератор',Date.now(),'moderator','active');
as('moderator','moderator@example.test');
state=await service.getState();assert.equal(state.user.role,'admin');assert.equal(state.user.isAdmin,true);
assert.equal(grantAudits('moderator'),1);
await service.getState();assert.equal(grantAudits('moderator'),1);assert.equal(grantMarker('moderator'),'1');
as('owner','owner@example.test');await action({kind:'updateUser',userId:'moderator',role:'user',reason:'Владелец отозвал права после приглашения'});
as('moderator','moderator@example.test');state=await service.getState();
assert.equal(state.user.role,'user');assert.equal(state.user.isAdmin,false);
assert.equal(grantAudits('moderator'),1,'A consumed invitation grant must not override later explicit role changes');
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
createExisting.run('existing-admin','Действующий администратор',Date.now(),'admin','active');
as('existing-admin','existing-admin@example.test');state=await service.getState();
assert.equal(state.user.role,'admin');assert.equal(grantMarker('existing-admin'),'1');
assert.equal(grantAudits('existing-admin'),0,'Already-administrators need a marker, not a false role-change audit');
createExisting.run('blocked','Заблокированный приглашённый',Date.now(),'moderator','blocked');
as('blocked','blocked@example.test');
state=await service.getState();assert.equal(state.user.status,'blocked');assert.equal(state.user.isAdmin,false);
assert.equal(database.prepare('SELECT role,status FROM users WHERE id=?').get('blocked').role,'moderator','An explicit block must win over invitation provisioning');
assert.equal(grantAudits('blocked'),0);assert.equal(grantMarker('blocked'),null);
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
await assert.rejects(()=>action({kind:'adjustBalance',userId:'ordinary',amount:10,reason:'Запрещённое действие',requestId:'blocked-invite-1'}),error=>error.status===403);
as('owner','owner@example.test');await action({kind:'updateUser',userId:'blocked',status:'active',reason:'Владелец разблокировал приглашённого'});
as('blocked','blocked@example.test');state=await service.getState();
assert.equal(state.user.role,'admin');assert.equal(state.user.isAdmin,true);assert.equal(grantMarker('blocked'),'1');assert.equal(grantAudits('blocked'),1);
console.log('PASS existing moderator promotion, one-time grants, manual demotion, already-admin markers and explicit block/unblock precedence');

// Empty configuration is fail-closed for a new visitor, including an email-looking display name.
runtime.APP_ADMIN_EMAILS=' ,\n ,  ';
as('not-invited','not-invited@example.test');identity.fullName='invited@example.test';
state=await service.getState();assert.equal(state.user.isAdmin,false);assert.equal(state.user.role,'user');
assert.equal(grantAudits('not-invited'),0);
await assert.rejects(()=>service.getAdministrativeContext(),error=>error.status===403);
console.log('PASS empty allowlist and spoofed display name do not confer administration');
console.log('Invited-administrator integration checks passed.');
database.close();
