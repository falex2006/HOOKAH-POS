import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
import { verifySavedRunBrowser } from './payroll-saved-run-browser-helper.mjs';
import { seedCorrectionTargetSources } from './payroll-correction-target-source-fixture.mjs';
import { verifyRefundAwareStorageGuards } from './payroll-refund-aware-storage-guards.mjs';
import { verifyUnpaidSupersession } from './payroll-unpaid-supersession-postgres-helper.mjs';
import { verifyRefundAwarePaidCorrections } from './payroll-refund-aware-correction-postgres-helper.mjs';
import { verifyRefundAwareAllModesSources } from './payroll-refund-aware-all-modes-postgres-helper.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { makeService } = require('../payroll-scheme-service');
const { beginPayrollSourceProducerTransaction, beginPayrollVerifiedRunSourceTransaction } = require('../payroll-source-fence');
const { readPayrollRefundEarningsSourceInTransaction } = require('../payroll-refund-earnings-source');
const { buildSavedPayrollRefundRecalculationBasis } = require('../payroll-refund-recalculation-basis');
const { buildPayrollRefundCounterfactual } = require('../payroll-refund-counterfactual');
const { rebuildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const { loadSavedRunEvidenceInTransaction } = require('../payroll-saved-run-reader');
const { normalizePayrollSourcePolicies } = require('../payroll-source-policies');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const seed = new Client({ connectionString: target.url.href });
const pool = new Pool({ connectionString: target.url.href, max: 5 });
const ids = Object.fromEntries(['org', 'venue', 'owner', 'employee', 'zeroEmployee', 'product', 'order', 'item', 'zeroItem', 'pricing', 'payment', 'account'].map(k => [k, randomUUID()]));
const clockSchema = `payroll_seed_clock_${randomUUID().replaceAll('-', '')}`;
const owner = { venueId: ids.venue, userId: ids.owner };
let seedClosed = false;
const policy = { schemaVersion: 1, selectionReason: 'Owner confirms immutable recognized seller and net line value',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
try {
  await seed.connect();
  assertQaDatabaseIdentity((await seed.query(`SELECT current_database() database,inet_server_addr() address,
    inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser`)).rows[0],
  target.database, Number(target.url.port));
  const period = (await seed.query(`SELECT (date_trunc('month',CURRENT_DATE)-interval '1 month')::date::text AS "from",
    (date_trunc('month',CURRENT_DATE)-interval '1 day')::date::text AS "to"`)).rows[0];
  // The seed session alone controls historical time. Real immutable producer
  // triggers run unchanged; the service later uses a separate pool and real time.
  // This proves historical-source integration, not a real-time POS HTTP journey.
  await seed.query(`CREATE SCHEMA "${clockSchema}"`);
  await seed.query(`CREATE FUNCTION "${clockSchema}".transaction_timestamp() RETURNS timestamptz
    LANGUAGE sql STABLE AS $$ SELECT current_setting('qa.payroll_seed_clock')::timestamptz $$`);
  await seed.query('BEGIN');
  await seed.query(`SET LOCAL search_path="${clockSchema}",public,pg_catalog`);
  await seed.query("SELECT set_config('qa.payroll_seed_clock',$1,true)", [`${period.from}T12:00:00Z`]);
  assert.equal((await seed.query('SELECT transaction_timestamp() < pg_catalog.transaction_timestamp() AS historical')).rows[0].historical, true);
  await seed.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Verified run QA',$2,'network')", [ids.org, `verified-${ids.org}`]);
  await seed.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Verified run QA','UTC')", [ids.venue, ids.org]);
  for (const role of ['owner', 'employee', 'zeroEmployee']) {
    await seed.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role)
      VALUES($1,$2,$3,$4,$5,$6)`, [ids[role], ids.venue, ids.org, `Verified ${role}`, `verified-${ids[role]}`, role === 'owner' ? 'owner' : 'bartender']);
    await seed.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status)
      VALUES($1,$2,$3,'active')`, [ids.org, ids[role], role === 'owner' ? 'owner' : 'member']);
  }
  await seed.query(`INSERT INTO products(id,venue_id,name,category,sale_price,inventory_mode)
    VALUES($1,$2,'Historical tea','bar',100,'non_stock')`, [ids.product, ids.venue]);
  await seed.query(`INSERT INTO orders(id,venue_id,opened_by,status,created_at)
    VALUES($1,$2,$3,'open',transaction_timestamp())`, [ids.order, ids.venue, ids.owner]);
  await seed.query(`INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
    VALUES($1,$2,$3,1,100,'bar',$4,transaction_timestamp())`, [ids.item, ids.order, ids.product, ids.employee]);
  await seed.query(`INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
    VALUES($1,$2,$3,1,0,'bar',$4,transaction_timestamp())`, [ids.zeroItem, ids.order, ids.product, ids.zeroEmployee]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshots(id,venue_id,order_id,sold_at,transaction_at,
    subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source,winner_source_ids,
    eligible_item_ids,winner_terms,frozen_terms)
    VALUES($1,$2,$3,transaction_timestamp(),transaction_timestamp(),10000,0,0,10000,'none','{}','{}','{}',$4)`,
  [ids.pricing, ids.venue, ids.order, JSON.stringify({ allocationPolicy: 'largest-remainder-item-id-v1',
    offers: [], inputs: { approvedDiscounts: [], promotions: [] }, minimumAdjustment: 0 })]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,
    sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
    VALUES($1,$2,$3,$4,$5,transaction_timestamp(),1,100,10000,0,10000,false,$6)`,
  [ids.venue, ids.pricing, ids.order, ids.item, ids.employee,
    JSON.stringify({ productId: ids.product, productName: 'Historical tea', category: 'bar', station: 'bar', productActive: true })]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,
    sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
    VALUES($1,$2,$3,$4,$5,transaction_timestamp(),1,0,0,0,0,false,$6)`,
  [ids.venue, ids.pricing, ids.order, ids.zeroItem, ids.zeroEmployee,
    JSON.stringify({ productId: ids.product, productName: 'Historical tea', category: 'bar', station: 'bar', productActive: true })]);
  await seed.query(`INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by)
    VALUES($1,$2,'freshness_bank','Freshness QA bank','bank',ARRAY['card']::text[],$3)`, [ids.account, ids.venue, ids.owner]);
  await seed.query(`INSERT INTO payments(id,order_id,method,amount,status,created_at,finance_account_id,finance_account_name_snapshot)
    VALUES($1,$2,'card',100,'paid',transaction_timestamp(),$3,'Freshness QA bank')`, [ids.payment, ids.order, ids.account]);
  await seed.query(`UPDATE orders SET pricing_locked_at=transaction_timestamp(),pricing_version=1,
    subtotal_snapshot=100,discount_total_snapshot=0,minimum_adjustment_snapshot=0,final_total_snapshot=100,
    closed_at=transaction_timestamp(),status='closed' WHERE id=$1`, [ids.order]);
  const correctionTarget = await seedCorrectionTargetSources(seed, { ids, period, clockSchema });
  await seed.query('COMMIT');
  const recognized = (await seed.query(`SELECT e.coverage_status,e.coverage_reasons,e.recognized_local_date::text,
    e.recognized_at=e.source_closed_at AS close_bound,count(l.id)::int AS line_count
    FROM pos_payroll_sale_events e JOIN pos_payroll_sale_line_events l ON l.sale_event_id=e.id
    WHERE e.venue_id=$1 AND e.order_id=$2 GROUP BY e.id`, [ids.venue, ids.order])).rows[0];
  assert.deepEqual(recognized, { coverage_status: 'complete', coverage_reasons: [],
    recognized_local_date: period.from, close_bound: true, line_count: 2 });
  await seed.query(`DROP SCHEMA "${clockSchema}" CASCADE`);
  await seed.end(); seedClosed = true;
  assert.equal((await pool.query('SELECT transaction_timestamp()=pg_catalog.transaction_timestamp() AS real_clock')).rows[0].real_clock, true);
  assert.equal((await pool.query('SHOW search_path')).rows[0].search_path.includes(clockSchema), false);
  const service = makeService(pool);
  await service.createEmploymentEligibilityRevision(owner, { expectedRevisionId: null, reason: 'Owner confirms full historical employee eligibility',
    idempotencyKey: 'verified-history-eligibility', periods: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, effectiveFrom: period.from, effectiveTo: correctionTarget.eligibilityTo })) });
  const created = await service.createScheme(owner, { name: 'Verified historical 10 percent',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'percent_only', currency: 'RUB', effectiveFrom: period.from, effectiveTo: period.to,
      applyMilestones: false, roleParameters: { bar: { stableRateBps: 1000 } },
      roleAssignments: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: period.to })),
      employeeOverrides: [], itemRules: [], sourcePolicies: policy } });
  const versionId = created.versions[0].versionId;
  await service.activateVersion(owner, versionId);
  const input = { schemeVersionId: versionId, periodFrom: period.from, periodTo: period.to, idempotencyKey: 'verified-historical-run' };
  const financialCounts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) entries,
    (SELECT count(*)::int FROM expenses WHERE venue_id=$1) expenses`, [ids.venue])).rows[0];
  const countsBefore = await financialCounts();
  const run = await service.createVerifiedRun(owner, input);
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal(run.amountCents, 1000);
  assert.equal(run.replayed, false);
  assert.equal(run.payoutEligible, false);
  const stored = (await pool.query(`SELECT r.status,r.engine_version,p.total_amount_cents::text,p.evidence_payload,
    (SELECT count(*)::int FROM payroll_daily_snapshot_lines l WHERE l.venue_id=r.venue_id AND l.run_id=r.id) line_count,
    (SELECT sum(final_amount)::text FROM payroll_daily_snapshots d WHERE d.venue_id=r.venue_id AND d.run_id=r.id) total
    FROM payroll_calculation_runs r JOIN payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id
    WHERE r.venue_id=$1 AND r.id=$2`, [ids.venue, run.runId])).rows[0];
  assert.equal(stored.status, 'ready'); assert.equal(stored.total_amount_cents, '1000');
  assert.equal(stored.line_count, 2); assert.equal(Number(stored.total), 10);
  const evidence = JSON.parse(stored.evidence_payload);
  assert.ok(evidence.periodClosure.venueLocalDate > period.to, 'real service clock proves the period ended');
  const freshness = await service.checkSavedRunFreshness(owner, run.runId);
  assert.equal(freshness.status, 'current', JSON.stringify(freshness));
  assert.equal(freshness.sourceChanged, false);
  assert.equal(freshness.payoutEligible, false);
  assert.equal(freshness.officialReady, false);
  assert.equal(freshness.persistence, 'none');
  assert.equal(freshness.validity, 'transaction_snapshot_only');
  assert.deepEqual(freshness.changedFacts, []);
  assert.equal(Object.hasOwn(freshness, 'evidence'), false);
  const checkedAgain = await service.checkSavedRunFreshness(owner, run.runId);
  assert.equal(checkedAgain.status, 'current');
  assert.notEqual(checkedAgain.checkedAt, freshness.checkedAt, 'a new closure timestamp is not a source change');
  await assert.rejects(pool.query("UPDATE payroll_schemes SET name='Renamed live scheme' WHERE venue_id=$1 AND id=$2",
    [ids.venue, evidence.schemeSnapshot.id]), error => error.code === '55000', 'stored scheme name is protected by history trigger');
  assert.equal((await service.checkSavedRunFreshness(owner, run.runId)).status, 'current');
  const replay = await service.createVerifiedRun(owner, input);
  assert.deepEqual(replay, { ...run, replayed: true });
  await assert.rejects(() => service.createVerifiedRun(owner, { ...input, periodTo: period.from }),
    error => error.code === 'payroll_run_idempotency_conflict');
  // Simultaneous identical requests are serialized before their source snapshots.
  const concurrentInput = { ...input, idempotencyKey: 'verified-concurrent-run' };
  const both = await Promise.all([service.createVerifiedRun(owner, concurrentInput), service.createVerifiedRun(owner, concurrentInput)]);
  assert.equal(both[0].runId, both[1].runId);
  assert.deepEqual(both.map(result => result.replayed).sort(), [false, true]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payroll_calculation_runs WHERE venue_id=$1', [ids.venue])).rows[0].n, 2);
  const snapshotCounts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) runs,
    (SELECT count(*)::int FROM payroll_run_provenance WHERE venue_id=$1) provenance,
    (SELECT count(*)::int FROM payroll_daily_snapshots WHERE venue_id=$1) days,
    (SELECT count(*)::int FROM payroll_daily_snapshot_lines WHERE venue_id=$1) lines`, [ids.venue])).rows[0];
  for (const failedTable of ['payroll_run_provenance', 'payroll_daily_snapshot_lines']) {
    const beforeFailure = await snapshotCounts();
    let injected = false;
    const failingService = makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (!injected && String(sql).startsWith(`INSERT INTO ${failedTable} (`)) {
          injected = true;
          await client.query('SELECT 1/0'); // Real transaction failure after actual writes.
        }
        return result;
      }, release: error => client.release(error) };
    } });
    await assert.rejects(() => failingService.createVerifiedRun(owner, {
      ...input, idempotencyKey: `verified-fault-${failedTable}`
    }), error => error.code === '22012');
    assert.equal(injected, true);
    assert.deepEqual(await snapshotCounts(), beforeFailure, 'service rollback removes the entire attempted run');
  }
  // A producer is already active when a new run is requested. Commit a real
  // owner eligibility revision before releasing that producer; the run must
  // start its RR snapshot afterwards and bind the new source revision.
  const history = await service.getEmploymentEligibilityHistory(owner);
  let releaseProducerCommit, producerCommitReached;
  const producerCanCommit = new Promise(resolve => { releaseProducerCommit = resolve; });
  const producerAtCommit = new Promise(resolve => { producerCommitReached = resolve; });
  const producerService = makeService({ query: (...args) => pool.query(...args), connect: async () => {
    const client = await pool.connect();
    return { query: async (sql, values) => {
      if (sql === 'COMMIT') { producerCommitReached(); await producerCanCommit; }
      return client.query(sql, values);
    }, release: error => client.release(error) };
  } });
  const revisionPromise = producerService.createEmploymentEligibilityRevision(owner, { expectedRevisionId: history.current.id,
    reason: 'Owner reconfirms historical employee eligibility during producer transaction',
    idempotencyKey: 'verified-history-revision-two',
    periods: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, effectiveFrom: period.from, effectiveTo: correctionTarget.eligibilityTo })) });
  let waitingRun, waitingFreshness;
  try {
    await Promise.race([producerAtCommit, revisionPromise.then(() => { throw new Error('producer commit gate missed'); })]);
    let settled = false;
    waitingRun = service.createVerifiedRun(owner, { ...input, idempotencyKey: 'verified-after-producer' })
      .then(value => { settled = true; return value; });
    let freshnessSettled = false;
    waitingFreshness = service.checkSavedRunFreshness(owner, run.runId).then(value => { freshnessSettled = true; return value; });
    const deadline = Date.now() + 10000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted
        AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
        AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1) AS waiting`,
      [`payroll-official-source-v1:${ids.venue}`])).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'run waits for the active source producer before creating its snapshot');
    assert.equal(settled, false);
    assert.equal(freshnessSettled, false, 'freshness also waits for the in-flight producer');
    releaseProducerCommit();
    const revised = await revisionPromise;
    const afterProducer = await waitingRun;
    assert.equal(afterProducer.status, 'ready', JSON.stringify(afterProducer));
    assert.equal(afterProducer.amountCents, 1000);
    const afterFreshness = await waitingFreshness;
    assert.equal(afterFreshness.status, 'stale', JSON.stringify(afterFreshness));
    assert.equal(afterFreshness.sourceChanged, true, 'same amounts under a new confirmation still change source evidence');
    assert.ok(afterFreshness.changedFacts.includes('employeeEligibility'));
    assert.equal((await service.checkSavedRunFreshness(owner, afterProducer.runId)).status, 'current');
    const hashes = (await pool.query(`SELECT id,input_watermark FROM payroll_calculation_runs
      WHERE venue_id=$1 AND id=ANY($2::uuid[])`, [ids.venue, [run.runId, afterProducer.runId]])).rows;
    assert.notEqual(hashes[0].input_watermark, hashes[1].input_watermark, 'new revision changes the source watermark');
    const afterEvidence = JSON.parse((await pool.query('SELECT evidence_payload FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
      [ids.venue, afterProducer.runId])).rows[0].evidence_payload);
    assert.equal(afterEvidence.sourceEvidence.employeeEligibility.sourceWatermark, revised.sourceWatermark,
      'run provenance binds the committed eligibility revision watermark');
    assert.deepEqual(await service.createVerifiedRun(owner, input), { ...run, replayed: true },
      'same key replays the immutable original after source changes');
  } finally {
    releaseProducerCommit();
    await revisionPromise.catch(() => {});
    if (waitingRun) await waitingRun.catch(() => {});
    if (waitingFreshness) await waitingFreshness.catch(() => {});
  }
  assert.deepEqual(await financialCounts(), countsBefore, 'snapshot creation and replay never materialize entries or expenses');
  const savedList = await service.listSavedRuns(owner, { limit: '1', schemeVersionId: versionId });
  assert.equal(savedList.items.length, 1); assert.ok(savedList.nextCursor);
  const nextList = await service.listSavedRuns(owner, { limit: '1', schemeVersionId: versionId, cursor: savedList.nextCursor });
  assert.equal(nextList.items.length, 1); assert.notEqual(nextList.items[0].runId, savedList.items[0].runId);
  const savedDetail = await service.getSavedRun(owner, run.runId);
  assert.equal(savedDetail.state, 'saved'); assert.equal(savedDetail.amountCents, 1000);
  assert.equal(savedDetail.employees.find(row => row.employeeId === ids.employee).employeeName, 'Verified employee');
  assert.equal(savedDetail.replayAvailable, true);
  assert.equal(savedDetail.replay.replayVerified, false, 'reading checks integrity, not execution');
  const replayCheck = await service.replaySavedRun(owner, run.runId);
  assert.equal(replayCheck.verification.status, 'matched');
  assert.equal(replayCheck.verification.replayVerified, true);
  assert.equal(replayCheck.officialReady, false);
  assert.equal(replayCheck.payoutEligible, false);
  assert.equal(Object.hasOwn(replayCheck.verification, 'result'), false, 'raw result stays server-side');
  assert.deepEqual(await financialCounts(), countsBefore, 'replay creates no financial records');
  const savedEmployee = await service.getSavedRunEmployee(owner, run.runId, ids.employee);
  assert.equal(savedEmployee.amountCents, 1000);
  const saleDay = savedEmployee.days.find(day => day.amountCents === 1000);
  assert.ok(saleDay);
  const savedLines = await service.getSavedRunLines(owner, run.runId, saleDay.snapshotId);
  assert.equal(savedLines.items.length, 1);
  assert.equal(savedLines.items[0].menuItemName, 'Historical tea');
  assert.equal(savedLines.items[0].commissionBaseCents, 10000);
  assert.equal(savedLines.items[0].commissionCents, 1000);
  await assert.rejects(service.getSavedRun({ ...owner, userId: ids.employee }, run.runId), error => error.status === 403);
  await assert.rejects(service.getSavedRun(owner, randomUUID()), error => error.status === 404);
  await assert.rejects(service.getSavedRunEmployee(owner, run.runId, ids.owner), error => error.status === 404);
  await assert.rejects(service.getSavedRunLines(owner, run.runId, randomUUID()), error => error.status === 404);
  await pool.query("UPDATE users SET full_name='Renamed current employee' WHERE id=$1", [ids.employee]);
  await pool.query("UPDATE products SET name='Renamed current product' WHERE id=$1", [ids.product]);
  assert.deepEqual(await service.getSavedRun(owner, run.runId), savedDetail, 'saved employee labels remain historical');
  assert.deepEqual(await service.getSavedRunLines(owner, run.runId, saleDay.snapshotId), savedLines, 'saved product labels remain historical');
  assert.deepEqual(await service.replaySavedRun(owner, run.runId), replayCheck, 'replay ignores current source names');
  await assert.rejects(service.replaySavedRun({ ...owner, userId: ids.employee }, run.runId), error => error.status === 403);
  await assert.rejects(service.replaySavedRun(owner, randomUUID()), error => error.status === 404);
  await assert.rejects(service.checkSavedRunFreshness({ ...owner, userId: ids.employee }, run.runId), error => error.status === 403);
  await assert.rejects(service.checkSavedRunFreshness(owner, randomUUID()), error => error.status === 404);
  const reviewCounts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM payroll_refund_review_cases WHERE venue_id=$1) cases,
    (SELECT count(*)::int FROM payroll_refund_review_assessments WHERE venue_id=$1) assessments,
    (SELECT count(*)::int FROM payroll_refund_review_decisions WHERE venue_id=$1) decisions,
    (SELECT count(*)::int FROM payroll_refund_review_requests WHERE venue_id=$1) requests`, [ids.venue])).rows[0];
  const failingReviewService = failedTable => {
    let injected = false;
    return { service: makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (!injected && String(sql).startsWith(`INSERT INTO ${failedTable}`)) {
          injected = true; await client.query('SELECT 1/0');
        }
        return result;
      }, release: error => client.release(error) };
    } }), injected: () => injected };
  };
  for (const table of ['payroll_refund_review_cases', 'payroll_refund_review_assessments', 'payroll_refund_review_requests']) {
    const before = await reviewCounts(), failing = failingReviewService(table);
    await assert.rejects(failing.service.createRefundReview(owner, run.runId, { idempotencyKey: `fault-${table}` }), error => error.code === '22012');
    assert.equal(failing.injected(), true); assert.deepEqual(await reviewCounts(), before, 'review writes roll back together');
  }
  const firstReview = await service.createRefundReview(owner, run.runId, { idempotencyKey: 'refund-review-before-return' });
  assert.equal(firstReview.latestAssessment.payload.coverage, 'complete', JSON.stringify(firstReview.latestAssessment.payload.reasons));
  assert.equal(firstReview.latestAssessment.payload.impactCents, 0);
  assert.equal(firstReview.latestAssessment.payload.lines.length, 0);
  const zeroDecisionInput = { decision: 'acknowledge_no_effect', reason: 'No related returns at inspection',
    expectedAssessmentHash: firstReview.latestAssessment.assessmentHash, idempotencyKey: 'refund-review-zero-decision' };
  for (const table of ['payroll_refund_review_decisions', 'payroll_refund_review_requests']) {
    const before = await reviewCounts(), failing = failingReviewService(table);
    await assert.rejects(failing.service.decideRefundReview(owner, firstReview.caseId, { ...zeroDecisionInput, idempotencyKey: `fault-${table}` }),
      error => error.code === '22012');
    assert.equal(failing.injected(), true); assert.deepEqual(await reviewCounts(), before, 'decision and replay journal roll back together');
  }
  const zeroDecision = await service.decideRefundReview(owner, firstReview.caseId, zeroDecisionInput);
  assert.equal(zeroDecision.status, 'acknowledge_no_effect');
  const sameSourceReviews = await Promise.all(['refund-review-parallel-one','refund-review-parallel-two'].map(idempotencyKey =>
    service.createRefundReview(owner, run.runId, { idempotencyKey })));
  assert.ok(sameSourceReviews.every(row => row.caseId === firstReview.caseId && row.assessments.length === 1));
  for (const action of [
    () => service.createRefundReview({ ...owner, userId: ids.employee }, run.runId, { idempotencyKey: 'refund-review-denied' }),
    () => service.getRefundReview({ ...owner, userId: ids.employee }, firstReview.caseId),
    () => service.decideRefundReview({ ...owner, userId: ids.employee }, firstReview.caseId, zeroDecisionInput)
  ]) await assert.rejects(action, error => error.status === 403);
  await service.writeProductDepartmentRevision(owner, { expectedRevisionId: null, idempotencyKey: 'review-historical-department',
    reason: 'Owner confirms department for capped review example', effectiveFrom: period.from,
    retroactiveReason: 'Historical department confirmed for the synthetic sale',
    ownerAttestation: { confirmed: true, action: 'retroactive_payroll_product_department_mapping' },
    mappings: [{ productId: ids.product, productName: 'Historical tea', departmentCode: 'bar', departmentName: 'Бар',
      effectiveFrom: period.from, effectiveTo: null }] }, true);
  const cappedScheme = await service.createScheme(owner, { name: 'Review unsupported cap example',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'percent_only', currency: 'RUB', effectiveFrom: period.from, effectiveTo: period.to,
      applyMilestones: false, roleParameters: { bar: { stableRateBps: 1000, cap: { basis: 'employee_department_day', department: 'bar', rateBps: 500 } } },
      roleAssignments: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: period.to })),
      employeeOverrides: [], itemRules: [], sourcePolicies: policy } });
  await service.activateVersion(owner, cappedScheme.versions[0].versionId);
  const cappedRun = await service.createVerifiedRun(owner, { ...input, schemeVersionId: cappedScheme.versions[0].versionId, idempotencyKey: 'capped-review-original-run' });
  assert.equal(cappedRun.status, 'ready', JSON.stringify(cappedRun));
  const targetScheme = await service.createScheme(owner, { name: 'Correction target five percent',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'percent_only', currency: 'RUB', effectiveFrom: correctionTarget.nextPeriod.from, effectiveTo: correctionTarget.schemeTo,
      applyMilestones: false, roleParameters: { bar: { stableRateBps: 500 } },
      roleAssignments: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, roleId: 'bar', effectiveFrom: correctionTarget.nextPeriod.from, effectiveTo: correctionTarget.schemeTo })),
      employeeOverrides: [], itemRules: [], sourcePolicies: policy } });
  correctionTarget.versionId = targetScheme.versions[0].versionId;
  await service.activateVersion(owner, correctionTarget.versionId);
  const refundPolicyV2 = normalizePayrollSourcePolicies({ ...policy, schemaVersion: 2,
    selectionReason: 'Owner explicitly selects remaining merchandise earnings and frozen depletion incentive cost',
    earnings: { refunds: 'remaining_merchandise_original_sale_date_v1',
      venueTurnover: 'canonical_total_less_merchandise_returns_v1', marginCost: 'frozen_sale_depletion_cost_payroll_v1' } });
  const v2Definition = { mode: 'percent_only', currency: 'RUB', effectiveFrom: period.from, effectiveTo: period.to,
    applyMilestones: false, roleParameters: { bar: { stableRateBps: 1000 } },
    roleAssignments: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: period.to })),
    employeeOverrides: [], itemRules: [], sourcePolicies: refundPolicyV2 };
  const policyVersion = (await service.createScheme(owner, { name: 'Explicit refund policy v2', definition: v2Definition,
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' } })).versions[0];
  assert.deepEqual(policyVersion.sourcePolicies, refundPolicyV2);
  assert.deepEqual((await service.getVersion(owner, policyVersion.versionId)).sourcePolicies, refundPolicyV2);
  assert.deepEqual((await service.listVersionRevisions(owner, policyVersion.versionId))[0].snapshot.sourcePolicies, refundPolicyV2);
  await service.activateVersion(owner, policyVersion.versionId);
  await assert.rejects(service.replaceDraftVersion(owner, policyVersion.versionId, v2Definition,
    { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' }), error => error.code === 'payroll_scheme_version_immutable');
  const v2Blocked = await service.createVerifiedRun(owner, { schemeVersionId: policyVersion.versionId,
    periodFrom: period.from, periodTo: period.to, idempotencyKey: 'new-source-policy-no-legacy-gate' });
  assert.equal(v2Blocked.status, 'blocked');
  assert.ok(v2Blocked.reasons.includes('payroll_refund_policy_requires_versioned_input'), JSON.stringify(v2Blocked));
  console.log('PASS source policy v2 actual owner persistence/revision/activation: explicit immutable choice, legacy monetary capability still blocked');
  const prepareV2 = () => service.prepareRefundAwareCalculation(owner, policyVersion.versionId,
    { periodFrom: period.from, periodTo: period.to });
  const sourceV2Before = await prepareV2();
  assert.equal(sourceV2Before.status, 'refund_aware_calculated', JSON.stringify(sourceV2Before.reasons));
  assert.equal(sourceV2Before.amountCents, 1000);
  assert.equal(sourceV2Before.persistence, 'none');
  assert.equal(sourceV2Before.sourceAttested, false);
  const prepareV2Evidence = async () => {
    const result = await service.prepareRefundAwareRunEvidence(owner, policyVersion.versionId,
      { periodFrom: period.from, periodTo: period.to });
    assert.equal(result.status, 'verified_run_evidence', JSON.stringify(result.reasons));
    const payload = JSON.parse(result.provenance.evidence_payload);
    const rebuilt = rebuildPayrollRefundAwareRunProvenance(payload);
    assert.equal(rebuilt.provenance.evidence_sha256, result.provenance.evidence_sha256);
    assert.equal(result.prepared.snapshotInput.sourceLines.length, 2);
    assert.ok(result.prepared.snapshotInput.sourceLines.every(line => line.quantity === '1.000'));
    return result;
  };
  const v2EvidenceBefore = await prepareV2Evidence();
  assert.equal(v2EvidenceBefore.provenance.total_amount_cents, 1000);
  const v2RunRequest = { schemeVersionId: policyVersion.versionId, periodFrom: period.from, periodTo: period.to,
    idempotencyKey: 'v2-initial-stored-run' };
  const financesBeforeV2 = await financialCounts();
  const v2Parallel = await Promise.all([service.createRefundAwareRun(owner, v2RunRequest), service.createRefundAwareRun(owner, v2RunRequest)]);
  assert.equal(v2Parallel[0].status, 'ready', JSON.stringify(v2Parallel));
  assert.equal(v2Parallel[0].runId, v2Parallel[1].runId);
  assert.deepEqual(v2Parallel.map(row => row.replayed).sort(), [false, true]);
  assert.equal(v2Parallel[0].amountCents, 1000);
  assert.deepEqual(await financialCounts(), financesBeforeV2, 'v2 snapshots never implicitly create entries or expenses');
  assert.equal((await verifyRefundAwareStorageGuards({ pool, venueId: ids.venue, runId: v2Parallel[0].runId })).status, 'passed');
  const v2StoredDetail = await service.getSavedRun(owner, v2Parallel[0].runId);
  assert.equal(v2StoredDetail.amountCents, 1000);
  assert.equal(v2StoredDetail.capabilityVersion, 'employee_attributed_remaining_net_refund_v2');
  assert.equal((await service.listSavedRuns(owner, { schemeVersionId: policyVersion.versionId })).items[0].runId, v2Parallel[0].runId);
  assert.equal((await service.replaySavedRun(owner, v2Parallel[0].runId)).verification.status, 'matched');
  const v2Employee = await service.getSavedRunEmployee(owner, v2Parallel[0].runId, ids.employee);
  const v2Day = v2Employee.days.find(day => day.amountCents > 0);
  assert.ok(v2Day);
  const v2Lines = await service.getSavedRunLines(owner, v2Parallel[0].runId, v2Day.snapshotId);
  assert.ok(v2Lines.items.length > 0);
  assert.equal(/sourceBundle|recognitionEvidence|refundQuantityEvidence/.test(JSON.stringify([v2StoredDetail, v2Employee, v2Lines])), false);
  assert.equal((await service.checkSavedRunFreshness(owner, v2Parallel[0].runId)).status, 'current');
  await assert.rejects(service.checkSavedRunFreshness({ ...owner, userId: ids.employee }, v2Parallel[0].runId), error => error.status === 403);
  assert.deepEqual(await financialCounts(), financesBeforeV2, 'v2 inspection is read only');
  if(process.env.PAYROLL_QA_SCOPE==='comparison_v2') {
    const comparisonAcceptance = await verifyRefundAwareAllModesSources({ pool, target, sourcePolicies: refundPolicyV2 });
    assert.equal(comparisonAcceptance.runCount, 21);
    assert.equal(comparisonAcceptance.paidEntryCount, 14);
    assert.equal(comparisonAcceptance.results[0].comparison.status, 'passed');
  } else if(process.env.PAYROLL_QA_SCOPE==='public_v2') {
    await verifySavedRunBrowser({pool,target,ids,period,versionId,runId:run.runId,
      supersessionSourcePolicies:refundPolicyV2,publicV2Only:true});
  } else {
  assert.equal(process.env.PAYROLL_QA_SCOPE,undefined,'unsupported QA scope');
  await verifyUnpaidSupersession({ pool, period, sourcePolicies: refundPolicyV2 });
  await verifyRefundAwarePaidCorrections({ pool, sourcePolicies: refundPolicyV2 });
  const allModesAcceptance = await verifyRefundAwareAllModesSources({ pool, target, sourcePolicies: refundPolicyV2 });
  assert.equal(allModesAcceptance.runCount, 21);
  assert.equal(allModesAcceptance.paidEntryCount, 14);
  assert.equal(allModesAcceptance.paidAssessmentCoverage, true);
  console.log('PASS actual all seven refund-aware modes: 21 initial/partial/full saved runs and replays, 14 genuine paid entries, whole-period colleague deltas, original expense/receipt/source immutability; no automatic correction');
  await assert.rejects(service.createRefundAwareRun(owner, { ...v2RunRequest, schemeVersionId: versionId }),
    error => error.code === 'payroll_run_idempotency_conflict');
  for (const failedTable of ['payroll_run_provenance', 'payroll_daily_snapshot_lines']) {
    const counts = await snapshotCounts(); let injected = false;
    const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const client = await pool.connect(); return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (!injected && String(sql).startsWith(`INSERT INTO ${failedTable} (`)) { injected = true; await client.query('SELECT 1/0'); }
        return result;
      }, release: error => client.release(error) };
    } });
    await assert.rejects(failing.createRefundAwareRun(owner, { ...v2RunRequest, idempotencyKey: `v2-fault-${failedTable}` }), error => error.code === '22012');
    assert.equal(injected, true); assert.deepEqual(await snapshotCounts(), counts);
  }
  await assert.rejects(service.prepareRefundAwareCalculation({ ...owner, userId: ids.employee }, policyVersion.versionId,
    { periodFrom: period.from, periodTo: period.to }), error => error.status === 403);
  await assert.rejects(service.prepareRefundAwareCalculation(owner, policyVersion.versionId,
    { periodFrom: period.from, periodTo: period.to, source: {} }), error => error.code === 'payroll_refund_aware_request_invalid');
  assert.equal((await service.prepareRefundAwareCalculation(owner, versionId,
    { periodFrom: period.from, periodTo: period.to })).status, 'blocked', 'v1 never silently upgrades economics');
  const readRefundProjection = async () => {
    const db = await pool.connect(); let release;
    try {
      release = await beginPayrollVerifiedRunSourceTransaction(db, ids.venue);
      const projection = await readPayrollRefundEarningsSourceInTransaction(db,
        { venueId: ids.venue, currency: 'RUB', from: period.from, to: period.to });
      const saved = await loadSavedRunEvidenceInTransaction(db, ids.venue, run.runId);
      const provenance = (await db.query('SELECT evidence_sha256 FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
        [ids.venue, run.runId])).rows[0];
      const basis = buildSavedPayrollRefundRecalculationBasis({ ...saved, provenanceSha256: provenance.evidence_sha256, projection });
      assert.equal(basis.savedRunBinding.runId, run.runId);
      assert.equal(basis.sourceAttested, false, 'pure basis does not grant source authority or payout eligibility');
      assert.equal(basis.saleLines.length, 2, 'saved source zero lines remain present');
      assert.equal(basis.saleLines.reduce((sum, line) => sum + line.remainingNetCents, 0),
        projection.saleLines.filter(line => line.inEarningPeriod).reduce((sum, line) => sum + line.remainingNetCents, 0));
      assert.equal(JSON.stringify(saved.evidence), JSON.stringify(evidence), 'basis preserves historical stored evidence');
      const counterfactual = buildPayrollRefundCounterfactual({ ...saved, provenanceSha256: provenance.evidence_sha256, projection,
        economicInputs: { schemaVersion: 1, basisWatermark: basis.basisWatermark, venueTurnover: null, remainingCosts: null } });
      assert.equal(counterfactual.status, 'counterfactual_calculated', JSON.stringify(counterfactual.reasons));
      assert.equal(counterfactual.deltaApplicationEligible, false);
      assert.equal(counterfactual.sourceAttested, false);
      assert.equal(counterfactual.deltas.totals.baseline.amountCents, 1000);
      assert.equal(JSON.stringify(saved.evidence), JSON.stringify(evidence), 'counterfactual preserves historical stored evidence');
      await db.query('COMMIT'); return { projection, basis, counterfactual };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { if (release) await release(); db.release(); }
  };
  const { projection: beforeRefundProjection, basis: beforeRefundBasis, counterfactual: beforeCounterfactual } = await readRefundProjection();
  assert.equal(beforeCounterfactual.deltas.totals.delta.amountCents, 0);
  assert.equal(beforeRefundProjection.saleLines.find(line => line.orderItemId === ids.item).remainingNetCents, 10000);
  assert.equal(beforeRefundProjection.saleLines.find(line => line.orderItemId === ids.zeroItem).remainingNetCents, 0);
  let v2PostRefundRunId = null;
  const insertLateRefundFixture = async () => {
    // Only the guard-owned disposable DB is mutated. Real producer triggers
    // append an all-time related refund after the saved sale month; no bypass.
    const client = await pool.connect();
    try {
      await beginPayrollSourceProducerTransaction(client, ids.venue);
      const shift = (await client.query('INSERT INTO shifts(venue_id,opened_by) VALUES($1,$2) RETURNING id', [ids.venue, ids.owner])).rows[0];
      const refund = (await client.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status)
        VALUES($1,$2,$3,0.50,'Late refund freshness QA','freshness-late-refund',$4,'complete') RETURNING id`,
      [ids.venue, ids.order, shift.id, ids.owner])).rows[0];
      await client.query(`INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot)
        VALUES($1,$2,$3,$4,0.50,'card',$5,'Freshness QA bank')`, [ids.venue, refund.id, ids.order, ids.payment, ids.account]);
      await client.query(`INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor)
        VALUES($1,$2,$3,$4,$5,1,NULL)`, [ids.venue, refund.id, ids.order, ids.pricing, ids.item]);
      await client.query('COMMIT');
      const recognized = (await client.query(`SELECT coverage_status,coverage_reasons,recognized_local_date::text FROM pos_payroll_refund_events
        WHERE venue_id=$1 AND refund_id=$2`, [ids.venue, refund.id])).rows[0];
      assert.equal(recognized.coverage_status, 'complete', JSON.stringify(recognized));
      assert.ok(recognized.recognized_local_date > period.to, 'refund is recognized outside the saved sale period');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    const { projection, basis, counterfactual } = await readRefundProjection();
    assert.equal(projection.saleLines.length, 2, 'zero original and fully returned original both retained');
    const returned = projection.saleLines.find(line => line.orderItemId === ids.item);
    assert.equal(returned.remainingNetCents, 0); assert.equal(returned.refundCents, 10000);
    assert.equal(projection.recognitionHistory.refundEvents.length, 1);
    assert.equal(projection.recognitionHistory.refundEvents[0].payoutMinor, 50, 'cash payout is not merchandise commission deduction');
    assert.notEqual(projection.projectionWatermark, beforeRefundProjection.projectionWatermark);
    assert.equal(projection.officialReady, false);
    assert.notEqual(basis.basisWatermark, beforeRefundBasis.basisWatermark);
    assert.equal(basis.saleLines.find(line => line.orderItemId === ids.item).remainingNetCents, 0);
    assert.equal(basis.treasuryRefundFacts[0].payoutMinor, 50);
    assert.equal(basis.treasuryRefundFacts[0].returnedMerchandiseMinor, 10000);
    assert.equal(counterfactual.deltas.totals.counterfactual.amountCents, 0);
    assert.equal(counterfactual.deltas.totals.delta.amountCents, -1000);
    assert.equal(counterfactual.deltas.totals.delta.fixedBaseCents, 0);
    assert.notEqual(counterfactual.counterfactualWatermark, beforeCounterfactual.counterfactualWatermark);
    const sourceV2After = await prepareV2();
    assert.equal(sourceV2After.status, 'refund_aware_calculated', JSON.stringify(sourceV2After.reasons));
    assert.equal(sourceV2After.amountCents, 0);
    assert.equal(sourceV2After.input.sales.length, 2, 'fully returned and original zero rows retained');
    assert.notEqual(sourceV2After.inputWatermark, sourceV2Before.inputWatermark);
    const v2EvidenceAfter = await prepareV2Evidence();
    assert.equal(v2EvidenceAfter.provenance.total_amount_cents, 0);
    const refundedSnapshotLine = v2EvidenceAfter.prepared.snapshotInput.sourceLines.find(line => line.orderItemId === ids.item);
    assert.equal(refundedSnapshotLine.refundCents, 10000);
    assert.equal(refundedSnapshotLine.commissionBaseCents, 0);
    const oldV2Replay = await service.createRefundAwareRun(owner, v2RunRequest);
    assert.equal(oldV2Replay.amountCents, 1000); assert.equal(oldV2Replay.replayed, true);
    const storedV2After = await service.createRefundAwareRun(owner, { ...v2RunRequest, idempotencyKey: 'v2-after-full-return-run' });
    v2PostRefundRunId = storedV2After.runId;
    assert.equal(storedV2After.status, 'ready', JSON.stringify(storedV2After)); assert.equal(storedV2After.amountCents, 0);
    const oldV2Freshness = await service.checkSavedRunFreshness(owner, v2Parallel[0].runId);
    assert.equal(oldV2Freshness.status, 'stale', JSON.stringify(oldV2Freshness));
    assert.equal(oldV2Freshness.sourceChanged, true); assert.ok(oldV2Freshness.changedFacts.length > 0);
    assert.equal((await service.checkSavedRunFreshness(owner, storedV2After.runId)).status, 'current');
    assert.equal((await service.replaySavedRun(owner, v2Parallel[0].runId)).verification.status, 'matched');
    assert.equal((await service.replaySavedRun(owner, storedV2After.runId)).verification.status, 'matched');
    assert.equal((await service.getSavedRun(owner, storedV2After.runId)).amountCents, 0);
    const storedV2Evidence = (await pool.query(`SELECT evidence_payload FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2`,
      [ids.venue, storedV2After.runId])).rows[0];
    assert.equal(rebuildPayrollRefundAwareRunProvenance(JSON.parse(storedV2Evidence.evidence_payload)).provenance.total_amount_cents, 0);
    console.log('PASS private v2 atomic stored run: migration204, exact concurrent retry, changed-source original replay, new remaining0 snapshots, rollback after real writes');
    console.log('PASS actual v2 typed snapshots and canonical provenance rebuild: original quantity, merchandise refund10000, remaining0, byte-exact full-source evidence replay');
    console.log('PASS private initial v2 actual source collection: explicit policy, owner/fence,1000→0 after late return, no source injection or automatic v1 upgrade');
    console.log('PASS actual source counterfactual: frozen whole-period1000 to remaining0, signed delta-1000, original evidence unchanged and no money authority');
    console.log('PASS actual saved provenance→full refund projection→bound economic basis: original replay unchanged, zero rows retained, merchandise10000 distinct from cash50');
  };
  await verifySavedRunBrowser({ pool, target, ids, period, versionId, runId: run.runId, snapshotId: saleDay.snapshotId,
    insertLateRefundFixture, correctionTarget, sourcePolicyVersionId: policyVersion.versionId, supersessionSourcePolicies: refundPolicyV2,
    refundAwareRuns: () => [
      { runId: v2Parallel[0].runId, expectedFreshness: 'stale', expectedAmountCents: 1000, expectedRefundCents: 0, expectedCommissionBaseCents: 10000 },
      { runId: v2PostRefundRunId, expectedFreshness: 'current', expectedAmountCents: 0, expectedRefundCents: 10000, expectedCommissionBaseCents: 0 }
    ] });
  await pool.query('UPDATE users SET is_active=false WHERE venue_id=$1 AND id=$2', [ids.venue, ids.employee]);
  const unsupported = await service.createRefundReview(owner, cappedRun.runId, { idempotencyKey: 'capped-review-after-return' });
  assert.equal(unsupported.latestAssessment.payload.impactCents, null);
  assert.equal(unsupported.latestAssessment.payload.coverage, 'needs_review');
  assert.ok(unsupported.latestAssessment.payload.reasons.includes('payroll_refund_review_nonlinear_components_unsupported'));
  assert.equal(unsupported.latestAssessment.payload.lines[0].employeeId, ids.employee, 'archived original seller remains attributed');
  const unknownHeld = await service.decideRefundReview(owner, unsupported.caseId, { decision: 'hold_for_review', reason: 'Cap requires a complete counterfactual',
    expectedAssessmentHash: unsupported.latestAssessment.assessmentHash, idempotencyKey: 'capped-review-owner-hold' });
  assert.equal(unknownHeld.status, 'hold_for_review');
  assert.deepEqual(await service.decideRefundReview(owner, firstReview.caseId, zeroDecisionInput), { ...zeroDecision, replayed: true },
    'exact decision retry returns original outcome after later return');
  await assert.rejects(service.decideRefundReview(owner, firstReview.caseId, { ...zeroDecisionInput, idempotencyKey: 'refund-review-stale-decision' }),
    error => error.status === 409 && error.code === 'payroll_refund_review_stale_assessment');
  const revisedReview = await service.createRefundReview(owner, run.runId, { idempotencyKey: 'refund-review-after-return' });
  assert.equal(revisedReview.assessments.length, 2);
  assert.equal(revisedReview.decisions.length, 1, 'prior owner decision remains in history');
  assert.equal(revisedReview.status, 'needs_review');
  assert.equal(revisedReview.latestAssessment.payload.coverage, 'complete', JSON.stringify(revisedReview.latestAssessment.payload.reasons));
  assert.equal(revisedReview.latestAssessment.payload.impactCents, -1000);
  assert.equal(revisedReview.latestAssessment.payload.lines[0].merchandiseDeltaCents, -10000,
    'merchandise value differs from 50-cent refund payout and from wage impact');
  await assert.rejects(service.decideRefundReview(owner, firstReview.caseId, { ...zeroDecisionInput,
    expectedAssessmentHash: revisedReview.latestAssessment.assessmentHash, idempotencyKey: 'refund-review-false-zero' }),
    error => error.code === 'payroll_refund_review_zero_effect_unproven');
  const decisions = await Promise.allSettled(['refund-review-terminal-one','refund-review-terminal-two'].map(idempotencyKey =>
    service.decideRefundReview(owner, firstReview.caseId, { decision: 'close_without_payroll_change', reason: 'Owner reviewed comparison only',
      expectedAssessmentHash: revisedReview.latestAssessment.assessmentHash, idempotencyKey })));
  assert.equal(decisions.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(decisions.filter(row => row.status === 'rejected' && row.reason.status === 409).length, 1);
  const unallocatedClient = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(unallocatedClient, ids.venue);
    const shift = (await unallocatedClient.query('SELECT id FROM shifts WHERE venue_id=$1 ORDER BY opened_at DESC LIMIT 1', [ids.venue])).rows[0];
    const refund = (await unallocatedClient.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status)
      VALUES($1,$2,$3,0.25,'Unallocated review QA','review-unallocated-return',$4,'unattributed') RETURNING id`,
    [ids.venue, ids.order, shift.id, ids.owner])).rows[0];
    await unallocatedClient.query(`INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot)
      VALUES($1,$2,$3,$4,0.25,'card',$5,'Freshness QA bank')`, [ids.venue, refund.id, ids.order, ids.payment, ids.account]);
    await unallocatedClient.query('COMMIT');
  } catch (error) { await unallocatedClient.query('ROLLBACK').catch(() => {}); throw error; }
  finally { unallocatedClient.release(); }
  const unallocated = await service.createRefundReview(owner, run.runId, { idempotencyKey: 'review-unallocated-assessment' });
  assert.equal(unallocated.latestAssessment.payload.coverage, 'needs_review');
  assert.equal(unallocated.latestAssessment.payload.impactCents, null, 'unallocated refund remains unknown, not zero');
  assert.ok(unallocated.latestAssessment.payload.lines.some(line => line.refundItemId === null));
  assert.equal(unallocated.assessments.length, 3, 'new source assessment preserves prior closed review');
  assert.equal(unallocated.status, 'needs_review');
  const journalTables = ['payroll_refund_review_cases','payroll_refund_review_assessments','payroll_refund_review_decisions','payroll_refund_review_requests'];
  const journalRows = async () => Promise.all(journalTables.map(async table =>
    (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE venue_id=$1 ORDER BY to_jsonb(t)::text`, [ids.venue])).rows));
  const beforeMigrationReplay = await journalRows();
  await pool.query(readFileSync(new URL('../migrations/201_payroll_refund_review_proposals.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await journalRows(), beforeMigrationReplay, 'migration replay preserves every persisted review/decision/request field');
  for (const table of ['payroll_refund_review_cases','payroll_refund_review_assessments','payroll_refund_review_decisions','payroll_refund_review_requests']) {
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE venue_id=$1`, [ids.venue]), error => error.code === '55000');
    await assert.rejects(pool.query(`UPDATE ${table} SET created_by=created_by WHERE venue_id=$1`, [ids.venue]), error => error.code === '55000');
    await assert.rejects(pool.query(`TRUNCATE ${table} CASCADE`), error => error.code === '55000');
  }
  const afterRefund = await service.checkSavedRunFreshness(owner, run.runId);
  assert.equal(afterRefund.status, 'blocked');
  assert.equal(afterRefund.sourceChanged, true);
  assert.ok(afterRefund.reasons.includes('payroll_official_no_refund_coverage_not_proven'), JSON.stringify(afterRefund));
  assert.equal((await service.replaySavedRun(owner, run.runId)).verification.status, 'matched', 'saved replay still matches after a live refund');
  assert.equal((await pool.query('SELECT evidence_payload FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
    [ids.venue, run.runId])).rows[0].evidence_payload, stored.evidence_payload, 'all freshness inspections preserve saved evidence');
  assert.deepEqual(await financialCounts(), { entries: countsBefore.entries + 5, expenses: countsBefore.expenses + 1 },
    'owner lifecycle created two cancelled, one positive paid and two zero paid entries with one expense; reviews create no financial writes');
  console.log('PASS payroll-verified-run-postgres-qa: real collector/provenance/storage; review zero/late/unallocated refund, unknown cap, archived seller, exact replay/stale/terminal races, atomic journal rollback/immutability, migration201 replay preserves all rows; review itself creates no posting, lifecycle records one positive and one zero settlement');
  }
} finally {
  if (!seedClosed) { await seed.query('ROLLBACK').catch(() => {}); await seed.end().catch(() => {}); }
  await pool.end();
}
