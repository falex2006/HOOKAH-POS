import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { makePayrollRefundAwareFixture } from './payroll-refund-aware-calculation-contract.mjs';

// Opt-in only: keep the runner-owned fresh fixture alive across REAL midnight.
// No clock/timezone/default/trigger changes and no historical fixture seeding.
export async function verifyTrackedCostLifecycle({ db, api, ids, accountId, from, to, marker, producerWatermark, connectionString }) {
  assert.equal(process.env.PAYROLL_TRACKED_NATURAL_CLOSURE_QA, '1');
  const clock = async () => (await db.query(`SELECT current_database() AS database,
    clock_timestamp()::text AS instant, timezone,
    (clock_timestamp() AT TIME ZONE timezone)::date::text AS date,
    EXTRACT(EPOCH FROM (((($2::date+1)::timestamp) AT TIME ZONE timezone)-clock_timestamp()))::float AS seconds
    FROM venues WHERE id=$1`, [ids.venue, to])).rows[0];
  const initialClock = await clock();
  assert.match(initialClock.database, /^inventory_qa_[a-f0-9]{16}$/);
  assert.equal(initialClock.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  assert.equal(initialClock.timezone, 'Asia/Yekaterinburg');
  assert.equal(initialClock.date, to, 'fixture must start on its real sale day');
  assert.ok(initialClock.seconds > 0 && initialClock.seconds < 10 * 60, 'run only within ten minutes before natural venue midnight');
  const sourcePolicies = makePayrollRefundAwareFixture('margin_target').scheme.sourcePolicies;
  const scheme = await api('/api/payroll/schemes', 'POST', { name: 'Tracked cost natural closure QA',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'margin_target', currency: 'RUB', effectiveFrom: from, sourcePolicies,
      roleParameters: { bartender: { perShiftCents: 0, targetCents: 100000, baseRateBps: 1000, bonusRateBps: 1000,
        excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' } },
      roleAssignments: [{ employeeId: ids.seller, roleId: 'bartender', effectiveFrom: from }], employeeOverrides: [], itemRules: [] } }, 201);
  const versionId = scheme.versions[0].versionId;
  await api(`/api/payroll/versions/${versionId}/activate`, 'POST', {});
  const snapshot = async () => {
    const values = {};
    for (const table of ['payroll_calculation_runs', 'payroll_entries', 'expenses', 'payroll_calculation_entry_transitions', 'pos_sale_cost_evidence']) {
      values[table] = (await db.query(`SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
        FROM ${table} t WHERE venue_id=$1`, [ids.venue])).rows[0];
    }
    return values;
  };
  const command = { schemeVersionId: versionId, periodFrom: from, periodTo: to, idempotencyKey: `tracked-natural-run-${marker}` };
  const before = await snapshot();
  const open = await api('/api/payroll/refund-aware-calculation-runs', 'POST', command, 422);
  assert.equal(open.status, 'blocked');
  assert.ok(open.reasons.includes('payroll_refund_aware_calculation_unavailable'), JSON.stringify(open));
  const require = createRequire(import.meta.url);
  const pool = new (require('pg').Pool)({ connectionString, max: 1 });
  try {
    const prepared = await require('../payroll-scheme-service').makeService(pool).prepareRefundAwareCalculation(
      { venueId: ids.venue, userId: ids.owner }, versionId, { periodFrom: from, periodTo: to });
    assert.equal(prepared.status, 'blocked');
    assert.ok(prepared.reasons.includes('payroll_calculation_period_not_closed'), JSON.stringify(prepared));
  } finally { await pool.end(); }
  assert.deepEqual(await snapshot(), before, 'open period cannot create financial records');
  console.log(`WAIT natural closure: ${initialClock.instant}, venue=${initialClock.timezone}, saleDate=${to}`);
  const deadline = Date.now() + 10 * 60_000;
  let closedClock;
  do {
    await delay(1000);
    closedClock = await clock();
    assert.equal(closedClock.timezone, initialClock.timezone);
    assert.ok(Date.now() < deadline, 'natural midnight deadline exceeded');
  } while (closedClock.date <= to);
  const run = await api('/api/payroll/refund-aware-calculation-runs', 'POST', command, 201);
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal((await api('/api/payroll/refund-aware-calculation-runs', 'POST', command)).replayed, true);
  const saved = (await db.query('SELECT evidence_payload FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2', [ids.venue, run.runId])).rows[0];
  assert.ok(saved.evidence_payload.includes(producerWatermark), 'saved evidence binds original positive-cost producer');
  const entryInput = { employeeId: ids.seller, financeCategoryId: null, idempotencyKey: `tracked-natural-entry-${marker}` };
  const entry = (await api(`/api/payroll/calculation-runs/${run.runId}/entries`, 'POST', entryInput, 201)).entry;
  let payCommand;
  for (const action of ['approve', 'pay']) {
    const state = await api(`/api/payroll/calculation-entries/${entry.id}/state`);
    const transition = { action, expectedStateHash: state.stateHash, idempotencyKey: `tracked-natural-${action}-${marker}`,
      reason: null, paymentDate: action === 'pay' ? closedClock.date : null,
      paymentMethod: action === 'pay' ? 'card' : null, paymentAccountId: action === 'pay' ? accountId : null };
    const result = await api(`/api/payroll/calculation-entries/${entry.id}/transition`, 'POST', transition);
    assert.equal(result.entry.status, action === 'pay' ? 'paid' : 'approved');
    if (action === 'pay') payCommand = transition;
  }
  const paid = (await db.query(`SELECT e.status,(e.amount*100)::bigint::text AS cents,e.expense_id,
    (x.amount*100)::bigint::text AS expense_cents FROM payroll_entries e JOIN expenses x ON x.venue_id=e.venue_id AND x.id=e.expense_id
    WHERE e.venue_id=$1 AND e.id=$2`, [ids.venue, entry.id])).rows[0];
  assert.deepEqual([paid.status, paid.cents, paid.expense_cents], ['paid', '1510', '1510']);
  const settled = await snapshot();
  assert.equal(settled.payroll_entries.count, before.payroll_entries.count + 1);
  assert.equal(settled.expenses.count, before.expenses.count + 1);
  const retry = await api(`/api/payroll/calculation-entries/${entry.id}/transition`, 'POST', payCommand);
  assert.equal(retry.replayed, true);
  assert.deepEqual(await snapshot(), settled, 'pay retry creates no second expense or receipt');
  const replay = await api(`/api/payroll/calculation-runs/${run.runId}/replay`, 'POST', {});
  assert.equal(replay.verification.status, 'matched');
  console.log(`PASS positive tracked cost lifecycle: cost5000, pay1510, one expense, exact retry/replay; natural closure ${initialClock.instant} -> ${closedClock.instant}`);
}
