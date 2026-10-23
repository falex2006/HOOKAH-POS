import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const require = createRequire(import.meta.url), { Client, Pool } = require('pg');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const pool = new Pool({ connectionString: target.url.href, max: 3 });
const schema = `zero_correction_qa_${randomUUID().replaceAll('-', '')}`;
const m203 = readFileSync(new URL('../migrations/203_payroll_reviewed_correction_applications.sql', import.meta.url), 'utf8');
const m206 = readFileSync(new URL('../migrations/206_payroll_zero_settlement_correction_authority.sql', import.meta.url), 'utf8');
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const insert = async (db, table, row) => { const keys = Object.keys(row); return (await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row))).rows[0]; };
const ids = Object.fromEntries(['venue','otherVenue','owner','employee','receipt','otherReceipt'].map(k => [k,randomUUID()]));
const actor = { venueId: ids.venue, userId: ids.owner }, hash = 'a'.repeat(64), sourceHash = 'b'.repeat(64);
let checks = 0, db, sourceReads = 0;
const sources = new Map(), entries = new Map();
const { beginPayrollVerifiedRunSourceTransaction } = require('../payroll-source-fence');
async function fenced(fn, failAfter = null) {
  const release = await beginPayrollVerifiedRunSourceTransaction(db, ids.venue), query = db.query.bind(db);
  if (failAfter) db.query = async (...args) => { const value = await query(...args); if (String(args[0]).startsWith(failAfter)) throw Object.assign(new Error('QA rollback'), { code: 'QA_AFTER_WRITE' }); return value; };
  try { const result = await fn(); await db.query('COMMIT'); return result; }
  catch (error) { await query('ROLLBACK'); throw error; }
  finally { db.query = query; await release(); }
}
async function reject(fn, code = '23514', contains = null) {
  await db.query('BEGIN');
  try { await assert.rejects((async () => { await fn(); await db.query('COMMIT'); })(), e => e.code === code && (!contains || e.message.includes(contains))); checks++; }
  finally { await db.query('ROLLBACK'); }
}
async function entry(month, gross, fixed = 0, paid = false) {
  const id = randomUUID(), run = randomUUID(), expense = paid ? randomUUID() : null;
  await insert(db, 'payroll_run_provenance', { venue_id: ids.venue, run_id: run });
  if (expense) await insert(db, 'expenses', { id: expense, venue_id: ids.venue, source: 'payroll', amount: gross / 100 });
  const row = await insert(db, 'payroll_entries', { id, venue_id: ids.venue, user_id: ids.employee, status: paid ? 'paid' : 'draft',
    calculation_run_id: run, calculation_provenance_sha256: hash, calculation_gross_cents: gross, amount: gross / 100, expense_id: expense,
    period_from: `2026-${month}-01`, period_to: `2026-${month}-02`,
    paid_at: paid ? '2026-02-03T00:00:00Z' : null, paid_by: paid ? ids.owner : null, payment_date: paid ? '2026-02-03' : null });
  await insert(db, 'payroll_daily_snapshots', { id: randomUUID(), venue_id: ids.venue, run_id: run, employee_id: ids.employee, base_pay: fixed / 100, final_amount: gross / 100 });
  entries.set(id, { fixed, gross }); return row;
}
async function assessment(row, amount) {
  const refund = randomUUID(), snapshot = randomUUID(), order = randomUUID(), item = randomUUID();
  await insert(db, 'payroll_daily_snapshot_lines', { id: snapshot, venue_id: ids.venue, run_id: row.calculation_run_id, employee_id: ids.employee, order_id: order, order_item_id: item });
  await insert(db, 'pos_payroll_refund_line_events', { id: refund, venue_id: ids.venue, order_id: order, order_item_id: item });
  const payload = { schemaVersion: 1, policyVersion: 'saved-run-refund-review-v1', basis: 'saved_calculation_unposted', venueId: ids.venue,
    runId: row.calculation_run_id, currency: 'RUB', provenanceSha256: hash, sourceHash, coverage: 'complete', impactCents: -amount, reasons: [],
    lines: [{ employeeId: ids.employee, refundLineEventId: refund, sourceSnapshotLineId: snapshot, salaryImpactCents: -amount, reasons: [] }], officialReady: false, payoutEligible: false };
  const saved = await insert(db, 'payroll_refund_review_assessments', { id: randomUUID(), venue_id: ids.venue, run_id: row.calculation_run_id,
    assessment_hash: sha(canonical(payload)), source_hash: sourceHash, coverage: 'complete', payload: canonical(payload) });
  sources.set(row.calculation_run_id, { payload, saved, refund, snapshot, amount }); return sources.get(row.calculation_run_id);
}
const previewInput = intent => ({ operation: intent.operation, originalEntryId: intent.originalEntryId, targetEntryId: intent.targetEntryId });
const intent = (original, targetEntry, operation, key) => ({ operation, originalEntryId: original.id, targetEntryId: targetEntry?.id || null,
  expectedPlanHash: '0'.repeat(64), reason: 'Owner reviewed zero settlement correction', idempotencyKey: key });
try {
  assertQaDatabaseIdentity((await pool.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0], target.database, Number(target.url.port));
  await pool.query(m206); await pool.query(m206); checks++;
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.payroll_correction_claims'::regclass AND conname IN ('payroll_correction_claim_settlement_fk','payroll_correction_claim_authority_xor')")).rows[0].n, 2); checks++;
  // Isolated synthetic upstreams: actual203/206 SQL, policy, command, store and
  // private transaction fence. Receipt/source proof and201 are declared seams;
  // this does NOT claim actual205 settlement, replay or POS/HTTP acceptance.
  await pool.query(`CREATE SCHEMA "${schema}"`);
  db = new Client({ connectionString: target.url.href }); await db.connect(); await db.query(`SET search_path="${schema}",public`);
  await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,venue_id uuid,full_name text,role text,is_active boolean DEFAULT true,deleted_at timestamptz,UNIQUE(venue_id,id));
    CREATE TABLE expenses(id uuid PRIMARY KEY,venue_id uuid,source text,amount numeric,UNIQUE(venue_id,id));
    CREATE TABLE payroll_run_provenance(venue_id uuid,run_id uuid,PRIMARY KEY(venue_id,run_id));
    CREATE TABLE payroll_entries(id uuid PRIMARY KEY,venue_id uuid,user_id uuid,status text,calculation_run_id uuid,calculation_provenance_sha256 char(64),calculation_gross_cents bigint,expense_id uuid,amount numeric,period_from date,period_to date,paid_at timestamptz,paid_by uuid,payment_date date,cancelled_at timestamptz,cancelled_by uuid,cancellation_reason text,UNIQUE(venue_id,id));
    CREATE TABLE payroll_daily_snapshot_lines(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,employee_id uuid,order_id uuid,order_item_id uuid,UNIQUE(venue_id,id));
    CREATE TABLE payroll_daily_snapshots(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,employee_id uuid,base_pay numeric,final_amount numeric);
    CREATE TABLE pos_payroll_refund_line_events(id uuid PRIMARY KEY,venue_id uuid,order_id uuid,order_item_id uuid);
    CREATE TABLE payroll_refund_review_assessments(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,assessment_hash char(64),source_hash char(64),coverage text,payload text,UNIQUE(venue_id,id));
    CREATE TABLE payroll_calculation_entry_transitions(id uuid PRIMARY KEY,venue_id uuid,entry_id uuid,employee_id uuid,action text,from_status text,to_status text,
      settlement_kind text,net_cents bigint,protected_fixed_cents bigint,calculation_run_id uuid,provenance_sha256 char(64),gross_cents bigint,
      created_at timestamptz,created_by uuid,payment_date date,expense_id uuid,finance_account_id uuid,finance_account_name_snapshot text,payment_method text,shift_id uuid,UNIQUE(venue_id,id));
    CREATE TABLE payroll_calculation_entry_transition_requests(id uuid PRIMARY KEY,venue_id uuid,transition_id uuid,created_by uuid);`);
  await db.query(m203); await db.query(m206); await db.query(m206); checks++;
  for (const [id, role] of [[ids.owner,'owner'],[ids.employee,'bartender']]) await insert(db,'users',{ id,venue_id:ids.venue,full_name:role==='owner'?'Owner':'Employee',role });
  const a = await entry('01',10000,0,true), b = await entry('02',10000), c = await entry('03',1000,200), d = await entry('04',2000);
  const aSource = await assessment(a,10000), bSource = await assessment(b,2000);
  const filename = fileURLToPath(new URL('../payroll-reviewed-correction-store.js',import.meta.url));
  const Module=require('node:module'), isolated=new Module(filename), localRequire=createRequire(filename);
  isolated.require = name => {
    if(name==='./payroll-calculation-entry-evidence') return { verifyPayrollCalculationEntryEvidence: async(connection,who,row) => {
      sourceReads++; assert.equal(who.venueId,row.venue_id);
      const current=(await connection.query('SELECT *,period_from::text f,period_to::text t,paid_at::text paid_text,payment_date::text date_text FROM payroll_entries WHERE id=$1',[row.id])).rows[0];
      const basis=entries.get(current.id), net=Math.round(Number(current.amount)*100);
      return { entryId:current.id,venueId:current.venue_id,employeeId:current.user_id,runId:current.calculation_run_id,origin:'calculation_run',currency:'RUB',
        evidenceHashes:{provenanceSha256:hash},periodFrom:current.f,periodTo:current.t,entryStatus:current.status,grossCents:basis.gross,netCents:net,
        protectedFixedCents:basis.fixed,eligibleVariableCents:basis.gross-basis.fixed,
        expense:current.expense_id?{id:current.expense_id,entryId:current.id,venueId:ids.venue,source:'payroll',amountCents:net}:null,
        ...(current.id===b.id&&current.status==='paid'?{settlement:{kind:'zero',transitionId:ids.receipt,venueId:ids.venue,entryId:b.id,employeeId:ids.employee,
          runId:b.calculation_run_id,provenanceSha256:hash,grossCents:10000,netCents:0,protectedFixedCents:0,incomingCorrectionCents:10000,
          paymentDate:current.date_text,paidAt:current.paid_text,paidBy:ids.owner}}:{}) };
    }};
    if(name==='./payroll-refund-review-assessment') return { collectPayrollRefundReviewAssessment:async(_db,_actor,run)=>{sourceReads++;return structuredClone(sources.get(run).payload);} };
    if(name==='./payroll-refund-review-store') return { saveRefundReviewAssessment:async(_db,_actor,payload)=>({latestAssessment:{id:sources.get(payload.runId).saved.id,assessmentHash:sha(canonical(payload))}}) };
    return localRequire(name);
  };
  isolated._compile(readFileSync(filename,'utf8'),filename); const store=isolated.exports;
  async function prepare(command) { command.expectedPlanHash=(await fenced(()=>store.previewReviewedCorrection(db,actor,previewInput(command)))).planHash;return command; }
  const incoming=await prepare(intent(a,b,'apply','zero-incoming-100'));
  const incomingResult=await fenced(()=>store.applyReviewedCorrection(db,actor,incoming));assert.equal(incomingResult.totalCents,10000);checks++;
  assert.equal((await db.query('SELECT amount::text n FROM payroll_entries WHERE id=$1',[b.id])).rows[0].n,'0.00');checks++;
  assert.equal(JSON.parse((await db.query('SELECT plan_payload FROM payroll_correction_batches WHERE id=$1',[incomingResult.batchId])).rows[0].plan_payload).policyVersion,'owner-reviewed-variable-correction-v1');checks++;
  // Synthetic upstream pay receipt only. The actual205 producer is tested in
  // its dedicated suite; these rows isolate206's alternative claim authority.
  await db.query("UPDATE payroll_entries SET status='paid',paid_at='2026-03-03T00:00:00Z',paid_by=$2,payment_date='2026-03-03' WHERE id=$1",[b.id,ids.owner]);
  const receipt={id:ids.receipt,venue_id:ids.venue,entry_id:b.id,employee_id:ids.employee,action:'pay',from_status:'approved',to_status:'paid',settlement_kind:'zero',
    net_cents:0,protected_fixed_cents:0,calculation_run_id:b.calculation_run_id,provenance_sha256:hash,gross_cents:10000,created_at:'2026-03-03T00:00:00Z',created_by:ids.owner,payment_date:'2026-03-03',expense_id:null,finance_account_id:null,finance_account_name_snapshot:null,payment_method:null,shift_id:null};
  await insert(db,'payroll_calculation_entry_transitions',receipt);
  await insert(db,'payroll_calculation_entry_transition_requests',{id:randomUUID(),venue_id:ids.venue,transition_id:ids.receipt,created_by:ids.owner});
  await insert(db,'payroll_calculation_entry_transitions',{...receipt,id:ids.otherReceipt,venue_id:ids.otherVenue});
  const zeroClaim=()=>({id:randomUUID(),venue_id:ids.venue,employee_id:ids.employee,currency:'RUB',original_entry_id:b.id,original_run_id:b.calculation_run_id,
    original_expense_id:null,original_settlement_transition_id:ids.receipt,original_provenance_sha256:hash,refund_line_event_id:bSource.refund,
    source_snapshot_line_id:bSource.snapshot,assessment_id:bSource.saved.id,assessment_hash:bSource.saved.assessment_hash,source_hash:sourceHash,
    assessed_cents:2000,created_by:ids.owner,created_by_name:'Owner'});
  for(const patch of [{original_settlement_transition_id:randomUUID()},{original_settlement_transition_id:ids.otherReceipt},
    {original_settlement_transition_id:null},{original_expense_id:a.expense_id},{original_run_id:a.calculation_run_id}])
    await reject(()=>insert(db,'payroll_correction_claims',{...zeroClaim(),...patch}));
  for(const patch of [{net_cents:1},{gross_cents:9999},{entry_id:a.id},{employee_id:ids.owner},{settlement_kind:'positive_expense'},
    {created_by:ids.employee},{payment_date:'2026-03-04'},{expense_id:a.expense_id},{finance_account_id:randomUUID()},{shift_id:randomUUID()}]) {
    await reject(async()=>{const keys=Object.keys(patch);await db.query(`UPDATE payroll_calculation_entry_transitions SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')} WHERE id=$1`,[ids.receipt,...Object.values(patch)]);await insert(db,'payroll_correction_claims',zeroClaim());});
  }
  await reject(async()=>{await db.query('DELETE FROM payroll_calculation_entry_transition_requests WHERE transition_id=$1',[ids.receipt]);await insert(db,'payroll_correction_claims',zeroClaim());},'23514','reconciliation_invalid');
  await reject(async()=>{await db.query('UPDATE payroll_entries SET amount=1 WHERE id=$1',[b.id]);await insert(db,'payroll_correction_claims',zeroClaim());},'23514','zero_settlement_invalid');
  // Probe CHECK directly using a valid positive original/receipt combination;
  // actual claim guards also reject mixed authority before reaching this CHECK.
  assert.equal((await db.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_authority_xor'")).rows[0].definition.includes('<>'),true);checks++;
  const apply=await prepare(intent(b,c,'apply','zero-own-20-partial'));
  const preview=await fenced(()=>store.previewReviewedCorrection(db,actor,previewInput(apply)));
  assert.equal(preview.applyCents,800);assert.equal(preview.residualReviewCents,1200);assert.equal(preview.originalSettlementTransitionId,ids.receipt);checks++;
  const counts=async()=>(await db.query('SELECT (SELECT count(*) FROM payroll_correction_claims)::int claims,(SELECT count(*) FROM payroll_correction_batches)::int batches,(SELECT count(*) FROM payroll_correction_events)::int events,(SELECT count(*) FROM payroll_correction_requests)::int requests,(SELECT amount FROM payroll_entries WHERE id=$1)::text amount',[c.id])).rows[0];
  const before=await counts();
  for(const stage of ['UPDATE payroll_entries SET amount=','INSERT INTO payroll_correction_requests']) {await assert.rejects(fenced(()=>store.applyReviewedCorrection(db,actor,apply),stage),{code:'QA_AFTER_WRITE'});assert.deepEqual(await counts(),before);checks++;}
  const applied=await fenced(()=>store.applyReviewedCorrection(db,actor,apply));assert.equal(applied.totalCents,800);assert.equal(applied.targetAfterCents,200);checks++;
  const savedClaim=(await db.query('SELECT * FROM payroll_correction_claims WHERE original_entry_id=$1',[b.id])).rows[0];
  assert.equal(savedClaim.original_expense_id,null);assert.equal(savedClaim.original_settlement_transition_id,ids.receipt);checks++;
  const waive=await prepare(intent(b,null,'waive','zero-own-20-waive'));
  assert.equal((await fenced(()=>store.applyReviewedCorrection(db,actor,waive))).totalCents,1200);checks++;
  const cancel={targetEntryId:c.id,expectedPlanHash:'0'.repeat(64),reason:'Cancel partial target',idempotencyKey:'zero-own-20-cancel'};
  cancel.expectedPlanHash=(await fenced(()=>store.previewReviewedCorrectionCancellation(db,actor,cancel))).planHash;
  const cancelled=await fenced(()=>store.cancelReviewedCorrectionTarget(db,actor,cancel));assert.equal(cancelled.totalCents,800);assert.equal(cancelled.cancelledHistoricalCents,200);checks++;
  const after=await counts(), reads=sourceReads;
  assert.deepEqual(await fenced(()=>store.applyReviewedCorrection(db,actor,apply)),{...applied,replayed:true});
  assert.deepEqual(await fenced(()=>store.cancelReviewedCorrectionTarget(db,actor,cancel)),{...cancelled,replayed:true});
  assert.deepEqual(await counts(),after);assert.equal(sourceReads,reads);checks++;
  const remaining=await fenced(()=>store.previewReviewedCorrection(db,actor,{operation:'waive',originalEntryId:b.id,targetEntryId:null}));assert.equal(remaining.waiveCents,800);checks++;
  const reapply=await prepare(intent(b,d,'apply','zero-own-20-reapply'));
  const reapplied=await fenced(()=>store.applyReviewedCorrection(db,actor,reapply));
  assert.equal(reapplied.totalCents,800);checks++;
  assert.equal((await fenced(()=>store.previewReviewedCorrection(db,actor,{operation:'waive',originalEntryId:a.id,targetEntryId:null}))).waiveCents,0);checks++;
  const unchanged=(await db.query('SELECT status,amount::text,expense_id FROM payroll_entries WHERE id=$1',[b.id])).rows[0];
  assert.deepEqual(unchanged,{status:'paid',amount:'0.00',expense_id:null});checks++;
  assert.equal((await db.query('SELECT count(*)::int n FROM expenses')).rows[0].n,1);checks++;
  assert.equal((await db.query("SELECT sum(e.amount_cents)::text n FROM payroll_correction_events e JOIN payroll_correction_claims c ON c.id=e.claim_id WHERE c.original_entry_id=$1 AND e.target_entry_id=$2",[a.id,b.id])).rows[0].n,'10000');checks++;
  await db.query(m206);checks++;
  console.log(`PASS zero settlement correction PostgreSQL QA (${checks} checks; actual203/206 guards + policy/store/fence; synthetic upstream205 receipt/evidence/201 seams; NOT real POS/payment/HTTP acceptance)`);
} finally {
  if(db){try{await db.query('ROLLBACK');}catch{}await db.end();}await pool.end();
}
