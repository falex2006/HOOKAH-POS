'use strict';
// Opt-in real service/PostgreSQL proof. Creates its own template0 database on
// the identity-verified local schedule container; never writes the shared QA DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { config, options } = require('./staff-schedule-local-config.cjs');
const service = require('../staff-schedule-service');
const copy = require('../staff-schedule-copy');
const planning = require('../staff-schedule-planning');
const series = require('../staff-schedule-series');
const attendance = require('../staff-attendance-service');
const root = path.resolve(__dirname, '..');
const key = () => randomUUID();
const quote = value => '"' + value.replace(/"/g, '""') + '"';

async function main() {
  if (!process.argv.includes('--run')) { console.log('SKIP: use --run for a new guarded disposable database (no existing QA DB writes).'); return; }
  const c = config();
  const name = `prep_override_qa_${Date.now()}_${key().replace(/-/g, '').slice(0, 12)}`;
  assert.match(name, /^prep_override_qa_[0-9]+_[a-f0-9]{12}$/);
  assert.notEqual(name, c.database);
  const connection = { ...options(c), connectionTimeoutMillis: 10000, statement_timeout: 30000, lock_timeout: 10000 };
  const admin = new Client({ ...connection, database: 'postgres' });
  let created = false, db, pool, checks = 0;
  const check = async (label, action) => { await action(); checks++; console.log(`PASS ${checks}: ${label}`); };
  await admin.connect();
  try {
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'postgres');
    await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`); created = true;
    db = new Client({ ...connection, database: name }); await db.connect();
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, name);
    const apply = async file => {
      await db.query('BEGIN');
      try { await db.query(fs.readFileSync(path.join(root, file), 'utf8')); await db.query('COMMIT'); }
      catch (e) { await db.query('ROLLBACK'); throw e; }
    };
    await apply('schema.sql');
    const migrations = fs.readdirSync(path.join(root, 'migrations')).filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0,3)) <= 113).sort();
    for (const file of migrations) await apply(`migrations/${file}`);
    const org = key(), venue = key(), owner = key(), employee = key();
    await db.query('INSERT INTO organizations(id,name,slug) VALUES($1,\'Prep QA\',$2)', [org, `qa-${org}`]);
    await db.query('INSERT INTO venues(id,name,organization_id,timezone) VALUES($1,\'Prep QA\',$2,\'UTC\')', [venue, org]);
    for (const [id, role] of [[owner,'owner'], [employee,'bartender']]) {
      await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,\'Prep QA\',$4,$5)', [id,venue,org,`qa-${id}`,role]);
    }
    const legacy = (await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
      VALUES($1,$2,'2035-01-01','2035-01-01T10:00Z','2035-01-01T18:00Z',$3) RETURNING id`, [venue,employee,owner])).rows[0];
    // Rehearse transactional rollback before keeping the additive migration.
    await db.query('BEGIN');
    await db.query(fs.readFileSync(path.join(root,'migrations/114_staff_schedule_preparation.sql'),'utf8'));
    await db.query('ROLLBACK');
    assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='staff_schedules' AND column_name='preparation_minutes'")).rowCount,0);
    await apply('migrations/114_staff_schedule_preparation.sql');
    await apply('migrations/114_staff_schedule_preparation.sql');
    pool = new Pool({ ...connection, database: name, max: 4 });
    const p = { userId: owner, venueId: venue };
    const stored = async id => (await pool.query('SELECT preparation_minutes,status FROM staff_schedules WHERE id=$1', [id])).rows[0];
    const entry = (day, extra = {}) => ({ userId: employee, workDate: day, plannedStart: `${day}T10:00Z`, plannedEnd: `${day}T18:00Z`, reason: 'QA preparation', confirmWarnings: true, requestKey: key(), ...extra });
    const call = (resource,id,action,method,input={}) => planning.handle(pool,p,resource,id,action,method,input);
    const makeDraft = (day, to=day) => call('drafts',null,null,'POST',{ name:'Prep QA',from:day,to,userIds:[employee],requestKey:key() });
    const edit = (d, operations) => call('drafts',d.id,null,'PATCH',{version:d.version,operations,requestKey:key()});
    const publish = async d => {
      const preview = await call('drafts',d.id,'publish-preview','POST',{version:d.version});
      assert.deepEqual(preview.conflicts, []);
      return call('drafts',d.id,'publish','POST',{version:d.version,fingerprint:preview.fingerprint,confirmWarnings:true,reason:'QA publish',requestKey:key()});
    };
    const rowsFor = async day => (await pool.query('SELECT * FROM staff_schedules WHERE venue_id=$1 AND work_date=$2 ORDER BY planned_start', [venue,day])).rows;
    await check('additive migration replay; existing rows inherit; DB constraints', async () => {
      assert.equal((await stored(legacy.id)).preparation_minutes, null);
      for (const value of [-1,241]) await assert.rejects(pool.query('UPDATE staff_schedules SET preparation_minutes=$2 WHERE id=$1',[legacy.id,value]), {code:'23514'});
      await assert.rejects(pool.query("UPDATE staff_schedules SET kind='sick',planned_start=NULL,planned_end=NULL,preparation_minutes=0 WHERE id=$1",[legacy.id]), {code:'23514'});
    });
    let direct;
    await check('direct create/edit omitted preserves zero; explicit null resets', async () => {
      direct = await service.save(pool,p,entry('2035-01-02',{preparationMinutes:0}));
      assert.equal(direct.preparationMinutes,0);
      direct = await service.save(pool,p,entry('2035-01-02',{version:direct.version,note:'changed'}),direct.id);
      assert.equal((await stored(direct.id)).preparation_minutes,0);
      direct = await service.save(pool,p,entry('2035-01-02',{version:direct.version,preparationMinutes:null}),direct.id);
      assert.equal((await service.get(pool,p,direct.id)).preparationMinutes,null);
      direct = await service.save(pool,p,entry('2035-01-02',{version:direct.version,preparationMinutes:30}),direct.id);
    });
    await check('copy preview and apply retain concrete override', async () => {
      const zero=await service.save(pool,p,entry('2035-01-03',{preparationMinutes:0}));
      const inherited=await service.save(pool,p,entry('2035-01-04'));
      const input = {sourceFrom:'2035-01-02',targetFrom:'2035-01-09',userIds:[employee]};
      const preview = await copy.preview(pool,p,input);
      assert.equal(preview.items.find(i=>i.sourceId===direct.id).preparationMinutes,30);
      const result = await copy.apply(pool,p,{...input,fingerprint:preview.fingerprint,sourceIds:[direct.id,zero.id,inherited.id],reason:'QA copy',confirmWarnings:true,requestKey:key()});
      assert.equal((await stored(result.items[0].id)).preparation_minutes,30);
      assert.equal((await stored(result.items[1].id)).preparation_minutes,0);
      assert.equal((await stored(result.items[2].id)).preparation_minutes,null);
    });
    await check('draft base fallback and subsequent omitted edit preserve override; null reset', async () => {
      let d = await makeDraft('2035-01-02');
      d = await edit(d,[{operation:'update',sourceId:direct.id,sourceVersion:direct.version,payload:entry('2035-01-02')}]);
      assert.equal(d.operations[0].payload.preparationMinutes,30);
      await publish(d);
      assert.equal((await stored(direct.id)).preparation_minutes,30);
      d = await makeDraft('2035-01-02');
      d = await edit(d,[{operation:'update',operationId:undefined,sourceId:direct.id,sourceVersion:direct.version+1,payload:entry('2035-01-02',{preparationMinutes:null})}]);
      assert(d.operations[0].operationId);
      const payload={...d.operations[0].payload}; delete payload.preparationMinutes;
      d=await edit(d,[{...d.operations[0],operationId:undefined,payload}]);
      assert.equal(d.operations[0].payload.preparationMinutes,null);
      await publish(d); assert.equal((await stored(direct.id)).preparation_minutes,null);
    });
    await check('pre-migration draft snapshot absent field equals SQL NULL', async () => {
      let d = await makeDraft('2035-01-01');
      const base=(await pool.query('SELECT base_snapshot FROM staff_schedule_drafts WHERE id=$1',[d.id])).rows[0].base_snapshot;
      for(const row of base)delete row.preparation_minutes;
      await pool.query('UPDATE staff_schedule_drafts SET base_snapshot=$2::jsonb WHERE id=$1',[d.id,JSON.stringify(base)]);
      d=await edit(d,[{operation:'update',sourceId:legacy.id,sourceVersion:1,payload:entry('2035-01-01')}]);
      await publish(d); assert.equal((await stored(legacy.id)).preparation_minutes,null);
    });
    await check('manual create draft gets identity; omitted edit preserves draft-local prep', async () => {
      let d=await makeDraft('2035-01-20');
      d=await edit(d,[{operation:'create',payload:entry('2035-01-20',{preparationMinutes:0})}]);
      assert(d.operations[0].operationId);
      const payload={...d.operations[0].payload,note:'changed'};delete payload.preparationMinutes;
      d=await edit(d,[{...d.operations[0],payload}]);
      assert.equal(d.operations[0].payload.preparationMinutes,0);
      await publish(d);assert.equal((await rowsFor('2035-01-20'))[0].preparation_minutes,0);
    });
    let template, templateShift;
    const definition = minutes => ({schemaVersion:2,mode:'team',pattern:{type:'weekdays',weekdays:[1,2,3,4,5,6,7]},members:[{userId:employee,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',preparationMinutes:minutes}]}]});
    await check('template range draft edit/reopen/publish freezes prep; later template edits independent', async () => {
      template=await call('templates',null,null,'POST',{name:'Prep template',definition:definition(30),requestKey:key()});
      let d=await makeDraft('2035-02-01');
      const input={version:d.version,from:d.from,to:d.to,userIds:[employee],templateId:template.id,templateVersion:template.version,
        composition:[{userId:employee,selected:true,functionId:null,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00'}]}]};
      const preview=await call('drafts',d.id,'range-preview','POST',input);
      assert.equal(preview.operations[0].payload.preparationMinutes,30);
      d=await call('drafts',d.id,'range-apply','POST',{...input,fingerprint:preview.fingerprint,confirmWarnings:true,reason:'QA',requestKey:key()});
      const payload={...d.operations[0].payload,note:'edited without prep'};delete payload.preparationMinutes;
      d=await edit(d,[{...d.operations[0],payload}]);
      assert.equal(d.operations[0].payload.preparationMinutes,30);
      d=await call('drafts',d.id,null,'GET');await publish(d);
      templateShift=(await rowsFor('2035-02-01'))[0];assert.equal(templateShift.preparation_minutes,30);
      const omitted=definition(30);delete omitted.members[0].slots[0].preparationMinutes;
      omitted.members[0].slots[0].note='edited template';
      template=await call('templates',template.id,null,'PATCH',{version:template.version,definition:omitted,requestKey:key()});
      assert.equal(template.definition.members[0].slots[0].preparationMinutes,30);
      template=await call('templates',template.id,null,'PATCH',{version:template.version,definition:definition(60),requestKey:key()});
      assert.equal((await stored(templateShift.id)).preparation_minutes,30);
    });
    await check('series slot and replace exception reach published rows; manual exception retains prep', async () => {
      let seriesRow=await series.saveSeries(pool,p,null,{name:'Prep series',userId:employee,anchorDate:'2035-03-01',untilDate:'2035-03-03',recurrence:{pattern:{type:'weekdays',weekdays:[1,2,3,4,5,6,7]},slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',preparationMinutes:45}]},requestKey:key()},'POST');
      const input={name:seriesRow.name,userId:employee,anchorDate:seriesRow.anchorDate,untilDate:seriesRow.untilDate,recurrence:seriesRow.recurrence,version:seriesRow.version,requestKey:key(),exceptions:[{occurrenceDate:'2035-03-02',occurrenceKey:seriesRow.recurrence.slotKeys[0],kind:'replace',slot:{kind:'shift',startTime:'10:00',endTime:'18:00',preparationMinutes:0}}]};
      seriesRow=await series.saveSeries(pool,p,seriesRow.id,input,'PATCH');
      const omitted=structuredClone(input);omitted.version=seriesRow.version;omitted.requestKey=key();
      delete omitted.recurrence.slots[0].preparationMinutes;delete omitted.exceptions[0].slot.preparationMinutes;
      seriesRow=await series.saveSeries(pool,p,seriesRow.id,omitted,'PATCH');
      assert.equal(seriesRow.recurrence.slots[0].preparationMinutes,45);
      assert.equal(seriesRow.exceptions[0].slot.preparationMinutes,0);
      let d=await makeDraft('2035-03-01','2035-03-02');
      const rangeInput={version:d.version,from:d.from,to:d.to,seriesId:seriesRow.id,seriesVersion:seriesRow.version};
      const preview=await call('drafts',d.id,'range-preview','POST',rangeInput);
      d=await call('drafts',d.id,'range-apply','POST',{...rangeInput,fingerprint:preview.fingerprint,confirmWarnings:true,reason:'QA',requestKey:key()});
      await publish(d);
      const first=(await rowsFor('2035-03-01'))[0],second=(await rowsFor('2035-03-02'))[0];
      assert.equal(first.preparation_minutes,45);assert.equal(second.preparation_minutes,0);
      await service.save(pool,p,entry('2035-03-01',{version:first.version,note:'manual adjustment'}),first.id);
      const after=await series.readSeries(pool,p,seriesRow.id);
      assert.equal(after.exceptions.find(e=>e.kind==='manual').schedule.preparationMinutes,45);
    });
    await check('real admission uses persisted override; NULL follows venue; zero forbids early prep', async () => {
      const live=(await pool.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by,preparation_minutes)
        VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '2 hours',$3,30) RETURNING id`,[venue,employee,owner])).rows[0];
      const principal={userId:employee,venueId:venue},settings={mode:'approval',preparationMinutes:0};
      assert.equal((await attendance.admission(pool,principal,settings)).decision.basis,'preparation');
      await pool.query('UPDATE staff_schedules SET preparation_minutes=0 WHERE id=$1',[live.id]);
      assert.equal((await attendance.admission(pool,principal,{...settings,preparationMinutes:60})).decision.decision,'approval_required');
      await pool.query('UPDATE staff_schedules SET preparation_minutes=NULL WHERE id=$1',[live.id]);
      assert.equal((await attendance.admission(pool,principal,{...settings,preparationMinutes:60})).decision.basis,'preparation');
      assert.equal((await attendance.admission(pool,principal,settings)).decision.decision,'approval_required');
    });
    await check('cancel preserves override; shift-to-absence clears omitted override', async () => {
      const shift=await service.save(pool,p,entry('2035-04-01',{preparationMinutes:0}));
      await service.save(pool,p,{status:'cancelled',version:shift.version,reason:'QA cancel',requestKey:key()},shift.id);
      assert.equal((await stored(shift.id)).preparation_minutes,0);
      const other=await service.save(pool,p,entry('2035-04-02',{preparationMinutes:30}));
      await service.save(pool,p,{userId:employee,workDate:'2035-04-02',kind:'sick',version:other.version,requestKey:key()},other.id);
      assert.equal((await stored(other.id)).preparation_minutes,null);
    });
    console.log(`PREP OVERRIDE PG PASS ${checks} service suites; not browser/HTTP proof.`);
  } finally {
    if(pool)await pool.end();
    if(db)await db.end();
    try {
      if(created){
        assert.match(name,/^prep_override_qa_[0-9]+_[a-f0-9]{12}$/);assert.notEqual(name,c.database);
        await admin.query(`DROP DATABASE ${quote(name)}`);
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);
        console.log('CLEANUP PASS: only this run disposable database removed; shared QA and previews untouched.');
      }
    } finally { await admin.end(); }
  }
}
main().catch(error=>{console.error(`PREP OVERRIDE PG FAIL: ${error.code||error.name}: ${error.message}`);process.exitCode=1;});
