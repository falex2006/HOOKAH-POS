'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Client}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const {endpoint}=require('./staff-schedule-local-docker.cjs');
async function main(){
  const c=config(),root=path.join(__dirname,'..'),tag=randomUUID().replaceAll('-','').slice(0,12);
  const names=[`schedule_upgrade_${tag}`,`schedule_restore_${tag}`];
  const admin=new Client(options(c));await admin.connect();const clients=[];
  const upgrade=['101_staff_schedule_grants.sql','102_staff_schedule_versions.sql','103_staff_schedule_planning.sql'].map(name=>fs.readFileSync(path.join(root,'migrations',name),'utf8')).join('\n');
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  async function snapshot(db){
    const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result={};
    for(const {tablename} of tables){assert.match(tablename,/^[a-z0-9_]+$/);result[tablename]=(await db.query(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.row);}
    return result;
  }
  async function sequences(db){
    const result={};
    for(const {sequencename} of (await db.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows){assert.match(sequencename,/^[a-z0-9_]+$/);result[sequencename]=(await db.query(`SELECT last_value::text,is_called FROM public."${sequencename}"`)).rows[0];}
    return result;
  }
  function docker(args,input){
    const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
    const r=spawnSync('docker',['--host',endpoint,...args],{input,env,windowsHide:true,maxBuffer:64*1024*1024});
    assert.equal(r.status,0,`Dedicated Docker ${args[0]} failed`);return r.stdout;
  }
  try{
    for(const name of names){assert.match(name,/^schedule_(upgrade|restore)_[a-f0-9]{12}$/);assert.notEqual(name,c.database);await admin.query(`CREATE DATABASE "${name}"`);const db=new Client({...options(c),database:name});await db.connect();clients.push(db);}
    const [db,recovery]=clients;
    await db.query(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
    for(const name of fs.readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')&&Number(n.split('_')[0])<101).sort()) await db.query(fs.readFileSync(path.join(root,'migrations',name),'utf8'));
    await db.query('BEGIN');await db.query(upgrade);await db.query(upgrade);await db.query('ROLLBACK'); // empty table + replay rehearsal
    const org=randomUUID(),venue=randomUUID(),owner=randomUUID(),employee=randomUUID();
    await db.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Migration QA',$2)",[org,tag]);
    await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Migration QA','Asia/Yekaterinburg')",[venue,org]);
    for(const [id,role] of [[owner,'owner'],[employee,'bartender']])await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,$6)',[id,venue,org,role,`${id}@example.test`,role]);
    await db.query("INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,note,created_by) VALUES($1,$2,'2026-11-01',NULL,NULL,'legacy null',$3),($1,$2,'2026-11-02','2026-11-02T20:00+05:00','2026-11-03T04:00+05:00','night',$3),($1,$2,'2026-11-03','2026-11-03T10:00+05:00',NULL,'half null',$3)",[venue,employee,owner]);
    const approval=randomUUID(),approvedShift=randomUUID();
    const scheduleId=(await db.query("SELECT id FROM staff_schedules WHERE venue_id=$1 AND work_date='2026-11-02'",[venue])).rows[0].id;
    const logId=(await db.query("INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,'2026-11-02T20:00+05:00','2026-11-03T04:00+05:00','manual') RETURNING id",[venue,employee])).rows[0].id;
    await db.query("INSERT INTO payroll_attendance_approvals(id,venue_id,period_from,period_to,revision,venue_timezone,reason,source_watermark,source_schedule_count,source_log_count,shift_count,approved_by,approved_by_name,idempotency_key) VALUES($1,$2,'2026-11-01','2026-11-30',1,'Asia/Yekaterinburg','Synthetic frozen migration fixture',$3,1,1,1,$4,'QA owner',$5)",[approval,venue,'0'.repeat(64),owner,randomUUID()]);
    await db.query("INSERT INTO payroll_attendance_approval_shifts(id,venue_id,approval_id,schedule_source_id,employee_id,employee_name_snapshot,work_date,planned_start,planned_end,planned_minutes,worked_minutes,source_interval_count) VALUES($1,$2,$3,$4,$5,'Frozen QA employee','2026-11-02','2026-11-02T20:00+05:00','2026-11-03T04:00+05:00',480,480,1)",[approvedShift,venue,approval,scheduleId,employee]);
    await db.query("INSERT INTO payroll_attendance_approval_intervals(venue_id,approval_id,shift_id,source_work_log_id,employee_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,$5,'2026-11-02T20:00+05:00','2026-11-03T04:00+05:00','manual')",[venue,approval,approvedShift,logId,employee]);
    const before=await snapshot(db),beforeSequences=await sequences(db);
    const schemaDump=name=>docker(['exec',c.container,'pg_dump','-U',c.dbUser,'-d',name,'--schema-only','--no-owner']).toString('utf8').split(/\r?\n/).filter(line=>!/^\\(?:un)?restrict /.test(line)).join('\n');
    // PostgreSQL can flatten nested AND nodes when reading its own dumped CHECK.
    // Reparse CHECKs only in the two disposable databases, then dump normally.
    // No substitutions in SQL text (including comments/function bodies).
    async function canonicalSchema(client,name){
      assert.ok(names.includes(name));assert.notEqual(name,c.database);
      assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name,name);
      const preserved=await snapshot(client);
      const checks=(await client.query("SELECT c.conname,t.relname,c.conislocal,c.coninhcount,obj_description(c.oid,'pg_constraint') AS comment,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='c' ORDER BY t.relname,c.conname")).rows;
      const quote=s=>'"'+s.replaceAll('"','""')+'"';
      await client.query('BEGIN');
      try{
        for(const check of checks){
          assert.ok(check.conislocal && check.coninhcount===0,'Inherited CHECK requires a separate verifier');
          let current=check.definition,stable=false;
          for(let pass=0;pass<3;pass++){
            await client.query(`ALTER TABLE public.${quote(check.relname)} DROP CONSTRAINT ${quote(check.conname)}`);
            await client.query(`ALTER TABLE public.${quote(check.relname)} ADD CONSTRAINT ${quote(check.conname)} ${current}`);
            const next=(await client.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',['public.'+quote(check.relname),check.conname])).rows[0].definition;
            if(next===current){stable=true;break;}current=next;
          }
          assert.ok(stable,'CHECK parsing did not stabilize');
          if(check.comment!==null){const commentSql=(await client.query("SELECT format('COMMENT ON CONSTRAINT %I ON public.%I IS %L',$1::text,$2::text,$3::text) AS sql",[check.conname,check.relname,check.comment])).rows[0].sql;await client.query(commentSql);}
        }
        assert.deepEqual(await snapshot(client),preserved,'CHECK reparse changed rows');
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
      return schemaDump(name);
    }
    const beforeSchema=await canonicalSchema(db,names[0]);
    const backup=docker(['exec',c.container,'pg_dump','-U',c.dbUser,'-d',names[0],'-Fc','--no-owner']);
    const backupFile=path.join(folder,`${names[0]}.dump`);fs.writeFileSync(backupFile,backup,{flag:'wx'});
    await db.query('BEGIN');await db.query(upgrade);
    await assert.rejects(db.query('SELECT 1/0'));await db.query('ROLLBACK');
    assert.deepEqual(await snapshot(db),before,'Failed transactional upgrade must leave original schema/data');
    assert.deepEqual(await sequences(db),beforeSequences,'Failed upgrade changed sequences');
    await db.query('BEGIN');await db.query(upgrade);await db.query('COMMIT');
    const after=await snapshot(db);
    for(const table of ['staff_schedule_drafts','staff_schedule_templates','staff_schedule_planning_events'])assert.deepEqual(after[table],[],'Planning migration must not create live proposals or events');
    for(const [table,rows] of Object.entries(before)){
      if(table==='staff_schedules'){
        for(const old of rows){const current=after[table].find(r=>r.id===old.id);assert.ok(current);for(const [key,value] of Object.entries(old))assert.deepEqual(current[key],value);assert.equal(current.kind,'shift');assert.equal(current.version,1);}
      }else assert.deepEqual(after[table],rows,`Unrelated table ${table} changed`);
    }
    await db.query('BEGIN');await db.query(upgrade);await db.query('COMMIT');assert.deepEqual(await snapshot(db),after,'Replay must preserve all rows');
    docker(['exec','-i',c.container,'pg_restore','-U',c.dbUser,'-d',names[1],'--exit-on-error','--no-owner'],fs.readFileSync(backupFile));
    assert.deepEqual(await snapshot(recovery),before,'Restored pre-upgrade schema/data differs');
    assert.deepEqual(await sequences(recovery),beforeSequences,'Restored sequence state differs');
    const restoredSchema=await canonicalSchema(recovery,names[1]);
    if(restoredSchema!==beforeSchema){let offset=0;while(restoredSchema[offset]===beforeSchema[offset])offset++;throw new Error('Schema mismatch near '+JSON.stringify({offset,before:beforeSchema.slice(offset-100,offset+160),restored:restoredSchema.slice(offset-100,offset+160)}));}
    await recovery.query('BEGIN');await recovery.query(upgrade);await recovery.query('COMMIT');
    const restored=await snapshot(recovery);for(const old of before.staff_schedules){const row=restored.staff_schedules.find(r=>r.id===old.id);for(const [key,value] of Object.entries(old))assert.deepEqual(row[key],value);}
    for(const table of ['payroll_attendance_approvals','payroll_attendance_approval_shifts','payroll_attendance_approval_intervals'])assert.deepEqual(restored[table],before[table],'Frozen payroll changed');
    const report={databases:names,backup:path.basename(backupFile),beforeDigest:digest(before),upgradeDigest:digest(after),checks:['empty-upgrade/replay rollback','populated failed-upgrade rollback','all legacy columns preserved','unrelated tables unchanged','upgrade replay unchanged','pg_dump/pg_restore exact schema-data snapshot','restored upgrade preserves schedules'],retained:true};
    fs.writeFileSync(path.join(folder,`migration-recovery-${tag}.json`),JSON.stringify(report,null,2),{flag:'wx'});
    console.log('MIGRATION RECOVERY PASS: '+JSON.stringify(report));
  }finally{for(const db of clients)await db.end();await admin.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
