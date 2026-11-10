import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { handleScheduleAccessRoute } = require('../staff-schedule-routes');
const { makeService } = require('../payroll-scheme-service');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const pool = new Pool({ connectionString: target.url.href });
const payroll = makeService(pool);
try {
  const identity = await pool.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser');
  assertQaDatabaseIdentity(identity.rows[0], target.database, Number(target.url.port));
  const migration = readFileSync(new URL('../migrations/214_payroll_calendar_substitutes.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
  const org = randomUUID(), venueId = randomUUID(), userId = randomUUID(), worker = randomUUID();
  await pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)', [org,'Calendar QA',org]);
  await pool.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Shift test','UTC')",[venueId,org]);
  for (const [id,role] of [[userId,'owner'],[worker,'bartender']]) {
    await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,$6)',[id,venueId,org,role,id,role]);
  }
  const entryId = randomUUID(), accountId = randomUUID();
  const oldPeriod = (await pool.query("SELECT (current_date-60)::text AS day")).rows[0].day;
  await pool.query(`INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by)
    VALUES($1,$2,'substitute-qa','QA bank','bank',ARRAY['bank_transfer'],$3)`,[accountId,venueId,userId]);
  await pool.query(`INSERT INTO payroll_entries(id,venue_id,user_id,period_from,period_to,amount,status,approved_by,approved_at)
    VALUES($1,$2,$3,$4,$4,700,'approved',$5,now())`,[entryId,venueId,worker,oldPeriod,userId]);
  const settlement = await pool.connect();
  try {
    await settlement.query('BEGIN');
    const expense=(await settlement.query(`INSERT INTO expenses(venue_id,category,amount,expense_date,description,
      source,created_by,payment_method,finance_account_id,finance_account_name_snapshot,payroll_settlement_entry_id)
      VALUES($1,'Зарплата',700,$2,'Prior paid interval','payroll',$3,'bank_transfer',$4,'QA bank',$5) RETURNING id`,
      [venueId,oldPeriod,userId,accountId,entryId])).rows[0];
    await settlement.query(`UPDATE payroll_entries SET status='paid',paid_at=now(),paid_by=$2,payment_date=$3,expense_id=$4 WHERE id=$1`,
      [entryId,userId,oldPeriod,expense.id]);
    await settlement.query('COMMIT');
  } catch (error) { await settlement.query('ROLLBACK'); throw error; } finally { settlement.release(); }
  const history = async () => (await pool.query(`SELECT to_jsonb(e) AS entry,to_jsonb(x) AS expense FROM payroll_entries e JOIN expenses x
    ON x.id=e.expense_id AND x.venue_id=e.venue_id WHERE e.id=$1`,[entryId])).rows;
  const settled = await history();
  assert.equal(settled[0].entry.status,'paid'); assert.equal(settled[0].expense.amount,700);
  const principal = { venueId, userId };
  const date = (await pool.query("SELECT (current_date + 1)::text AS day")).rows[0].day;
  const original = await payroll.createScheme(principal, { name: 'Original terms',
    payoutRiskAcknowledgement:{ confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1' },
    definition:{ mode:'stable_percent',currency:'RUB',effectiveFrom:date.slice(0,7)+'-01',roleParameters:{ bar:{ perShiftCents:25000,stableRateBps:1000 } },
      roleAssignments:[{employeeId:worker,roleId:'bar',effectiveFrom:date}] } });
  const callRoute = async (employee, method, suffix, input, trusted = true) => {
    let response;
    const handled = await handleScheduleAccessRoute({
      req:{user:{id:employee, venueId},method,headers:trusted ? {authorization:'Bearer fixture'} : {}},
      res:{}, url:new URL('/api/staff/schedule/' + suffix,'http://127.0.0.1'), pool, payrollSchemeService:payroll,
      readBody:async()=>input,checkOrganizationQuota:async()=>({}),
      json:(res,status,body)=>{response={status,body};}
    });
    assert.equal(handled,true);
    return response;
  };
  const originalVersion = original.versions[0].versionId;
  await payroll.activateVersion(principal, originalVersion);
  const snapshot = await payroll.getVersion(principal,originalVersion);
  const payload = { digest:snapshot.payoutRiskAcknowledgement.configDigest, name:'Replacement', workDate:date, roleKey:'bar', versionId:originalVersion, requestKey:randomUUID(),confirmRates:true };
  const allowed = async () => ({});
  await assert.rejects(payroll.enrollCalendarSubstitute({venueId,userId:worker},payload,allowed), {code:'payroll_scheme_owner_only'});
  await assert.rejects(payroll.enrollCalendarSubstitute(principal,payload,allowed), {code:'substitute_eligibility_setup_required'});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE venue_id=$1 AND full_name='Replacement'",[venueId])).rows[0].n,0);
  await payroll.createEmploymentEligibilityRevision(principal,{ expectedRevisionId:null,reason:'Owner opened payroll for QA',idempotencyKey:randomUUID(),
    periods:[{employeeId:worker,effectiveFrom:date,effectiveTo:null}] });
  await assert.rejects(payroll.enrollCalendarSubstitute(principal,payload,async () => ({error:'seat_limit_reached',status:409})),{code:'seat_limit_reached'});
  const future = '2099-04-01';
  await payroll.createVersion(principal,original.id,{...snapshot,effectiveFrom:future,
    roleAssignments:[{employeeId:worker,roleId:'bar',effectiveFrom:future}]},{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'});
  const options = await callRoute(userId,'GET','substitutes?workDate=' + date);
  assert.equal(options.status,200);
  assert.deepEqual(options.body.items[0].roles,['bar']);
  assert.equal(options.body.items[0].digest,payload.digest);
  assert.equal((await callRoute(worker,'GET','substitutes?workDate=' + date)).status,403);
  assert.equal((await callRoute(userId,'POST','substitutes',payload,false)).status,403);
  const pair = await Promise.all([payroll.enrollCalendarSubstitute(principal,payload,allowed),payroll.enrollCalendarSubstitute(principal,payload,allowed)]);
  assert.equal(pair[0].id,pair[1].id); assert.notEqual(pair[0].replayed,pair[1].replayed);
  const saved = pair[0];
  await assert.rejects(payroll.enrollCalendarSubstitute(principal,{...payload,name:'Other'},allowed),{code:'substitute_request_conflict'});
  assert.deepEqual(await payroll.getVersion(principal,originalVersion),snapshot);
  assert.equal((await callRoute(userId,'POST','substitutes',payload)).body.id,saved.id);
  const roster = await callRoute(userId,'GET','employees');
  assert.equal(roster.body.items.find(x=>x.id===saved.id).substitute,true);
  assert.equal(roster.body.items.find(x=>x.id===worker).substitute,false);
  const draft = await payroll.getVersion(principal,saved.versionId);
  assert.equal(draft.status,'draft');
  assert.deepEqual(draft.roleAssignments.find(row=>row.employeeId===saved.id),{employeeId:saved.id,roleId:'bar',effectiveFrom:date,effectiveTo:date});
  assert.deepEqual(draft.roleParameters,snapshot.roleParameters);
  const employment = await payroll.getEmploymentEligibilityHistory(principal);
  assert.deepEqual(employment.current.periods.map(row=>row.employeeId),[worker]);
  await assert.rejects(payroll.activateVersion(principal,saved.versionId),{code:'substitute_calendar_confirmation_required'});
  const credential = (await pool.query('SELECT role,password_hash,pin_hash FROM users WHERE id=$1',[saved.id])).rows[0];
  assert.deepEqual(credential,{role:'other_staff',password_hash:null,pin_hash:null});
  assert.equal(roster.body.items.find(x=>x.id===saved.id).substituteDraftId,saved.versionId);
  await assert.rejects(payroll.enrollCalendarSubstitute(principal,{...payload,workDate:'2001-01-01',requestKey:randomUUID()},allowed),{code:'substitute_past_date'});
  assert.equal((await callRoute(userId,'POST','substitutes/apply',{versionId:saved.versionId})).status,400);
  assert.equal((await callRoute(worker,'POST','substitutes/apply',{versionId:saved.versionId,confirmed:true})).status,403);
  const apply = () => callRoute(userId,'POST','substitutes/apply',{versionId:saved.versionId,confirmed:true});
  const applications = await Promise.all([apply(),apply()]);
  assert.ok(applications.every(x=>x.status===200),JSON.stringify(applications));
  assert.notEqual(applications[0].body.replayed,applications[1].body.replayed);
  const active = await payroll.getVersion(principal,saved.versionId);
  assert.deepEqual((await payroll.getEmploymentEligibilityHistory(principal)).current.periods.map(x=>x.employeeId).sort(),[worker,saved.id].sort());
  const previous = await payroll.getVersion(principal,originalVersion);
  assert.equal(active.status,'active'); assert.equal(previous.status,'retired');
  assert.equal(previous.effectiveTo,snapshot.effectiveTo);
  assert.deepEqual(previous.roleAssignments,snapshot.roleAssignments);
  assert.deepEqual(previous.payoutRiskAcknowledgement,snapshot.payoutRiskAcknowledgement);
  assert.deepEqual(active.roleParameters,snapshot.roleParameters);
  assert.equal((await callRoute(userId,'GET','employees')).body.items.find(x=>x.id===saved.id).substituteDraftId,null);
  await assert.rejects(pool.query('DELETE FROM payroll_calendar_substitute_applications WHERE venue_id=$1',[venueId]),{code:'55000'});
  assert.deepEqual(await history(),settled);
  const schedule = require('../staff-schedule-service');
  const attendance = require('../payroll-attendance-manifest').makePayrollAttendanceManifestService(pool);
  const period = {periodFrom:date.slice(0,7) + '-01', periodTo:date};
  await schedule.save(pool,principal,{userId:saved.id,kind:'shift',workDate:date,breakMinutes:0,requestKey:randomUUID(),
    plannedStart:date+'T10:00:00Z',plannedEnd:date+'T18:00:00Z',reason:'Calendar fixture shift'});
  await pool.query("INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,'manual')",
    [venueId,saved.id,date+'T10:00:00Z',date+'T14:00:00Z']);
  const attendanceEvidence=await attendance.readCoverage(principal,period);
  await attendance.approveCoverage(principal,{...period,reason:'Actual replacement worked half the shift',idempotencyKey:randomUUID(),
    sourceWatermark:attendanceEvidence.sourceWatermark});
  const preview=await payroll.previewWithApprovedAttendance(principal,saved.versionId,{...period,employees:[{id:worker,activeIntervals:[{from:date,to:date}]},{id:saved.id,activeIntervals:[{from:date,to:date}]}],
    sales:[],coverage:{kind:'month_to_date_complete',from:period.periodFrom,through:date,complete:true,watermark:'fixture'}});
  const details=preview.result.daily.flatMap(d=>d.employees.flatMap(e=>e.shiftDetails));
  assert.deepEqual(details.map(x=>[x.workedMinutes,x.plannedMinutes,x.amountCents]),[[240,480,12500]],JSON.stringify({blockers:preview.result.blockers,issues:preview.result.errors}));
  // Even a direct SQL caller cannot promote changed assignments through the open-ended retirement exception.
  const direct = await payroll.enrollCalendarSubstitute(principal,{...payload,name:'Another worker',requestKey:randomUUID(),
    versionId:active.versionId,digest:active.payoutRiskAcknowledgement.configDigest},allowed);
  const attack = await pool.connect();
  try {
    await attack.query('BEGIN');
    await attack.query('DELETE FROM payroll_role_assignments WHERE employee_id=$1 AND scheme_version_id=$2',[worker,direct.versionId]);
    await attack.query('INSERT INTO payroll_calendar_substitute_applications(venue_id,draft_id,prior_version_id,actor_id) VALUES($1,$2,$3,$4)',
      [venueId,direct.versionId,active.versionId,userId]);
    await attack.query("UPDATE payroll_scheme_versions SET status='retired',status_changed_at=now(),status_changed_by=$2,status_changed_by_name='Owner' WHERE id=$1",[active.versionId,userId]);
    await attack.query("UPDATE payroll_scheme_versions SET status='active',status_changed_at=now(),status_changed_by=$2,status_changed_by_name='Owner' WHERE id=$1",[direct.versionId,userId]);
    await assert.rejects(attack.query('COMMIT'), {code:'23514',message:'payroll_calendar_application_terms_changed'});
  } finally { await attack.query('ROLLBACK'); attack.release(); }
  // A calendar confirmation cannot silently promote unrelated edits to other staff rates.
  const modified = await payroll.createVersion(principal,active.id,{...active,
    roleParameters:{bar:{...active.roleParameters.bar,stableRateBps:1100}}},{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'});
  const altered = await payroll.enrollCalendarSubstitute(principal,{...payload,name:'Second worker',requestKey:randomUUID(),versionId:modified.versionId,
    digest:modified.payoutRiskAcknowledgement.configDigest},allowed);
  await assert.rejects(payroll.applyCalendarSubstitute(principal,altered.versionId),{code:'substitute_requires_salary_review'});
  assert.equal((await payroll.getVersion(principal,saved.versionId)).status,'active');
  const abusive = await pool.connect();
  try {
    for (const activate of [false,true]) {
      await abusive.query('BEGIN');
      await abusive.query('INSERT INTO payroll_calendar_substitute_applications(venue_id,draft_id,prior_version_id,actor_id) VALUES($1,$2,$3,$4)',
        [venueId,altered.versionId,saved.versionId,userId]);
      await abusive.query("UPDATE payroll_scheme_versions SET status='retired',status_changed_at=now(),status_changed_by=$2,status_changed_by_name='Owner' WHERE id=$1",[saved.versionId,userId]);
      if (activate) await abusive.query("UPDATE payroll_scheme_versions SET status='active',status_changed_at=now(),status_changed_by=$2,status_changed_by_name='Owner' WHERE id=$1",[altered.versionId,userId]);
      await assert.rejects(abusive.query('COMMIT'),{code:'23514'});
      assert.equal((await payroll.getVersion(principal,saved.versionId)).status,'active');
    }
  } finally { await abusive.query('ROLLBACK'); abusive.release(); }
  assert.deepEqual(await history(),settled);
  console.log('PASS substitute enrollment with scope, quota, rollback, concurrent replay, single-day eligibility and immutable original scheme');
} finally { await pool.end(); }
