// Called only by the disposable-database QA runner after its identity checks.
// No connection creation, environment DSN, standalone execution or payload logs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareRunProvenance, rebuildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance.js');
const { persistPayrollSnapshotBundleInTransaction } = require('../payroll-snapshot-persistence.js');
const RUN_FIELDS = ('id venue_id scheme_version_id period_from period_to status source_coverage commission_basis '
  + 'eligible_line_count unattributed_line_count missing_net_line_count input_watermark input_checksum engine_version blocked_reason '
  + 'idempotency_key supersedes_run_id recalculation_reason created_by created_by_name venue_timezone currency milestone_evidence_version').split(' ');
const PROVENANCE_FIELDS = 'venue_id run_id schema_version capability_version evidence_payload evidence_sha256 total_amount_cents'.split(' ');
const TABLES = ['payroll_calculation_runs', 'payroll_run_provenance', 'payroll_daily_snapshots', 'payroll_daily_snapshot_lines',
  'payroll_team_fund_snapshots', 'payroll_team_fund_snapshot_allocations', 'payroll_milestone_day_snapshots',
  'payroll_milestone_decision_snapshots', 'payroll_entries', 'expenses'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const insert = (db, table, fields, row) => db.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
  fields.map(key => row[key]));

export async function verifyRefundAwareStorageGuards({ pool, venueId, runId }) {
  assert.ok(pool && typeof pool.connect === 'function');
  assert.match(venueId, UUID); assert.match(runId, UUID);
  const db = await pool.connect();
  let checks = 0;
  const state = async () => {
    const result = {};
    for (const table of TABLES) {
      const row = (await db.query(`SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
        FROM ${table} t WHERE venue_id=$1`, [venueId])).rows[0];
      assert.ok(Number.isSafeInteger(row.count) && row.count >= 0);
      result[table] = row;
    }
    return result;
  };
  let baseline;
  const rolledBack = async action => {
    await db.query('BEGIN');
    try { await action(); }
    finally { await db.query('ROLLBACK'); }
    assert.deepEqual(await state(), baseline, 'guard attempt must preserve all venue payroll/expense rows');
  };
  const rejected = async (label, action, code = '23514', message = null) => {
    await rolledBack(async () => {
      let failure;
      try { await action(); }
      catch (error) { failure = { code: error.code, message: String(error.message) }; }
      // Do not attach pg error.detail: CHECK failures can include entire rows.
      assert.ok(failure, `${label}: expected rejection`);
      assert.equal(failure.code, code, `${label}: unexpected error code`);
      if (message) assert.ok(failure.message.includes(message), `${label}: unexpected guard`);
    });
    checks++;
  };
  try {
    const originalRun = (await db.query(`SELECT ${RUN_FIELDS.map(key => ['period_from', 'period_to'].includes(key)
      ? `${key}::text AS ${key}` : key).join(',')} FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2`, [venueId, runId])).rows[0];
    const originalProvenance = (await db.query('SELECT * FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2', [venueId, runId])).rows[0];
    assert.equal(originalRun?.engine_version, 'payroll-verified-remaining-net-v2');
    assert.equal(originalRun.status, 'ready'); assert.equal(originalProvenance?.schema_version, 2);
    const savedEvidence = JSON.parse(originalProvenance.evidence_payload);
    const verified = rebuildPayrollRefundAwareRunProvenance(savedEvidence);
    assert.equal(verified.provenance.evidence_sha256, originalProvenance.evidence_sha256);
    assert.ok(verified.provenance.total_amount_cents > 0, 'missing-daily guard requires the initial positive v2 run');
    baseline = await state();
    const fresh = () => {
      const bundle = savedEvidence.sourceBundle;
      const rebuilt = buildPayrollRefundAwareRunProvenance({ venueId, runId: randomUUID(), scheme: savedEvidence.schemeSnapshot,
        period: savedEvidence.period, periodClosure: savedEvidence.periodClosure,
        recognitionEvidence: JSON.parse(bundle.recognitionEvidence.payload), employmentEligibility: bundle.employmentEligibility,
        approvedAttendanceSource: bundle.approvedAttendanceSource, departmentMapping: bundle.departmentMapping,
        costEvidenceByOrder: bundle.costEvidenceByOrder });
      assert.equal(rebuilt.status, 'verified_run_evidence');
      return { run: { ...originalRun, id: rebuilt.provenance.run_id, idempotency_key: `v2-storage-guard-${randomUUID()}`,
        input_checksum: rebuilt.provenance.evidence_sha256, input_watermark: rebuilt.prepared.sourceWatermark },
      provenance: structuredClone(rebuilt.provenance), input: structuredClone(rebuilt.prepared.snapshotInput) };
    };
    for (const [schema, capability] of [[1, 'employee_attributed_remaining_net_refund_v2'], [2, 'employee_attributed_merchandise_net_no_refund_v1']]) {
      await rejected(`invalid provenance pair ${schema}`, async () => {
        const bundle = fresh();
        const payload = JSON.parse(bundle.provenance.evidence_payload);
        payload.schemaVersion = schema; payload.capabilityVersion = capability;
        bundle.provenance.evidence_payload = JSON.stringify(payload);
        bundle.provenance.evidence_sha256 = createHash('sha256').update(bundle.provenance.evidence_payload).digest('hex');
        bundle.run.input_checksum = bundle.provenance.evidence_sha256;
        await insert(db, 'payroll_calculation_runs', RUN_FIELDS, bundle.run);
        await insert(db, 'payroll_run_provenance', PROVENANCE_FIELDS,
          { ...bundle.provenance, schema_version: schema, capability_version: capability });
      }, '23514', 'does not match verified ready run');
    }
    await rejected('v2 provenance cannot attach to a v1 engine', async () => {
      const bundle = fresh(); bundle.run.engine_version = 'payroll-verified-no-refund-v1';
      await insert(db, 'payroll_calculation_runs', RUN_FIELDS, bundle.run);
      await insert(db, 'payroll_run_provenance', PROVENANCE_FIELDS, bundle.provenance);
    }, '23514', 'does not match verified ready run');
    // These are the same deferred triggers executed at COMMIT. Flushing only
    // them keeps every attempt rollback-only even if the expected guard breaks.
    await rejected('ready v2 missing provenance is rejected by commit guard', async () => {
      await insert(db, 'payroll_calculation_runs', RUN_FIELDS, fresh().run);
      await db.query('SET CONSTRAINTS payroll_calculation_runs_provenance_commit IMMEDIATE');
    }, '23514', 'verified payroll run requires provenance');
    await rejected('positive v2 missing daily totals is rejected by commit guard', async () => {
      const bundle = fresh();
      await insert(db, 'payroll_calculation_runs', RUN_FIELDS, bundle.run);
      await insert(db, 'payroll_run_provenance', PROVENANCE_FIELDS, bundle.provenance);
      await db.query('SET CONSTRAINTS payroll_calculation_runs_provenance_commit, payroll_run_provenance_provenance_commit IMMEDIATE');
    }, '23514', 'payroll provenance total mismatch');
    await rejected('typed source mismatch is rejected before persistence', async () => {
      const bundle = fresh(); assert.ok(bundle.input.sourceLines.length > 0);
      bundle.input.sourceLines[0].commissionBaseCents++;
      await persistPayrollSnapshotBundleInTransaction(db, bundle);
    }, 'payroll_source_net_reconciliation_failed');
    await rejected('provenance update forbidden', () => db.query('UPDATE payroll_run_provenance SET evidence_payload=evidence_payload WHERE venue_id=$1 AND run_id=$2', [venueId, runId]), '55000');
    await rejected('provenance delete forbidden', () => db.query('DELETE FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2', [venueId, runId]), '55000');
    const sql204 = await readFile(new URL('../migrations/204_payroll_refund_aware_run_provenance.sql', import.meta.url), 'utf8');
    await rolledBack(async () => {
      await db.query(sql204); await db.query(sql204);
      assert.deepEqual(await state(), baseline, '204 replay must preserve populated immutable v2 snapshots and provenance');
    });
    checks++;
    const member = savedEvidence.calculatorReplay.result.employees.find(row => row.amountCents > 0);
    assert.ok(member, 'initial v2 positive employee required');
    const employee = verified.prepared.snapshotInput.employees.find(row => row.id === member.employeeId);
    assert.ok(employee);
    const cents = BigInt(member.amountCents);
    const entry = { id: randomUUID(), venue_id: venueId, user_id: member.employeeId,
      period_from: originalRun.period_from, period_to: originalRun.period_to, amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
      status: 'approved', calculation_run_id: runId, calculation_provenance_sha256: originalProvenance.evidence_sha256,
      calculation_gross_cents: member.amountCents, materialized_by: originalRun.created_by, materialized_by_name: originalRun.created_by_name,
      materialized_at: new Date().toISOString(), employee_name_snapshot: employee.name,
      calculation_scheme_name_snapshot: savedEvidence.schemeSnapshot.name };
    await rejected('207 must keep v2 approval disabled', () => insert(db, 'payroll_entries', Object.keys(entry), entry),
      '23514', 'payroll_run_payout_not_enabled');
    assert.deepEqual(await state(), baseline);
    return { status: 'passed', checks, transactionMode: 'rollback_only',
      deferredCommitGuardsChecked: true, migrationReplayCount: 2, entryApproval: 'blocked', financialRowsChanged: false };
  } finally { db.release(); }
}
