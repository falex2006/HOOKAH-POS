'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID,randomBytes,scryptSync}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {Pool}=require('pg');
const guards=require('./local-full-pg-regression.cjs');
const root=path.resolve(__dirname,'..');
const config=guards.validateConfig(JSON.parse(fs.readFileSync(path.join(root,'tmp/full-local-qa/runtime.json'),'utf8')));
const database='audit_qa_'+randomBytes(8).toString('hex');
const url=name=>`postgresql://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@127.0.0.1:31931/${name}`;
let admin,pool,child,created=false,checks=0,base;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert.ok(value,label);};
async function inspect(){
 const result=spawnSync('docker',['inspect',config.regressionContainer],{encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(result.status,0);guards.validateContainer(JSON.parse(result.stdout)[0],config);
 const safety=await import('./postgres-qa-safety.mjs');process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER=config.regressionContainer;safety.validateQaDatabaseUrl(url(config.database));
 const check=new Pool({connectionString:url(config.database),max:1,connectionTimeoutMillis:5000});
 try{safety.assertQaDatabaseIdentity((await check.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],config.database,31931);}finally{await check.end();}
}
async function api(route,token,method='GET',body,expected=200){
 const response=await fetch(base+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const payload=await response.json();eq(response.status,expected,`${method} ${route}: ${payload.error||'no error'}`);return payload;
}
async function main(){
 await inspect();admin=new Pool({connectionString:url(config.database),max:1});
 eq((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0,'fresh own database');await admin.query(`CREATE DATABASE "${database}"`);created=true;
 pool=new Pool({connectionString:url(database),max:4});await pool.query(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const file of fs.readdirSync(path.join(root,'migrations')).filter(x=>x.endsWith('.sql')).sort())await pool.query(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
 const org=randomUUID(),venue=randomUUID(),foreignOrg=randomUUID(),foreignVenue=randomUUID();
 for(const [o,v] of [[org,venue],[foreignOrg,foreignVenue]]){
  await pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',[o,'Preparation QA','qa-'+o]);
  await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)",[o]);
  await pool.query('INSERT INTO venues(id,organization_id,name) VALUES($1,$2,$3)',[v,o,'Preparation QA venue']);
 }
 const password=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex'),hash=`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`;
 const actors={};for(const role of ['owner','manager','bartender','hookah_master','foreign']){const id=randomUUID(),foreign=role==='foreign';actors[role]=id;await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,foreign?foreignVenue:venue,foreign?foreignOrg:org,'QA '+role,'qa_'+id,hash,foreign?'owner':role]);await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",[foreign?foreignOrg:org,id]);}
 const env={...process.env};for(const key of Object.keys(env))if(/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key))delete env[key];
 child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,env:{...env,HOST:'127.0.0.1',PORT:'0',NODE_ENV:'test',AUTH_REQUIRED:'true',DEMO_MODE:'false',DATABASE_URL:url(database),VENUE_ID:venue,API_RATE_LIMIT:'10000'},stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('QA startup timeout')),20000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(Error('QA server exited'));});child.stdout.on('data',chunk=>{output+=chunk;const port=output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];if(port){clearTimeout(timeout);resolve('http://127.0.0.1:'+port);}});child.stderr.on('data',()=>{});});
 const tokens={};for(const [role,id]of Object.entries(actors))tokens[role]=(await api('/api/login','','POST',{username:'qa_'+id,password})).token;
 const owner=tokens.owner,bar=tokens.bartender,hookah=tokens.hookah_master;
 const zone=await api('/api/floor/zones',owner,'POST',{expectedVenueId:venue,name:'QA preparation'},201);
 async function order(){const table=await api('/api/floor/tables',owner,'POST',{expectedVenueId:venue,zoneId:zone.id,name:'QA '+randomUUID().slice(0,8),capacity:4},201);return api('/api/orders',bar,'POST',{tableId:table.id},201);}
 await api('/api/shifts',owner,'POST',{openingCash:0},201);
 await api('/api/shifts',tokens.foreign,'POST',{openingCash:0},201);
 const goods={};for(const station of ['bar','hookah',null]){goods[station]=await api('/api/products',owner,'POST',{name:'QA preparation '+String(station),category:'Бар',price:100,inventoryMode:'non_stock',preparationStation:station},201);eq(goods[station].preparationStation,station,'station roundtrip');}
 const add=(o,p,quantity=1)=>api(`/api/orders/${o.id}/items`,bar,'POST',{productId:p.id,quantity},201);
 const dispatch=(o,station,items,token=bar,expected=200)=>api(`/api/orders/${o.id}/dispatch`,token,'POST',{station,itemIds:items.map(i=>i.id)},expected);
 const progress=(o,i,status,expectedStatus,token=bar,expected=200)=>api(`/api/orders/${o.id}/items/${i.id}/preparation`,token,'PATCH',{status,expectedStatus},expected);
 const read=async(o,token=owner)=>(await api('/api/orders?scope=all',token)).items.find(x=>x.id===o.id);
 const state=async(o)=>(await read(o)).status;
 const mixed=await order(),a=await add(mixed,goods.bar),b=await add(mixed,goods.bar),h=await add(mixed,goods.hookah);
 await api(`/api/orders/${mixed.id}/dispatch`,bar,'POST',{station:'bar',itemIds:[a.id],expectedVenueId:foreignVenue},409);
 const sent=await dispatch(mixed,'bar',[a,b]);eq(sent.items.find(x=>x.id===a.id).salesEmployeeName,'QA bartender','dispatch preserves seller display name');await dispatch(mixed,'hookah',[h],hookah);await dispatch(mixed,'bar',[a,b]);
 eq(await state(mixed),'in_progress','dispatch aggregate');
 const barQueue=await api('/api/preparation/queue',bar),hookahQueue=await api('/api/preparation/queue',hookah);
 eq(barQueue.stations,['bar'],'bar queue scope');eq(hookahQueue.stations,['hookah'],'hookah queue scope');ok(barQueue.items.length>=2,'bar queue rows');ok(hookahQueue.items.length>=1,'hookah queue rows');
 eq((await api('/api/preparation/queue',tokens.manager)).stations,['bar','hookah'],'supervisor sees both stations');
 await progress(mixed,h,'in_progress','queued',bar,403);await progress(mixed,a,'in_progress','queued',hookah,403);
 await dispatch(mixed,'hookah',[a],owner,409);
 await api(`/api/orders/${mixed.id}/dispatch`,tokens.foreign,'POST',{station:'bar',itemIds:[a.id]},404);
 await api(`/api/orders/${mixed.id}/status`,owner,'POST',{status:'ready'},409);
 const started=await progress(mixed,a,'in_progress','queued');eq(started.items.find(x=>x.id===a.id).salesEmployeeName,'QA bartender','progress preserves seller display name');await progress(mixed,a,'ready','in_progress');await progress(mixed,a,'ready','in_progress');
 eq(await state(mixed),'in_progress','one ready does not finish mixed order');
 await Promise.all([progress(mixed,b,'in_progress','queued'),progress(mixed,h,'in_progress','queued',hookah)]);
 await Promise.all([progress(mixed,b,'ready','in_progress'),progress(mixed,h,'ready','in_progress',hookah)]);
 eq(await state(mixed),'ready','concurrent stations complete aggregate');eq((await read(mixed,bar)).status,(await read(mixed,hookah)).status,'two staff reread same state');
 const fresh=await add(mixed,goods.bar);eq(await state(mixed),'in_progress','new row invalidates ready');
 await dispatch(mixed,'bar',[fresh]);await progress(mixed,fresh,'in_progress','queued');await progress(mixed,fresh,'ready','in_progress');eq(await state(mixed),'ready','new row completes');
 const unknown=await order(),u=await add(unknown,goods.null);await dispatch(unknown,'hookah',[u],hookah);await dispatch(unknown,'bar',[u],owner,409);
 await api(`/api/orders/${unknown.id}/items/${u.id}`,bar,'PATCH',{quantity:2},409);
 await api(`/api/orders/${unknown.id}/items/${u.id}`,bar,'DELETE',undefined,409);
 const splittable=await order(),splitBar=await add(splittable,goods.bar),splitHookah=await add(splittable,goods.hookah);
 await dispatch(splittable,'bar',[splitBar]);await dispatch(splittable,'hookah',[splitHookah],hookah);
 const split=await api(`/api/orders/${splittable.id}/split`,owner,'POST',{itemIds:[splitBar.id]},201);
 eq(await state(splittable),'in_progress','split source aggregate');eq(await state(split),'in_progress','split target aggregate');
 await progress(splittable,splitBar,'in_progress','queued',bar,404);
 await progress(split,splitBar,'in_progress','queued');
 ok((await api('/api/preparation/queue',bar)).items.some(x=>x.id===splitBar.id&&x.orderId===split.id),'execution follows unchanged item ID to split target');
 // Paid lines retain immutable commercial facts while preparation remains operational.
 const ingredient=await api('/api/inventory/items',owner,'POST',{name:'QA preparation stock',unit:'мл',itemType:'ingredient',cost:1},201);
 await api('/api/inventory/movements',owner,'POST',{itemId:ingredient.id,delta:100,unit:'мл',reason:'Synthetic preparation fixture'},201);
 const tracked=await api('/api/products',owner,'POST',{name:'QA preparation tracked',category:'Бар',price:100,inventoryMode:'tracked',preparationStation:'bar'},201);
 await api('/api/recipes',owner,'POST',{productId:tracked.id,name:tracked.name,ingredients:[{ingredientId:ingredient.id,name:ingredient.name,quantity:'10 мл'}],yieldQuantity:1,yieldUnit:'порция',portionCount:1},201);
 const stock=async()=>(await pool.query('SELECT id,direction,quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 ORDER BY id',[venue,ingredient.id])).rows;
 const stockBefore=await stock();
 const paid=await order(),p=await add(paid,tracked);await dispatch(paid,'bar',[p]);eq(await stock(),stockBefore,'dispatch does not deplete stock');
 await api(`/api/orders/${paid.id}/payments`,bar,'POST',{method:'cash',amount:40,idempotencyKey:randomUUID()},201);
 const snapshot=(await pool.query('SELECT row_to_json(s) AS row FROM pos_order_pricing_snapshots s WHERE order_id=$1',[paid.id])).rows;
 await progress(paid,p,'in_progress','queued');eq((await pool.query('SELECT row_to_json(s) AS row FROM pos_order_pricing_snapshots s WHERE order_id=$1',[paid.id])).rows,snapshot,'partial-payment snapshot immutable');eq(await stock(),stockBefore,'partial pay/start preparation does not deplete');
 await api(`/api/orders/${paid.id}/payments`,bar,'POST',{method:'card',amount:60,idempotencyKey:randomUUID()},201);eq(await state(paid),'closed','payment closes financial order');
 const beforePayments=await api(`/api/orders/${paid.id}/payments`,bar);
 const stockClosed=await stock();eq(stockClosed.filter(x=>x.direction==='out').length,1,'final payment depletes exactly once');
 ok((await api('/api/preparation/queue',bar)).items.some(x=>x.orderId===paid.id),'paid unfinished stays queue');
 await progress(paid,p,'ready','in_progress');eq(await state(paid),'closed','ready cannot reopen financially closed order');eq(await api(`/api/orders/${paid.id}/payments`,bar),beforePayments,'preparation cannot mutate payment ledger');eq(await stock(),stockClosed,'ready after paid cannot duplicate stock movement');
 await dispatch(paid,'bar',[p],bar,409);
 const cancelled=await order(),c=await add(cancelled,goods.bar);await dispatch(cancelled,'bar',[c]);await api(`/api/orders/${cancelled.id}/status`,owner,'POST',{status:'cancelled'});
 ok(!(await api('/api/preparation/queue',bar)).items.some(x=>x.orderId===cancelled.id),'cancelled order absent from queue');await progress(cancelled,c,'in_progress','queued',bar,409);
 await api(`/api/staff/${actors.bartender}/profile`,owner,'PATCH',{permissionScopes:['finance_read']});await api('/api/preparation/queue',bar,'GET',undefined,403);await progress(unknown,u,'in_progress','queued',bar,403);
 console.log(`ORDER PREPARATION POSTGRES QA: PASS (${checks} assertions; isolated API/PG stations, mixed aggregate, concurrency, replay, RBAC, snapshot/payment continuity)`);
}
main().catch(error=>{console.error(guards.safeText(error.stack,config));process.exitCode=1;}).finally(async()=>{
 try{if(child&&child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}if(pool)await pool.end();if(created){await inspect();assert.match(database,/^audit_qa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE "${database}"`);console.log('CLEANUP PASS owned preparation QA database removed');}}catch(error){console.error('Preparation QA cleanup failed: '+guards.safeText(error.message,config));process.exitCode=1;}finally{if(admin)await admin.end();}
});
