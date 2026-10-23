import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const file = name => path.join(root, name);
const ids = { venue: randomUUID(), owner: randomUUID(), original: randomUUID(), employeeA: randomUUID(), employeeB: randomUUID() };
const sourceWatermark = 'a'.repeat(64), oldChecksum = 'b'.repeat(64), oldStateA = 'c'.repeat(64), oldStateB = 'd'.repeat(64);
const scheme = { versionId: randomUUID(), currency: 'RUB', name: 'Refund-aware v2', versionNo: 3 };
const makeEvidence = (runId, amountA, amountB, inputWatermark) => ({ schemaVersion: 2,
  capabilityVersion: 'employee_attributed_remaining_net_refund_v2', venueId: ids.venue, runId,
  schemeVersionId: scheme.versionId, period: { from: '2026-10-01', to: '2026-10-31' }, currency: 'RUB', venueTimezone: 'Asia/Yekaterinburg',
  inputWatermark, snapshotInputWatermark: hash(`snapshot:${runId}`), schemeSnapshot: scheme,
  sourceEvidence: { schemaVersion: 1 }, calculatorReplay: { result: { employees: [
    { employeeId: ids.employeeA, amountCents: amountA }, { employeeId: ids.employeeB, amountCents: amountB }
  ] } }, totalAmountCents: amountA + amountB });
const originalEvidence = makeEvidence(ids.original, 10000, 0, sourceWatermark);
const saved = { header: { capabilityVersion: 'employee_attributed_remaining_net_refund_v2' }, evidence: originalEvidence };
const oldRows = [
  { id: randomUUID(), user_id: ids.employeeA, status: 'draft', calculation_gross_cents: '10000', net_cents: '10000',
    finance_category_id: randomUUID(), calculation_provenance_sha256: oldChecksum },
  { id: randomUUID(), user_id: ids.employeeB, status: 'draft', calculation_gross_cents: '0', net_cents: '0',
    finance_category_id: null, calculation_provenance_sha256: oldChecksum }
].sort((a, b) => a.user_id.localeCompare(b.user_id));

const sourceFence = require(file('payroll-source-fence.js'));
const cacheModule = (name, exports) => { const filename = require.resolve(file(name)); require.cache[filename] = { id: filename, filename, loaded: true, exports }; };
cacheModule('payroll-saved-run-reader.js', { async loadSavedRunEvidenceInTransaction() { return structuredClone(saved); } });
cacheModule('payroll-calculation-entry-lifecycle.js', {
  async getPayrollCalculationEntryState(_db, _actor, entryId) {
    const row = oldRows.find(item => item.id === entryId);
    return { entry: { status: row.status, grossCents: Number(row.calculation_gross_cents), amountCents: Number(row.net_cents) },
      stateHash: row.id === oldRows[0].id ? oldStateA : oldStateB,
      ledgerHash: hash(`ledger:${row.user_id}`), allowedActions: row.status === 'draft' ? ['cancel'] : [] };
  },
  async transitionPayrollCalculationEntry(_db, _actor, entryId, input) {
    const row = oldRows.find(item => item.id === entryId);
    assert.equal(input.action, 'cancel'); row.status = 'cancelled';
    return { action: 'cancel', entry: { status: 'cancelled' } };
  }
});
let persisted = 0, materialized = 0, persistedKeys = null;
cacheModule('payroll-snapshot-persistence.js', { async persistPayrollSnapshotBundleInTransaction(_db, bundle) {
  persisted++; persistedKeys = Object.keys(bundle).sort();
} });
cacheModule('payroll-calculation-entry-bridge.js', { async materializeCalculationEntry(_db, _actor, request) {
  materialized++;
  const employee = [ { employeeId: ids.employeeA, amountCents: 10000 }, { employeeId: ids.employeeB, amountCents: 0 } ]
    .find(row => row.employeeId === request.employeeId);
  return { currentEntry: { id: randomUUID(), userId: employee.employeeId, status: 'draft', amountCents: employee.amountCents,
    financeCategoryId: request.financeCategoryId } };
} });
const api = require(file('payroll-unpaid-run-supersession.js'));

const journal = new Map();
const sqlWrites = [];
const db = { async query(sql, params = []) {
  const q = sql.trim();
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) sqlWrites.push(q);
  if (/^SELECT pg_advisory_lock/.test(q)) return { rows: [] };
  if (/^SELECT pg_advisory_unlock/.test(q)) return { rows: [{ unlocked: true }] };
  if (/^SELECT full_name FROM users/.test(q)) return { rows: [{ full_name: 'Owner' }] };
  if (/FROM payroll_calculation_runs/.test(q)) return { rows: [{ id: ids.original, venue_id: ids.venue, scheme_version_id: scheme.versionId,
    period_from: '2026-10-01', period_to: '2026-10-31', currency: 'RUB', venue_timezone: 'Asia/Yekaterinburg',
    engine_version: 'payroll-verified-remaining-net-v2', input_watermark: sourceWatermark,
    input_checksum: oldChecksum, supersedes_run_id: null, status: 'ready' }] };
  if (/FROM payroll_entries/.test(q)) return { rows: structuredClone(oldRows) };
  if (/FROM payroll_run_supersession_requests/.test(q) && /idempotency_key/.test(q)) {
    const row = journal.get(params[1]); return { rows: row ? [row] : [] };
  }
  if (/FROM payroll_run_supersession_requests/.test(q)) return { rows: [] };
  if (/INSERT INTO payroll_run_supersession_requests/.test(q)) {
    const [id, venue_id, original_run_id, replacement_run_id, idempotency_key, request_hash, plan_hash,
      plan_payload, response_payload, response_sha256, created_by, created_by_name, reason] = params;
    journal.set(idempotency_key, { id, venue_id, original_run_id, replacement_run_id, idempotency_key, request_hash,
      plan_hash, plan_payload, response_payload, response_sha256, created_by, created_by_name, reason });
    return { rows: [] };
  }
  return { rows: [] };
} };
const actor = { venueId: ids.venue, userId: ids.owner };
const inFencedWrite = async action => {
  const release = await sourceFence.beginPayrollVerifiedRunSourceTransaction(db, ids.venue);
  try {
    const result = await action();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await release(); }
};
const callbacks = {
  async buildReplacement(_db, _actor, _saved, runId) {
    const evidence = makeEvidence(runId, 10000, 0, sourceWatermark);
    const evidencePayload = canonical(evidence), evidenceSha = hash(evidencePayload);
    return { run: { id: runId, venue_id: ids.venue, scheme_version_id: scheme.versionId, period_from: '2026-10-01',
      period_to: '2026-10-31', currency: 'RUB', venue_timezone: 'Asia/Yekaterinburg', status: 'ready',
      engine_version: 'payroll-verified-remaining-net-v2', supersedes_run_id: ids.original, input_watermark: sourceWatermark,
      input_checksum: evidenceSha }, input: { result: { schemeVersionId: scheme.versionId, currency: 'RUB',
      periodFrom: '2026-10-01', periodTo: '2026-10-31', employees: evidence.calculatorReplay.result.employees } },
      provenance: { venue_id: ids.venue, run_id: runId, schema_version: 2,
        capability_version: 'employee_attributed_remaining_net_refund_v2', evidence_payload: evidencePayload,
        evidence_sha256: evidenceSha, total_amount_cents: 10000 } };
  },
  async checkFreshness() { return { status: 'current' }; }
};

const preview = await inFencedWrite(() => api.previewUnpaidRunSupersession(db, actor, ids.original, callbacks));
assert.equal(preview.monetaryWrites, false);
assert.equal(preview.planHash, hash(canonical(preview.plan)));
assert.equal(sqlWrites.length, 0, 'preview performs no monetary or journal writes');
const stale = { expectedPlanHash: '0'.repeat(64), reason: 'Correction after returns', idempotencyKey: 'supersession-stale' };
await assert.rejects(() => inFencedWrite(() => api.commitUnpaidRunSupersession(db, actor, ids.original, stale, callbacks)), /plan_stale/);
assert.equal(persisted, 0); assert.equal(materialized, 0); assert(oldRows.every(row => row.status === 'draft'));

const command = { expectedPlanHash: preview.planHash, reason: 'Correction after returns', idempotencyKey: 'supersession-commit-1' };
const committed = await inFencedWrite(() => api.commitUnpaidRunSupersession(db, actor, ids.original, command, callbacks));
assert.equal(committed.replayed, false); assert.equal(committed.entries.length, 2);
assert.equal(committed.entries.find(row => row.employeeId === ids.employeeA)?.amountCents, 10000);
assert.equal(committed.entries.find(row => row.employeeId === ids.employeeB)?.amountCents, 0);
assert(oldRows.every(row => row.status === 'cancelled'));
assert.equal(persisted, 1); assert.equal(materialized, 2);
assert.deepEqual(persistedKeys, ['input', 'provenance', 'run'], 'snapshot persistence receives only the strict supported bundle keys');
const retry = await inFencedWrite(() => api.commitUnpaidRunSupersession(db, actor, ids.original, command, callbacks));
assert.equal(retry.replayed, true); assert.equal(retry.journalId, committed.journalId);
assert.equal(persisted, 1); assert.equal(materialized, 2, 'exact retry returns receipt without repeating effects');

console.log('payroll unpaid run supersession contract: PASS');
