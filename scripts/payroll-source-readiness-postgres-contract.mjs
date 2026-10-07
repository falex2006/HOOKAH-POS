import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const require = createRequire(import.meta.url), { Client, Pool } = require('pg');
const { makeService } = require('../payroll-scheme-service');
const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const schema = `payroll_readiness_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_readiness_qa_\d+_\d+$/);
const db = new Client({ connectionString: target.url.href });
const scoped = new URL(target.url); scoped.searchParams.set('options', `-c search_path=${schema},public`);
let pool, created = false;
try {
  await db.connect();
  assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0], target.database, Number(target.url.port));
  await db.query(`CREATE SCHEMA "${schema}"`); created = true;
  await db.query(`SET search_path TO "${schema}",public`);
  await db.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  // The base schema now includes later POS tables. This own disposable schema
  // explicitly models the original <=087 capability boundary before replay.
  await db.query('DROP TRIGGER IF EXISTS pos_order_item_after_snapshot ON order_items');
  await db.query('DROP TABLE IF EXISTS pos_order_pricing_snapshot_lines,pos_order_pricing_snapshots,order_refund_tenders,order_refunds CASCADE');
  for (const name of readdirSync(path.join(root, 'migrations')).filter(name => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 87).sort()) await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  pool = new Pool({ connectionString: scoped.href }); const service = makeService(pool);
  const venueId = (await db.query("INSERT INTO venues(name,timezone) VALUES('Readiness QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  const foreignVenue = (await db.query("INSERT INTO venues(name,timezone) VALUES('Foreign readiness','UTC') RETURNING id")).rows[0].id;
  const user = async (venue, role, name) => (await db.query('INSERT INTO users(venue_id,full_name,login,role) VALUES($1,$2,$3,$4) RETURNING id', [venue, name, `${schema}-${name}`, role])).rows[0].id;
  const ownerId = await user(venueId, 'owner', 'owner'), employee = await user(venueId, 'bartender', 'staff'), foreignOwner = await user(foreignVenue, 'owner', 'foreign');
  const owner = { venueId, userId: ownerId }, period = { from: '2026-11-01', to: '2026-11-02' };
  const createdScheme = await service.createScheme(owner, { name: 'Readiness', definition: { mode: 'stable_percent', currency: 'RUB', effectiveFrom: '2026-11-01',
    roleParameters: { bar: { perShiftCents: 0, stableRateBps: 0 } }, roleAssignments: [], employeeOverrides: [], itemRules: [] },
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' } });
  const version = createdScheme.versions[0].versionId;
  const read = () => service.getSourceReadiness(owner, version, period);
  let result = await read(); assert.equal(result.officialReady, false);
  assert.equal(result.components.orderObservations.closedOrderCount, 0);
  assert.equal(result.components.canonicalLinePricing.status, 'unsupported');
  assert.equal(result.components.refundObservations.status, 'unsupported');
  assert.equal(result.components.refundObservations.eventCount, null);
  assert.equal(result.components.approvedAttendance.status, 'incomplete');
  await assert.rejects(() => service.getSourceReadiness({ venueId, userId: employee }, version, period), error => error.status === 403);
  await assert.rejects(() => service.getSourceReadiness({ venueId: foreignVenue, userId: foreignOwner }, version, period), error => error.status === 404);
  for (const bad of [{ from: '2026-11-02', to: '2026-11-03' }, { from: '2026-02-30', to: '2026-02-30' }, { ...period, coverage: 'complete' }]) await assert.rejects(() => service.getSourceReadiness(owner, version, bad), error => error.status === 400);
  const order = async (venue, openedBy, closedAt, locked = false) => (await db.query(`INSERT INTO orders(venue_id,opened_by,status,closed_at,pricing_locked_at,pricing_version,subtotal_snapshot,discount_total_snapshot,minimum_adjustment_snapshot,final_total_snapshot)
    VALUES($1,$2,'closed',$3,$4,$5,$6,$7,$7,$6) RETURNING id`, [venue, openedBy, closedAt, locked ? '2026-10-31T19:01:00Z' : null, locked ? 1 : null, locked ? 20 : null, locked ? 0 : null])).rows[0].id;
  const inspectedOrder = await order(venueId, ownerId, '2026-10-31T19:30:00Z', true);
  const oldOrder = await order(venueId, ownerId, '2026-10-31T18:59:00Z');
  await order(venueId, ownerId, '2026-11-02T19:00:00Z');
  await order(venueId, ownerId, '2026-11-02T12:00:00Z');
  await order(venueId, ownerId, null);
  const foreignOrder = await order(foreignVenue, foreignOwner, '2026-11-01T12:00:00Z');
  const product = (await db.query("INSERT INTO products(venue_id,name,category,sale_price) VALUES($1,'Item','bar',10) RETURNING id", [venueId])).rows[0].id;
  await db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES($1,$2,1,10,$3,$4),($1,$2,1,10,NULL,NULL)', [inspectedOrder, product, employee, '2026-10-31T19:15:00Z']);
  result = await read(); assert.equal(result.components.orderObservations.closedOrderCount, 2);
  assert.equal(result.components.orderObservations.lockedOrderCount, 1);
  assert.equal(result.components.orderObservations.missingLockedHeaderCount, 1);
  assert.equal(result.components.orderObservations.observedLineCount, 2);
  assert.equal(result.components.orderObservations.missingSalesAttributionLineCount, 1);
  assert.equal(result.components.orderObservations.missingClosedAtCountVenueWide, 1);
  const watermark = result.components.orderObservations.sourceWatermark;
  assert.equal((await read()).components.orderObservations.sourceWatermark, watermark);
  await db.query(readFileSync(path.join(root, 'migrations/088_pos_order_refunds.sql'), 'utf8'));
  const shift = (await db.query('INSERT INTO shifts(venue_id,opened_by) VALUES($1,$2) RETURNING id', [venueId, ownerId])).rows[0].id;
  const foreignShift = (await db.query('INSERT INTO shifts(venue_id,opened_by) VALUES($1,$2) RETURNING id', [foreignVenue, foreignOwner])).rows[0].id;
  await db.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,created_at)
    VALUES($1,$2,$3,1,'Fixture','readiness:event',$4,'2026-11-01T10:00:00Z'),($1,$5,$3,1,'Fixture','readiness:linked',$4,'2026-12-01T10:00:00Z'),
    ($6,$7,$8,1,'Fixture','readiness:foreign',$9,'2026-11-01T10:00:00Z')`, [venueId, oldOrder, shift, ownerId, inspectedOrder, foreignVenue, foreignOrder, foreignShift, foreignOwner]);
  result = await read(); assert.equal(result.components.refundObservations.eventCount, 1);
  assert.equal(result.components.refundObservations.status, 'incomplete');
  assert.deepEqual(result.components.refundObservations.reasons, ['recorded_refund_item_attribution_incomplete']);
  assert.equal(result.components.refundObservations.unattributedEventCount, 1);
  assert.equal(result.components.refundObservations.linkedToInspectedOrdersCount, 1);
  assert.equal(result.components.recognizedLineRefunds.status, 'unsupported');
  const coverage = await service.readAttendanceCoverage(owner, { periodFrom: period.from, periodTo: period.to });
  await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end) VALUES($1,$2,'2026-11-01','2026-11-01T10:00:00Z','2026-11-01T18:00:00Z')`, [venueId, employee]);
  await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,'2026-11-01T10:00:00Z','2026-11-01T12:00:00Z','manual')`, [venueId, employee]);
  const fresh = await service.readAttendanceCoverage(owner, { periodFrom: period.from, periodTo: period.to });
  await service.approveAttendanceCoverage(owner, { periodFrom: period.from, periodTo: period.to, sourceWatermark: fresh.sourceWatermark, reason: 'Readiness approved actual work', idempotencyKey: 'readiness:attendance' });
  assert.notEqual(fresh.sourceWatermark, coverage.sourceWatermark);
  const counts = async () => (await db.query('SELECT (SELECT count(*) FROM payroll_entries)::int AS entries,(SELECT count(*) FROM expenses)::int AS expenses,(SELECT count(*) FROM payroll_calculation_runs)::int AS runs,(SELECT count(*) FROM order_refunds)::int AS refunds,(SELECT count(*) FROM payroll_scheme_version_revisions)::int AS revisions')).rows[0];
  const before = await counts(); result = await read();
  assert.equal(result.components.approvedAttendance.status, 'available'); assert.equal(result.components.approvedAttendance.shiftCount, 1);
  assert.equal(result.officialReady, false); assert.deepEqual(await counts(), before);
  // Deterministic barrier: commit on another connection after headers, before lines/refunds/attendance.
  // The service still owns its real PostgreSQL transaction; only query scheduling is instrumented.
  const snapshotBefore = result;
  let signalHeaders, resumeHeaders, barrierHit = false, released = 0, rolledBack = 0;
  const headersRead = new Promise(resolve => { signalHeaders = resolve; });
  const headersResume = new Promise(resolve => { resumeHeaders = resolve; });
  const instrumentedPool = (intercept) => ({
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (...args) => {
          const sql = args[0];
          if (typeof sql === 'string' && sql.startsWith('BEGIN ISOLATION')) {
            const response = await client.query(...args);
            const settings = (await client.query('SHOW transaction_isolation')).rows[0];
            assert.equal(settings.transaction_isolation, 'repeatable read');
            assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
            return response;
          }
          if (sql === 'ROLLBACK') rolledBack++;
          return intercept(client, args);
        },
        release: () => { released++; client.release(); }
      };
    }
  });
  const snapshotService = makeService(instrumentedPool(async (client, args) => {
    const response = await client.query(...args);
    if (!barrierHit && typeof args[0] === 'string' && args[0].includes('SELECT id::text,closed_at::text')) {
      barrierHit = true; signalHeaders(); await headersResume;
    }
    return response;
  }));
  const pending = snapshotService.getSourceReadiness(owner, version, period);
  const settled = pending.then(value => ({ value }), error => ({ error }));
  // Race the live operation as well: a failed query must not leave this test waiting at a missing barrier.
  await Promise.race([headersRead, pending.then(() => { throw new Error('readiness_header_barrier_missing'); })]);
  try {
    await db.query('BEGIN');
    await db.query('UPDATE order_items SET quantity=2 WHERE order_id=$1 AND sales_employee_id=$2', [inspectedOrder, employee]);
    await db.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,created_at)
      VALUES($1,$2,$3,2,'Concurrent fixture','readiness:concurrent',$4,'2026-11-01T12:00:00Z')`, [venueId, inspectedOrder, shift, ownerId]);
    await db.query("UPDATE staff_work_logs SET ended_at='2026-11-01T13:00:00Z' WHERE venue_id=$1", [venueId]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK'); throw error;
  } finally { resumeHeaders(); await settled; }
  const snapshotOutcome = await settled;
  if (snapshotOutcome.error) throw snapshotOutcome.error;
  assert.deepEqual(snapshotOutcome.value, snapshotBefore, 'all components retain the pre-commit RR snapshot');
  assert.equal(released, 1);
  const afterCommit = await read();
  assert.notEqual(afterCommit.components.orderObservations.sourceWatermark, snapshotBefore.components.orderObservations.sourceWatermark);
  assert.notEqual(afterCommit.components.refundObservations.sourceWatermark, snapshotBefore.components.refundObservations.sourceWatermark);
  assert.deepEqual(afterCommit.components.approvedAttendance.reasons, ['payroll_attendance_approval_stale']);
  assert.equal(afterCommit.officialReady, false);
  const afterExternalWrite = { ...before, refunds: before.refunds + 1 };
  assert.equal(afterCommit.components.refundObservations.eventCount, snapshotBefore.components.refundObservations.eventCount + 1);
  assert.equal(afterCommit.components.refundObservations.linkedToInspectedOrdersCount, snapshotBefore.components.refundObservations.linkedToInspectedOrdersCount + 1);
  assert.deepEqual(await counts(), afterExternalWrite, 'only the explicit external refund insert changes row counts');

  // Unexpected SQL failure propagates, rolls back, releases the client, and does not poison the pool.
  const sqlFailure = Object.assign(new Error('synthetic readiness SQL failure'), { code:'XX000' });
  let injectFailure = true;
  const failureService = makeService(instrumentedPool(async (client, args) => {
    if (injectFailure && typeof args[0] === 'string' && args[0].startsWith('SELECT timezone FROM venues')) {
      injectFailure = false; throw sqlFailure;
    }
    return client.query(...args);
  }));
  await assert.rejects(() => failureService.getSourceReadiness(owner, version, period), error => error === sqlFailure);
  assert.equal(rolledBack, 1); assert.equal(released, 2);
  assert.deepEqual(await failureService.getSourceReadiness(owner, version, period), afterCommit);
  assert.equal(released, 3); assert.deepEqual(await counts(), afterExternalWrite);

  await order(venueId, ownerId, '2026-10-31T19:00:00Z', true);
  const boundary = await read();
  assert.equal(boundary.components.orderObservations.closedOrderCount, afterCommit.components.orderObservations.closedOrderCount + 1, 'exact local midnight included');
  assert.equal(boundary.components.orderObservations.missingLockedHeaderCount, afterCommit.components.orderObservations.missingLockedHeaderCount);
  const outsideOrder = await order(venueId, ownerId, '2026-12-01T12:00:00Z', true);
  await db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES($1,$2,3,10,$3,$4)', [outsideOrder, product, employee, '2026-12-01T10:00:00Z']);
  const foreignProduct = (await db.query("INSERT INTO products(venue_id,name,category,sale_price) VALUES($1,'Foreign item','bar',10) RETURNING id", [foreignVenue])).rows[0].id;
  await db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES($1,$2,4,10,$3,$4)', [foreignOrder, foreignProduct, foreignOwner, '2026-11-01T10:00:00Z']);
  await db.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,created_at)
    VALUES($1,$2,$3,1,'Outside both scopes','readiness:outside',$4,'2026-12-02T10:00:00Z'),
    ($5,$6,$7,1,'Foreign tenant','readiness:foreign-extra',$8,'2026-11-01T12:00:00Z')`,
    [venueId, outsideOrder, shift, ownerId, foreignVenue, foreignOrder, foreignShift, foreignOwner]);
  const isolated = await read();
  assert.deepEqual(isolated, boundary, 'foreign tenant and outside both date scopes do not change the report');

  // Independent requirements oracle: owner selection is persisted intent, never source attestation.
  const commonFacts = ['venue_currency_timezone_snapshot', 'consistent_source_watermark_and_full_coverage', 'immutable_sale_portions',
    'finance_full_employee_net_revenue_using_selected_credit_policy', 'approved_attendance_revision',
    'finance_recognized_line_refund_events', 'original_sale_refund_allocation_lineage', 'closed_run_adjustment_lineage',
    'owner_reviewed_variable_pay_adjustments', 'uncovered_adjustment_balance_review'];
  const creditFacts = {
    line_seller_snapshot: ['immutable_line_seller_identity'],
    order_responsible_snapshot: ['explicit_immutable_order_payroll_responsible_identity'],
    explicit_line_allocation: ['immutable_employee_line_credit_allocations', 'complete_line_credit_allocation_conservation']
  };
  const discountFacts = {
    immutable_line_snapshot: ['canonical_immutable_line_pricing_snapshot'],
    eligible_gross_proportional_fixed_order: ['immutable_selected_fixed_order_discount', 'pricing_source_eligible_portion_gross_snapshot', 'complete_fixed_discount_allocation_conservation']
  };
  const refundFacts = { recognized_event_date: 'finance_refund_recognition_date', original_sale_period_correction: 'immutable_original_period_correction_run_lineage' };
  let policyCases = 0;
  for (const credit of Object.keys(creditFacts)) for (const discount of Object.keys(discountFacts)) for (const recognition of Object.keys(refundFacts)) {
    const sourcePolicies = { schemaVersion:1, selectionReason:'QA owner selected source requirements', saleCredit:{kind:credit},
      discountAllocation: discount === 'immutable_line_snapshot' ? {kind:discount} : {kind:discount,rounding:'largest_remainder_code_unit_v1',eligibility:'pricing_source_snapshot'},
      refunds:{recognition,closedRunTreatment:'next_open_run_adjustment',paidAdjustment:'owner_review_variable_pay_only',uncoveredBalance:'carry_forward_review',clawback:'no_automatic_clawback'} };
    const selected = await service.createScheme(owner, { name:'Readiness policy '+(++policyCases), definition:{mode:'stable_percent',currency:'RUB',effectiveFrom:period.from,
      roleParameters:{bar:{perShiftCents:0,stableRateBps:0}},roleAssignments:[],employeeOverrides:[],itemRules:[],sourcePolicies},
      payoutRiskAcknowledgement:{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'} });
    const selectedId = selected.versions[0].versionId;
    assert.deepEqual((await service.getVersion(owner, selectedId)).sourcePolicies, sourcePolicies);
    assert.deepEqual((await db.query('SELECT config_json FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2', [venueId, selectedId])).rows[0].config_json.sourcePolicies, sourcePolicies);
    const beforePolicyRead = await counts();
    const report = await service.getSourceReadiness(owner, selectedId, period);
    assert.deepEqual(report.requiredSourceFacts, [...commonFacts,...creditFacts[credit],...discountFacts[discount],refundFacts[recognition]].sort());
    assert.equal(report.components.sourcePolicies.status, 'available'); assert.equal(report.officialReady, false);
    for (const component of ['canonicalLinePricing','payrollSaleCredit','recognizedLineRefunds','fullEmployeeNetRevenue','marginCosts','departmentShiftAllocation']) assert.equal(report.components[component].status, 'unsupported', component);
    assert.deepEqual(report.components.orderObservations, isolated.components.orderObservations);
    assert.deepEqual(report.components.refundObservations, isolated.components.refundObservations);
    assert.deepEqual(await counts(), beforePolicyRead, 'policy readiness reads do not write revisions or postings');
  }
  assert.equal(policyCases, 12);
  console.log('PAYROLL SOURCE READINESS POSTGRES: PASS (12 saved policy combinations with independent lineage requirements, tenant/outside-scope hash isolation, exact local midnight, real RR concurrent snapshot, SQL recovery, approval lineage; no official source claim)');
} finally {
  if (pool) await pool.end();
  if (created) {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
  }
  await db.end();
}
