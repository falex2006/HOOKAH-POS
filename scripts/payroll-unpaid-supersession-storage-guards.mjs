// Imported only after the parent runner has verified its disposable database.
// No DSN, connection creation, standalone launch, or production writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_FIELDS = ('id venue_id scheme_version_id period_from period_to status source_coverage commission_basis '
  + 'eligible_line_count unattributed_line_count missing_net_line_count input_watermark input_checksum engine_version blocked_reason '
  + 'idempotency_key supersedes_run_id recalculation_reason created_by created_by_name venue_timezone currency milestone_evidence_version').split(' ');
const ENTRY_FIELDS = ('id venue_id user_id rule_id period_from period_to amount status finance_category_id '
  + 'calculation_run_id calculation_provenance_sha256 calculation_gross_cents materialized_by materialized_by_name '
  + 'materialized_at employee_name_snapshot calculation_scheme_name_snapshot finance_category_name_snapshot').split(' ');
const insert = (db, table, fields, row) => db.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
  fields.map(key => row[key]));

export async function verifyUnpaidSupersessionStorageGuards({ pool, venueId, originalRunId, replacementRunId, owner }) {
  assert.ok(pool && typeof pool.connect === 'function');
  for (const id of [venueId, originalRunId, replacementRunId, owner?.userId]) assert.match(id, UUID);
  assert.equal(owner.venueId, venueId);
  const db = await pool.connect();
  let checks = 0, discardError = null;
  try {
    const payoutEnabled = (await db.query("SELECT to_regclass('payroll_refund_aware_paid_assessments') IS NOT NULL AS enabled")).rows[0].enabled;
    // Capture complete table contents across venues: a broken TRUNCATE guard
    // must not escape detection merely because its effect crosses tenant rows.
    const tables = (await db.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_type='BASE TABLE'
        AND (left(table_name,8) IN ('payroll_','finance_') OR table_name='expenses')
      ORDER BY table_name`)).rows.map(row => row.table_name);
    for (const table of tables) assert.match(table, /^[a-z][a-z0-9_]*$/);
    assert.ok(tables.includes('payroll_run_supersession_requests') && tables.includes('expenses'));
    const state = async () => {
      const result = {};
      for (const table of tables) {
        const row = (await db.query(`SELECT count(*)::int AS count,
          encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
          FROM "${table}" t`)).rows[0];
        assert.ok(Number.isSafeInteger(row.count) && row.count >= 0);
        result[table] = row;
      }
      return result;
    };
    const baseline = await state();
    const rollback = async action => {
      await db.query('BEGIN');
      let failure;
      try { await action(); } catch (error) { failure = error; }
      finally { await db.query('ROLLBACK'); }
      assert.deepEqual(await state(), baseline, 'every guard attempt preserves every payroll/finance row');
      if (failure) throw failure;
    };
    const rejects = async (label, action, code, message) => {
      await rollback(async () => {
        let failure;
        try { await action(); } catch (error) { failure = { code: error.code, message: String(error.message) }; }
        assert.ok(failure, `${label}: expected rejection`);
        assert.equal(failure.code, code, `${label}: wrong error code`);
        assert.ok(failure.message.includes(message), `${label}: wrong guard`);
      });
      checks++;
    };
    const terminal = (await db.query(`SELECT ${RUN_FIELDS.map(key => ['period_from', 'period_to'].includes(key)
      ? `${key}::text AS ${key}` : key).join(',')} FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2`,
    [venueId, replacementRunId])).rows[0];
    assert.equal(terminal?.engine_version, 'payroll-verified-remaining-net-v2');
    const journal = (await db.query('SELECT id,replacement_run_id FROM payroll_run_supersession_requests WHERE venue_id=$1 AND original_run_id=$2',
      [venueId, originalRunId])).rows[0];
    assert.ok(journal && journal.replacement_run_id !== replacementRunId, 'fixture must include A -> B -> C');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payroll_run_supersession_requests WHERE venue_id=$1 AND original_run_id=$2',
      [venueId, replacementRunId])).rows[0].n, 0, 'C must still be terminal');
    const oldEntry = (await db.query('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id LIMIT 1',
      [venueId, originalRunId])).rows[0];
    const newEntry = (await db.query('SELECT id,status FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id LIMIT 1',
      [venueId, replacementRunId])).rows[0];
    assert.equal(oldEntry?.status, 'cancelled'); assert.equal(newEntry?.status, 'draft');
    const sql207 = await readFile(new URL('../migrations/207_payroll_unpaid_run_supersession.sql', import.meta.url), 'utf8');
    await rollback(async () => {
      await db.query(sql207); await db.query(sql207);
      assert.deepEqual(await state(), baseline, '207 repeated replay preserves populated chain history');
    }); checks++;
    await rejects('journal update', () => db.query('UPDATE payroll_run_supersession_requests SET reason=reason WHERE venue_id=$1 AND id=$2', [venueId, journal.id]),
      '55000', 'payroll_supersession_history_immutable');
    await rejects('journal delete', () => db.query('DELETE FROM payroll_run_supersession_requests WHERE venue_id=$1 AND id=$2', [venueId, journal.id]),
      '55000', 'payroll_supersession_history_immutable');
    await rejects('journal truncate', () => db.query('TRUNCATE payroll_run_supersession_requests'), '55000', 'payroll_supersession_history_immutable');
    const childHeader = parent => ({ ...terminal, id: randomUUID(), supersedes_run_id: parent,
      idempotency_key: `supersession-storage:${randomUUID()}`, recalculation_reason: 'Rollback-only supersession storage guard' });
    await rejects('raw second child of A', () => insert(db, 'payroll_calculation_runs', RUN_FIELDS, childHeader(originalRunId)),
      '23505', 'payroll_v2_single_replacement_uq');
    // Flush only 207's deferred journal guard. The deliberately header-only
    // child has no provenance, so flushing all constraints would test 194 first.
    await rejects('orphan child of C', async () => {
      await insert(db, 'payroll_calculation_runs', RUN_FIELDS, childHeader(replacementRunId));
      await db.query('SET CONSTRAINTS payroll_run_unpaid_supersession_commit IMMEDIATE');
    }, '23514', 'payroll_supersession_journal_required');
    await rejects('rematerialize A after replacement', () => insert(db, 'payroll_entries', ENTRY_FIELDS,
      { ...oldEntry, id: randomUUID(), status: 'draft' }), '23514', 'payroll_supersession_original_replaced');
    for (const status of ['approved', 'paid']) await rejects(`v2 raw ${status}`, () => db.query('UPDATE payroll_entries SET status=$3 WHERE venue_id=$1 AND id=$2',
      [venueId, newEntry.id, status]), '23514', payoutEnabled
      ? status === 'approved' ? 'payroll_lifecycle_transition_required' : 'payroll_calculation_entry_transition_invalid'
      : 'payroll_run_payout_not_enabled');

    // Exercise the actual owner service with its normal private source fence.
    // Even an unexpected successful approval cannot commit: this injected pool
    // converts its COMMIT to ROLLBACK. It never releases our leased connection.
    const rollbackPool = { query: (...args) => db.query(...args), connect: async () => ({
      query: (sql, values) => db.query(/^\s*COMMIT\b/i.test(String(sql)) ? 'ROLLBACK' : sql, values),
      release: error => { if (error) discardError = error; }
    }) };
    const service = makeService(rollbackPool);
    const current = await service.getCalculationEntryState(owner, newEntry.id);
    assert.deepEqual(await state(), baseline);
    let serviceFailure, approved;
    try {
      approved = await service.transitionCalculationEntry(owner, newEntry.id, { action: 'approve', expectedStateHash: current.stateHash,
        idempotencyKey: `supersession-approve:${randomUUID()}`, paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: null });
    } catch (error) { serviceFailure = { code: error.code, status: error.status }; }
    finally { await db.query('ROLLBACK'); }
    assert.deepEqual(await state(), baseline, 'service approval attempt creates no expense or receipt');
    if (payoutEnabled) {
      assert.equal(serviceFailure, undefined, '208 permits approval only through the proven lifecycle');
      assert.equal(approved.entry.status, 'approved');
    } else {
      assert.equal(serviceFailure?.status, 409, 'v2 approval remains unavailable before208');
      assert.equal(serviceFailure.code, 'payroll_entry_lifecycle_rejected', 'failure is the v2 database monetary gate');
    }
    checks++;
    return { status: 'passed', checks, transactionMode: 'rollback_only', migrationReplayCount: 2,
      journalImmutable: true, branchingBlocked: true, orphanCommitBlocked: true,
      rematerializationBlocked: true, approvalBlocked: !payoutEnabled, rawApprovalBlocked: true,
      financialRowsChanged: false, tablesChecked: tables.length };
  } finally { db.release(discardError || undefined); }
}
