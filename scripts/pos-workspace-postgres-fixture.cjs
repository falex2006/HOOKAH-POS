'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {randomUUID,randomBytes,scryptSync}=require('node:crypto');
const {Pool}=require('pg');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),runtimeDir=path.join(root,'tmp','full-local-qa'),privateFile=path.join(runtimeDir,'pos-workspace-private.json'),serverFile=path.join(runtimeDir,'pos-workspace-qa-server.cjs');fs.mkdirSync(runtimeDir,{recursive:true});
const g=require(path.join(root,'scripts/local-full-pg-regression.cjs'));
const c=g.validateConfig(JSON.parse(fs.readFileSync(path.join(runtimeDir,'runtime.json'),'utf8')));
const ownerTag='pos-employee-workspace-20261011';
const urlFor=database=>`postgresql://${encodeURIComponent(c.dbUser)}:${encodeURIComponent(c.dbPassword)}@127.0.0.1:31931/${database}`;
const write=m=>fs.writeFileSync(privateFile,JSON.stringify(m,null,2),{mode:0o600});
async function guard(){
  const inspected=spawnSync('docker',['inspect',c.regressionContainer],{encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(inspected.status,0,'QA container unavailable');g.validateContainer(JSON.parse(inspected.stdout)[0],c);
  const safety=await import(pathToFileURL(path.join(root,'scripts/postgres-qa-safety.mjs')).href);
  process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER=c.regressionContainer;
  safety.validateQaDatabaseUrl(urlFor(c.database));
  const probe=new Pool({connectionString:urlFor(c.database),max:1,connectionTimeoutMillis:5000});
  try{safety.assertQaDatabaseIdentity((await probe.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],c.database,31931);}finally{await probe.end();}
}
function validateManifest(m){assert.equal(m.ownerTag,ownerTag);assert.equal(m.root,root);assert.match(m.database,/^audit_qa_[a-f0-9]{16}$/);return m;}
async function api(m,route,role='owner',method='GET',input,expected=200){
  const response=await fetch(m.base+route,{method,headers:{authorization:'Bearer '+m.actors[role].token,'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
  const payload=await response.json();assert.equal(response.status,expected,`${method} ${route}: ${payload.error||'unexpected status'}`);return payload;
}
async function main(){
  await guard();
  if(fs.existsSync(privateFile)){
    const existing=validateManifest(JSON.parse(fs.readFileSync(privateFile,'utf8')));
    if(process.argv.includes('--stop')){
      assert.equal(existing.state,'ready');
      const cmd=spawnSync('powershell',['-NoProfile','-Command',`$taskProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(existing.childPid)}'; if($taskProcess){$taskProcess.CommandLine}`],{encoding:'utf8',windowsHide:true});
      assert.equal(cmd.status,0);assert.ok(cmd.stdout.includes(serverFile),'Refusing unrelated process');
      process.kill(existing.childPid);await new Promise(resolve=>setTimeout(resolve,700));
      const admin=new Pool({connectionString:urlFor(c.database),max:1});
      try{await guard();await admin.query(`DROP DATABASE "${existing.database}"`);}finally{await admin.end();}
      existing.state='stopped';delete existing.actors;write(existing);console.log('PASS stopped own QA server and removed only runner-owned random database');return;
    }
    assert.equal(existing.state,'ready','Existing partial/stopped QA manifest requires investigation; no automatic reset');
    const health=await (await fetch(existing.base+'/api/health')).json();assert.equal(health.database,'postgres');
    console.log('REUSE existing isolated POS QA '+existing.base+'; private manifest ready; no reset/reseed/restart');return;
  }
  assert.ok(!process.argv.includes('--stop'),'No owned QA manifest to stop');
  const m={ownerTag,root,state:'creating',database:'audit_qa_'+randomBytes(8).toString('hex'),createdAt:new Date().toISOString(),ids:{organization:randomUUID(),venue:randomUUID(),foreignOrganization:randomUUID(),foreignVenue:randomUUID(),zones:[randomUUID(),randomUUID()],tables:Array.from({length:10},()=>randomUUID()),orders:{mixed:randomUUID(),ready:randomUUID(),paidUnfinished:randomUUID()},products:{bar:randomUUID(),hookah:randomUUID(),unknown:randomUUID(),barLong:randomUUID(),barSecond:randomUUID(),hookahSecond:randomUUID(),unknownSecond:randomUUID()},items:{}},actors:{}};
  const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex'),hash=`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`;
  for(const role of ['owner','admin','manager','bartender','hookah_master','cleaner','foreign'])m.actors[role]={id:randomUUID(),login:'pos-workspace-'+role+'-'+randomUUID(),password};
  write(m);
  const admin=new Pool({connectionString:urlFor(c.database),max:1});let pool,child;
  try{
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[m.database])).rowCount,0,'Refusing existing database');
    await admin.query(`CREATE DATABASE "${m.database}"`);m.databaseCreated=true;write(m);
    pool=new Pool({connectionString:urlFor(m.database),max:4});
    await pool.query(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
    for(const file of fs.readdirSync(path.join(root,'migrations')).filter(x=>x.endsWith('.sql')).sort())await pool.query(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
    await pool.query('BEGIN');
    for(const [org,venue,name]of [[m.ids.organization,m.ids.venue,'HOOKAH POS — QA рабочее место'],[m.ids.foreignOrganization,m.ids.foreignVenue,'QA чужая точка']]){
      await pool.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)',[org,name,'pos-workspace-'+org,'Asia/Yekaterinburg']);
      await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)",[org]);
      await pool.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)',[venue,org,name,'Asia/Yekaterinburg']);
    }
    const names={owner:'Анна Владелец',admin:'Мария Администратор',manager:'Олег Управляющий',bartender:'Иван Бармен',hookah_master:'Алексей Кальянщик',cleaner:'Светлана Уборщик',foreign:'QA Чужой владелец'};
    for(const [role,a]of Object.entries(m.actors)){
      const foreign=role==='foreign',venue=foreign?m.ids.foreignVenue:m.ids.venue,org=foreign?m.ids.foreignOrganization:m.ids.organization;
      await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,preferences) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.id,venue,org,names[role],a.login,hash,foreign?'owner':role,{theme:'dark'}]);
      await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')",[org,a.id,['owner','foreign'].includes(role)?'owner':'member']);
    }
    for(let z=0;z<2;z++)await pool.query('INSERT INTO zones(id,venue_id,name,sort_order) VALUES($1,$2,$3,$4)',[m.ids.zones[z],m.ids.venue,z?'VIP-зал':'Основной зал',z]);
    const statuses=['free','occupied','reserved','awaiting_payment','blocked'];
    for(let i=0;i<10;i++)await pool.query('INSERT INTO tables(id,zone_id,name,capacity,status,layout,min_order_total) VALUES($1,$2,$3,$4,$5,$6,$7)',[m.ids.tables[i],m.ids.zones[Math.floor(i/5)],i<5?'Стол '+(i+1):'VIP '+(i-4),i<5?4:6,statuses[i%5],{unit:'px',x:(i%5%3)*225+24,y:Math.floor(i%5/3)*165+24,width:180,height:120,shape:i===6?'round':'rect'},i<5?0:1500]);
    for(const [key,name,category,price,station]of [['bar','Мятный чай','Бар',350,'bar'],['hookah','Кальян — фруктовый микс','Кальяны',1600,'hookah'],['unknown','Авторский заказ','Услуги',450,null],['barLong','Лимонад цитрусовый с базиликом — большой графин','Бар',650,'bar'],['barSecond','Капучино','Бар',250,'bar'],['hookahSecond','Замена чаши — ягодный микс','Кальяны',900,'hookah'],['unknownSecond','Дополнительная услуга','Услуги',300,null]])await pool.query("INSERT INTO products(id,venue_id,name,category,sale_price,inventory_mode,preparation_station) VALUES($1,$2,$3,$4,$5,'non_stock',$6)",[m.ids.products[key],m.ids.venue,name,category,price,station]);
    for(const [category,department]of [['Бар','bar'],['Кальяны','hookah'],['Услуги','bar']])await pool.query('INSERT INTO product_categories(venue_id,name,department) VALUES($1,$2,$3) ON CONFLICT(venue_id,name) DO NOTHING',[m.ids.venue,category,department]);
    const guest=randomUUID();m.ids.guest=guest;await pool.query("INSERT INTO guests(id,venue_id,full_name,phone) VALUES($1,$2,'Елена QA','+79990000000')",[guest,m.ids.venue]);
    for(const i of [2,7])await pool.query("INSERT INTO reservations(id,venue_id,table_id,guest_id,starts_at,guests_count,status) VALUES($1,$2,$3,$4,date_trunc('day',now() AT TIME ZONE 'Asia/Yekaterinburg') AT TIME ZONE 'Asia/Yekaterinburg' + interval '20 hours',3,'confirmed')",[randomUUID(),m.ids.venue,m.ids.tables[i],guest]);
    await pool.query('INSERT INTO shifts(id,venue_id,opened_by,opening_cash) VALUES($1,$2,$3,0)',[randomUUID(),m.ids.venue,m.actors.owner.id]);
    for(const [key,table,status,mins]of [['mixed',1,'in_progress',17],['ready',6,'ready',28],['paidUnfinished',0,'in_progress',42]])await pool.query("INSERT INTO orders(id,venue_id,table_id,opened_by,status,notes,created_at,closed_at) VALUES($1,$2,$3,$4,$5::order_status,$6,now()-($7*interval '1 minute'),CASE WHEN $5::order_status='closed'::order_status THEN now()-interval '2 minutes' ELSE NULL END)",[m.ids.orders[key],m.ids.venue,m.ids.tables[table],m.actors.bartender.id,status,key==='mixed'?'Без сахара. Кальян средней крепости.':'',mins]);
    async function line(key,order,product,status,minutes=0){
      const id=randomUUID();m.ids.items[key]=id;
      await pool.query('INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at) SELECT $1,$2,id,1,sale_price,category,$4,now() FROM products WHERE id=$3',[id,m.ids.orders[order],m.ids.products[product],m.actors.bartender.id]);
      await pool.query("INSERT INTO order_item_execution(order_item_id,station,status,dispatched_at,started_at,ready_at) SELECT $1,preparation_station,$3,CASE WHEN $3<>'new' THEN now()-($4*interval '1 minute') ELSE NULL END,CASE WHEN $3 IN ('in_progress','ready') THEN now()-($4*interval '1 minute')+interval '1 minute' ELSE NULL END,CASE WHEN $3='ready' THEN now()-interval '2 minutes' ELSE NULL END FROM products WHERE id=$2",[id,m.ids.products[product],status,minutes]);
    }
    await line('newBar','mixed','bar','new');await line('newHookah','mixed','hookah','new');await line('newUnknown','mixed','unknown','new');await line('queuedBar','mixed','barLong','queued',12);await line('workingHookah','mixed','hookahSecond','in_progress',15);await line('readyBar','ready','barSecond','ready',20);await line('readyHookah','ready','hookah','ready',23);await line('paidWorkingBar','paidUnfinished','bar','in_progress',35);
    await pool.query('COMMIT');m.state='starting';write(m);
    fs.writeFileSync(serverFile,"'use strict';\nconst fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');\nconst root=path.resolve(__dirname,'../..');\nconst g=require(path.join(root,'scripts/local-full-pg-regression.cjs'));\nconst c=g.validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8')));\nconst m=JSON.parse(fs.readFileSync(path.join(__dirname,'pos-workspace-private.json'),'utf8'));\nassert.equal(m.root,root);assert.equal(m.ownerTag,'pos-employee-workspace-20261011');assert.match(m.database,/^audit_qa_[a-f0-9]{16}$/);\nfor(const key of Object.keys(process.env))if(/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key))delete process.env[key];\nObject.assign(process.env,{HOST:'127.0.0.1',PORT:'0',NODE_ENV:'test',AUTH_REQUIRED:'true',DEMO_MODE:'false',COOKIE_SECURE:'false',DATABASE_URL:`postgresql://${encodeURIComponent(c.dbUser)}:${encodeURIComponent(c.dbPassword)}@127.0.0.1:31931/${m.database}`,VENUE_ID:m.ids.venue,SESSION_SECRET:c.appKey,STAFF_PASSPORT_KEY:c.appKey,API_RATE_LIMIT:'10000'});\nrequire(path.join(root,'server.js'));\n",{mode:0o600});
    const log=fs.openSync(path.join(runtimeDir,'pos-workspace-server.log'),'a');
    child=spawn(process.execPath,[serverFile],{cwd:root,windowsHide:true,detached:true,env:{...process.env},stdio:['ignore','pipe','pipe']});m.childPid=child.pid;write(m);
    let output='';const handleChunk=chunk=>{const sanitized=g.safeText(String(chunk),c,[password]);fs.writeSync(log,sanitized);output+=sanitized;};child.stdout.on('data',handleChunk);child.stderr.on('data',handleChunk);
    m.base=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Own POS server startup timeout; see sanitized server log')),20000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Own POS server exited early; see sanitized server log'));});child.stdout.on('data',()=>{const match=output.match(/CRM running on http:\/\/localhost:(\d+)/);if(match){clearTimeout(timeout);resolve('http://127.0.0.1:'+match[1]);}});});
    for(const actor of Object.values(m.actors)){
      const response=await fetch(m.base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:actor.login,password:actor.password})});const payload=await response.json();assert.equal(response.status,200,payload.error||'login failed');actor.token=payload.token;actor.user=payload.user;
    }
    const closedFixture=await api(m,`/api/orders/${m.ids.orders.paidUnfinished}/payments`,'bartender','POST',{method:'cash',amount:350,idempotencyKey:randomUUID()},201);
    assert.equal(closedFixture.closed,true);m.realPaidUnfinished=true;
    const floor=await api(m,'/api/floor','bartender');assert.equal(floor.zones.length,2);assert.equal(floor.zones.flatMap(z=>z.tables).length,10);assert.equal(new Set(floor.zones.flatMap(z=>z.tables.map(t=>t.status))).size,5);
    assert.deepEqual((await api(m,'/api/preparation/queue','bartender')).stations,['bar']);assert.deepEqual((await api(m,'/api/preparation/queue','hookah_master')).stations,['hookah']);assert.deepEqual((await api(m,'/api/preparation/queue','manager')).stations,['bar','hookah']);
    m.state='ready';write(m);child.stdout.destroy();child.stderr.destroy();child.unref();fs.closeSync(log);
    console.log('READY isolated POS QA '+m.base+'; 10 tables, 5 statuses, 2 zones, mixed+ready+closed unfinished orders, 7 products, 7 actors. Tokens only in ignored private manifest.');
  }catch(error){m.state='failed';m.failure=g.safeText(error.message,c,[password]);write(m);if(child)child.kill();throw error;}finally{await pool?.end();await admin.end();}
}
main().catch(error=>{console.error(g.safeText(error.message,c));process.exitCode=1;});
