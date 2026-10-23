import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
import { addProvenance } from './payroll-provenance-storage-fixture.mjs';
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { calculatePayrollScheme } = require('../payroll-schemes');
const { buildCalculatorReplay } = require('../payroll-calculator-replay');
const { persistPayrollSnapshotBundleInTransaction } = require('../payroll-snapshot-persistence');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const pool = new Pool({ connectionString: target.url.href, max: 5 });
const ids = Object.fromEntries(['org', 'venue', 'owner', 'scheme', 'version', 'product', 'account', 'otherVenue', 'otherOwner'].map(k => [k, randomUUID()]));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const insert = async (db, table, row) => {
  const names = Object.keys(row); return db.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
};
const fail = (promise, code, message) => assert.rejects(promise, error => error.code === code && (!message || error.message.includes(message)));
const clients = [];
let checks = 0;
async function fixture(employeeId = randomUUID(), rateBps = 1000) {
  const prior = (await pool.query('SELECT id FROM users WHERE id=$1', [employeeId])).rows[0];
  if (!prior) await insert(pool, 'users', { id: employeeId, venue_id: ids.venue, organization_id: ids.org, full_name: 'Frozen Employee', login: `bridge-${employeeId}`, role: 'bartender' });
  const orderId = randomUUID(), itemId = randomUUID(), runId = randomUUID();
  await insert(pool, 'orders', { id: orderId, venue_id: ids.venue, status: 'open', opened_by: ids.owner });
  await insert(pool, 'order_items', { id: itemId, order_id: orderId, product_id: ids.product, quantity: 1, unit_price: 100, sales_employee_id: employeeId, sold_at: '2026-10-01T12:00:00Z' });
  const scenario = { scheme: { id: ids.scheme, versionId: ids.version, name: 'Frozen scheme', currency: 'RUB', mode: 'percent_only', applyMilestones: false, roleParameters: { bar: { stableRateBps: rateBps } } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: employeeId }], attendance: [], sourceEvidence: {},
    roleAssignments: [{ employeeId, roleId: 'bar', effectiveFrom: '2026-10-01' }],
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'synthetic' },
    sales: [{ id: itemId, employeeId, menuItemId: ids.product, department: 'bar', date: '2026-10-01', commissionBaseCents: 10000, turnoverCents: 10000 }] };
  const result = calculatePayrollScheme(scenario); assert.equal(result.status, 'ready');
  const input = { venueId: ids.venue, runId, venueTimezone: 'UTC', attendance: [], employees: [{ id: employeeId, name: 'Frozen Employee' }], result,
    sourceLines: [{ id: itemId, orderId, orderItemId: itemId, employeeId, menuItemId: ids.product, menuItemName: 'Tea', department: 'bar', roleId: 'bar', localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z', quantity: '1', grossCents: 10000, discountCents: 0, refundCents: 0, commissionBaseCents: 10000, turnoverCents: 10000 }] };
  const run = { id: runId, venue_id: ids.venue, scheme_version_id: ids.version, period_from: '2026-10-01', period_to: '2026-10-01', status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds', eligible_line_count: 1, unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: 'synthetic', input_checksum: 'a'.repeat(64), engine_version: 'synthetic', idempotency_key: runId, created_by: ids.owner, created_by_name: 'Owner', venue_timezone: 'UTC', currency: 'RUB', milestone_evidence_version: 0 };
  const bundle = addProvenance({ run, input });
  const evidence = JSON.parse(bundle.provenance.evidence_payload);
  evidence.schemeSnapshot = scenario.scheme; evidence.calculatorReplay = buildCalculatorReplay(scenario, result);
  bundle.provenance.evidence_payload = canonical(evidence);
  bundle.provenance.evidence_sha256 = sha(bundle.provenance.evidence_payload);
  bundle.run.input_checksum = bundle.provenance.evidence_sha256;
  const db = await pool.connect();
  try { await db.query('BEGIN'); await persistPayrollSnapshotBundleInTransaction(db, bundle); await db.query('COMMIT'); }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  return { employeeId, runId, grossCents: result.employees[0].amountCents, hash: bundle.provenance.evidence_sha256 };
}
const linkedRow = f => ({ id: randomUUID(), venue_id: ids.venue, user_id: f.employeeId, period_from: '2026-10-01', period_to: '2026-10-01', amount: (f.grossCents / 100).toFixed(2), status: 'draft', calculation_run_id: f.runId, calculation_provenance_sha256: f.hash, calculation_gross_cents: f.grossCents, materialized_by: ids.owner, materialized_by_name: 'Owner', materialized_at: new Date().toISOString(), employee_name_snapshot: 'Frozen Employee', calculation_scheme_name_snapshot: 'Frozen scheme' });
// Actual202 INSERT proof, actual public205/203 constraints. Source freshness
// below is explicitly synthetic structural evidence, NOT source acceptance.
const migration = readFileSync(new URL('../migrations/205_payroll_calculation_entry_lifecycle.sql', import.meta.url), 'utf8');
const legacyRow = (expense = null) => ({ id: randomUUID(), venue_id: ids.venue, user_id: ids.owner, period_from: '2025-01-01', period_to: '2025-01-01', amount: '1.00', status: 'draft', expense_id: expense });
async function connect() { const db = new Client({ connectionString: target.url.href }); await db.connect(); clients.push(db); return db; }
async function reject(db, fn, message, code = '23514') {
  await db.query('BEGIN');
  try { await fail((async () => { await fn(); await db.query('COMMIT'); })(), code, message); checks++; }
  finally { await db.query('ROLLBACK'); }
}
async function entryFixture(rate = 1000) { const f = await fixture(randomUUID(), rate); return (await insert(pool, 'payroll_entries', linkedRow(f))).rows[0]; }
// pg's DATE parser constructs local midnight; UTC conversion would shift the
// calendar day on the developer's UTC+05 machine. The actual writer selects
// these columns as text, and this fixture preserves the same calendar value.
const day = value => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : value;
const ledgerHash = 'e'.repeat(64);
function transitionRow(entry, action, override = {}) {
  const gross = Number(entry.calculation_gross_cents), net = Math.round(Number(entry.amount) * 100);
  const proof = { schemaVersion: 1, proofKind: 'current_transition', venueId: entry.venue_id, entryId: entry.id,
    employeeId: entry.user_id, runId: entry.calculation_run_id, entryStatus: entry.status, origin: 'calculation_run', currency: 'RUB',
    periodFrom: day(entry.period_from), periodTo: day(entry.period_to), grossCents: gross, netCents: net, protectedFixedCents: 0,
    evidenceHashes: { provenanceSha256: entry.calculation_provenance_sha256 },
    freshness: { status: 'current', checkedAt: new Date().toISOString() }, corrections: { ledgerHash, netCents: net } };
  const payload = action === 'cancel' ? null : canonical(proof);
  return { id: randomUUID(), venue_id: entry.venue_id, entry_id: entry.id, action, from_status: entry.status,
    to_status: { approve: 'approved', pay: 'paid', cancel: 'cancelled' }[action], employee_id: entry.user_id,
    calculation_run_id: entry.calculation_run_id, provenance_sha256: entry.calculation_provenance_sha256,
    gross_cents: gross, net_cents: net, protected_fixed_cents: 0, ledger_hash: ledgerHash,
    source_proof_payload: payload, source_proof_sha256: payload ? sha(payload) : null,
    settlement_kind: action === 'pay' ? (net === 0 ? 'zero' : 'positive_expense') : null,
    expense_id: null, payment_date: action === 'pay' ? '2026-10-23' : null, payment_method: null,
    finance_account_id: null, finance_account_name_snapshot: null, shift_id: null,
    reason: action === 'cancel' ? 'Owner cancelled draft' : null, created_by: ids.owner, created_by_name: 'Owner', ...override };
}
async function updateFromTransition(db, row) {
  // Read the textual timestamp to preserve all precision, as the real writer.
  const time = (await db.query('SELECT created_at::text t FROM payroll_calculation_entry_transitions WHERE id=$1', [row.id])).rows[0].t;
  if (row.action === 'approve') await db.query("UPDATE payroll_entries SET status='approved',approved_at=$2,approved_by=$3 WHERE id=$1", [row.entry_id, time, row.created_by]);
  else if (row.action === 'pay') await db.query("UPDATE payroll_entries SET status='paid',paid_at=$2,paid_by=$3,payment_date=$4,expense_id=$5 WHERE id=$1", [row.entry_id, time, row.created_by, row.payment_date, row.expense_id]);
  else await db.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=$2,cancelled_by=$3,cancellation_reason=$4 WHERE id=$1", [row.entry_id, time, row.created_by, row.reason]);
}
async function expense(db, entry, extra = {}) {
  return (await insert(db, 'expenses', { id: randomUUID(), venue_id: ids.venue, category: 'Зарплата', category_id: null,
    amount: entry.amount, expense_date: '2026-10-23', source: 'payroll', created_by: ids.owner, payment_method: 'bank_transfer',
    finance_account_id: ids.account, finance_account_name_snapshot: 'QA bank', shift_id: null, ...extra })).rows[0];
}
function payFields(expense) { return { expense_id: expense.id, payment_method: expense.payment_method,
  finance_account_id: expense.finance_account_id, finance_account_name_snapshot: expense.finance_account_name_snapshot, shift_id: expense.shift_id }; }
async function journal(db, transition, extra = {}) {
  const payload = canonical({ schemaVersion: 1, transitionId: transition.id, action: transition.action, replayed: false,
    entry: { id: transition.entry_id, status: transition.to_status, amountCents: Number(transition.net_cents),
      calculationRunId: transition.calculation_run_id, provenanceSha256: transition.provenance_sha256 } });
  const row = { id: randomUUID(), venue_id: transition.venue_id, idempotency_key: `lifecycle-${randomUUID()}`, request_hash: 'f'.repeat(64),
    transition_id: transition.id, created_by: transition.created_by, response_payload: payload, response_hash: sha(payload), ...extra };
  await insert(db, 'payroll_calculation_entry_transition_requests', row); return row;
}
async function act(db, entry, action, extra = {}, write = true) {
  let patch = extra;
  if (action === 'pay' && Number(entry.amount) > 0 && !extra.expense_id) patch = { ...payFields(await expense(db, entry, { payroll_calculation_entry_id: entry.id })), ...extra };
  const row = (await insert(db, 'payroll_calculation_entry_transitions', transitionRow(entry, action, patch))).rows[0];
  if (write) await updateFromTransition(db, row);
  const request = await journal(db, row);
  return { row, request };
}
async function committed(entry, action) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await act(db, entry, action); await db.query('COMMIT'); checks++;
    return { ...result, entry: (await pool.query('SELECT * FROM payroll_entries WHERE id=$1', [entry.id])).rows[0] };
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
try {
  assertQaDatabaseIdentity((await pool.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0], target.database, Number(target.url.port));
  await pool.query(migration); await pool.query(migration); checks++;
  await insert(pool, 'organizations', { id: ids.org, name: 'Lifecycle QA', slug: `lifecycle-${ids.org}`, timezone: 'UTC' });
  for (const venue of [ids.venue, ids.otherVenue]) await insert(pool, 'venues', { id: venue, organization_id: ids.org, name: 'Lifecycle QA', timezone: 'UTC' });
  for (const [id, venue] of [[ids.owner, ids.venue], [ids.otherOwner, ids.otherVenue]]) await insert(pool, 'users', { id, venue_id: venue, organization_id: ids.org, full_name: 'Owner', login: `lifecycle-${id}`, role: 'owner' });
  await insert(pool, 'products', { id: ids.product, venue_id: ids.venue, name: 'Tea', category: 'bar', sale_price: 100 });
  await insert(pool, 'payroll_schemes', { id: ids.scheme, venue_id: ids.venue, name: 'Frozen scheme', created_by: ids.owner, created_by_name: 'Owner' });
  await insert(pool, 'payroll_scheme_versions', { id: ids.version, venue_id: ids.venue, scheme_id: ids.scheme, version_no: 1, mode: 'percent_only', effective_from: '2026-10-01', effective_to: '2026-10-31', created_by: ids.owner, created_by_name: 'Owner' });
  await pool.query("UPDATE payroll_scheme_versions SET status='active',status_changed_by=$1,status_changed_by_name='Owner',status_changed_at=now() WHERE id=$2", [ids.owner, ids.version]);
  await insert(pool, 'finance_accounts', { id: ids.account, venue_id: ids.venue, code: 'lifecycle-bank', name: 'QA bank', kind: 'bank', allowed_payment_methods: ['bank_transfer'], created_by: ids.owner });
  const db = await connect(), draft = await entryFixture();
  await reject(db, () => db.query("UPDATE payroll_entries SET status='approved',approved_at=now(),approved_by=$2 WHERE id=$1", [draft.id, ids.owner]), 'transition_required');
  await reject(db, () => act(db, draft, 'approve', {}, false), 'transition_incomplete');
  await reject(db, () => db.query('UPDATE payroll_entries SET amount=9 WHERE id=$1', [draft.id]), 'net_reconciliation_required');
  await reject(db, () => db.query('DELETE FROM payroll_entries WHERE id=$1', [draft.id]), 'immutable', '55000');
  const altered = transitionRow(draft, 'approve'), alteredProof = JSON.parse(altered.source_proof_payload);
  alteredProof.corrections.netCents--;
  altered.source_proof_payload = canonical(alteredProof); altered.source_proof_sha256 = sha(altered.source_proof_payload);
  await reject(db, () => insert(db, 'payroll_calculation_entry_transitions', altered), 'source_proof_mismatch');
  const stale = transitionRow(draft, 'approve'), staleProof = JSON.parse(stale.source_proof_payload);
  staleProof.freshness.checkedAt = '2020-01-01T00:00:00.000Z';
  stale.source_proof_payload = canonical(staleProof); stale.source_proof_sha256 = sha(stale.source_proof_payload);
  await reject(db, () => insert(db, 'payroll_calculation_entry_transitions', stale), 'source_proof_stale');
  for (const patch of [{ employee_id: ids.owner }, { net_cents: 999 }, { protected_fixed_cents: 1 }, { created_by: ids.otherOwner }, { created_by: draft.user_id, created_by_name: 'Frozen Employee' }, { venue_id: ids.otherVenue }, { transaction_id: 1 }]) {
    await reject(db, () => act(db, draft, 'approve', patch), null);
  }
  //205 preserves frozen classification on a category rename, while118's
  // active/type validation and all legacy semantics remain in force.
  const categoryId = randomUUID();
  await insert(pool, 'finance_categories', { id: categoryId, venue_id: ids.venue, name: 'Payroll frozen category', kind: 'expense' });
  const classified = (await insert(pool, 'payroll_entries', { ...linkedRow(await fixture()), finance_category_id: categoryId })).rows[0];
  assert.equal(classified.finance_category_name_snapshot, 'Payroll frozen category'); checks++;
  await pool.query('UPDATE finance_categories SET name=$2 WHERE id=$1', [categoryId, 'Payroll renamed category']);
  const classifiedApproved = await committed(classified, 'approve');
  assert.equal(classifiedApproved.entry.finance_category_name_snapshot, 'Payroll frozen category'); checks++;
  // Pay keeps the exact approved category snapshot even if the category is now archived.
  await pool.query('UPDATE finance_categories SET active=false WHERE id=$1', [categoryId]);
  await db.query('BEGIN');
  try {
    const payment = await expense(db, classifiedApproved.entry, { payroll_calculation_entry_id: classified.id,
      category_id: categoryId, category: classified.finance_category_name_snapshot });
    await act(db, classifiedApproved.entry, 'pay', payFields(payment));
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  assert.equal((await pool.query('SELECT category FROM expenses WHERE payroll_calculation_entry_id=$1', [classified.id])).rows[0].category, 'Payroll frozen category'); checks++;
  await pool.query('UPDATE finance_categories SET active=true WHERE id=$1', [categoryId]);
  const inactiveDraft = (await insert(pool, 'payroll_entries', { ...linkedRow(await fixture()), finance_category_id: categoryId })).rows[0];
  await pool.query('UPDATE finance_categories SET active=false WHERE id=$1', [categoryId]);
  const beforeInactive = (await pool.query('SELECT (SELECT count(*) FROM payroll_calculation_entry_transitions)::int transitions,(SELECT count(*) FROM payroll_calculation_entry_transition_requests)::int requests')).rows[0];
  await reject(db, () => act(db, inactiveDraft, 'approve'), 'invalid_payroll_finance_category');
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM payroll_calculation_entry_transitions)::int transitions,(SELECT count(*) FROM payroll_calculation_entry_transition_requests)::int requests')).rows[0], beforeInactive);
  const inactiveAfter = (await pool.query('SELECT status,finance_category_name_snapshot FROM payroll_entries WHERE id=$1', [inactiveDraft.id])).rows[0];
  assert.deepEqual(inactiveAfter, { status: 'draft', finance_category_name_snapshot: 'Payroll renamed category' }); checks++;
  await reject(db, () => act(db, inactiveDraft, 'cancel', { created_by: inactiveDraft.user_id, created_by_name: 'Frozen Employee' }), 'actor_invalid');
  await committed(inactiveDraft, 'cancel');
  // A legacy draft still refreshes its category name on approval as in118.
  await pool.query('UPDATE finance_categories SET active=true WHERE id=$1', [categoryId]);
  const classifiedLegacy = (await insert(pool, 'payroll_entries', { ...legacyRow(), finance_category_id: categoryId })).rows[0];
  await pool.query('UPDATE finance_categories SET name=$2 WHERE id=$1', [categoryId, 'Payroll latest category']);
  await pool.query("UPDATE payroll_entries SET status='approved' WHERE id=$1", [classifiedLegacy.id]);
  assert.equal((await pool.query('SELECT finance_category_name_snapshot FROM payroll_entries WHERE id=$1', [classifiedLegacy.id])).rows[0].finance_category_name_snapshot, 'Payroll latest category'); checks++;
  const approved = await committed(draft, 'approve');
  await reject(db, () => db.query('UPDATE payroll_entries SET amount=9 WHERE id=$1', [draft.id]), 'immutable', '55000');
  await reject(db, () => act(db, approved.entry, 'pay', { payment_method: 'cash' }), null);
  const legacyExpense = await expense(pool, approved.entry);
  await reject(db, () => act(db, approved.entry, 'pay', payFields(legacyExpense)), 'expense_mismatch');
  await reject(db, async () => {
    // xmin alone would falsely accept this updated historical expense.
    await db.query('UPDATE expenses SET amount=amount WHERE id=$1', [legacyExpense.id]);
    await act(db, approved.entry, 'pay', payFields(legacyExpense));
  }, 'expense_mismatch');
  await reject(db, () => db.query('UPDATE expenses SET payroll_calculation_entry_id=$2 WHERE id=$1', [legacyExpense.id, approved.entry.id]), 'marker_insert_only', '55000');
  await reject(db, () => expense(db, approved.entry, { payroll_calculation_entry_id: approved.entry.id }), 'settlement_incomplete');
  await reject(db, async () => {
    const nextExpense = await expense(db, approved.entry, { amount: 9, payroll_calculation_entry_id: approved.entry.id });
    await act(db, approved.entry, 'pay', payFields(nextExpense));
  }, 'expense_mismatch');
  await reject(db, async () => {
    const nextExpense = await expense(db, approved.entry, { payroll_calculation_entry_id: approved.entry.id });
    await insert(db, 'payroll_entries', legacyRow(nextExpense.id));
    await act(db, approved.entry, 'pay', payFields(nextExpense));
  }, 'expense_already_owned');
  // Expense created after an already-established RR snapshot is not visible;
  // the narrow guard rejects before the FK's fresh visibility check can admit it.
  const oldSnapshot = await connect(); await oldSnapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await oldSnapshot.query('SELECT count(*) FROM expenses');
  const paid = await committed(approved.entry, 'pay');
  await fail(insert(oldSnapshot, 'payroll_entries', legacyRow(paid.entry.expense_id)), '23514', 'expense_not_visible'); checks++;
  await oldSnapshot.query('ROLLBACK');
  await reject(db, () => insert(db, 'payroll_entries', legacyRow(paid.entry.expense_id)), 'expense_already_owned');
  await reject(db, () => db.query('UPDATE expenses SET amount=1 WHERE id=$1', [paid.entry.expense_id]), 'expense_immutable', '55000');
  await reject(db, () => db.query('DELETE FROM expenses WHERE id=$1', [paid.entry.expense_id]), 'expense_immutable', '55000');
  await reject(db, () => db.query("UPDATE payroll_entries SET status='cancelled' WHERE id=$1", [paid.entry.id]), 'immutable', '55000');
  for (const table of ['payroll_calculation_entry_transitions', 'payroll_calculation_entry_transition_requests']) {
    await reject(db, () => db.query(`UPDATE ${table} SET created_by=created_by`), 'history_immutable', '55000');
    await reject(db, () => db.query(`DELETE FROM ${table}`), 'history_immutable', '55000');
    await reject(db, () => db.query(`TRUNCATE ${table} CASCADE`), 'history_immutable', '55000');
  }
  await reject(db, () => insert(db, 'payroll_calculation_entry_transition_requests', { ...paid.request, id: randomUUID() }), null, '23505');
  assert.equal((await pool.query('SELECT response_payload FROM payroll_calculation_entry_transition_requests WHERE id=$1', [approved.request.id])).rows[0].response_payload, approved.request.response_payload); checks++;
  // Zero settlement is paid history, with no fake expense or account metadata.
  const zero = await entryFixture(0), zeroApproved = await committed(zero, 'approve');
  const expenseCount = (await pool.query('SELECT count(*)::int n FROM expenses')).rows[0].n;
  const zeroPaid = await committed(zeroApproved.entry, 'pay');
  assert.equal(zeroPaid.row.settlement_kind, 'zero'); assert.equal(zeroPaid.entry.expense_id, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses')).rows[0].n, expenseCount); checks++;
  await reject(db, () => db.query('UPDATE payroll_entries SET payment_date=$2 WHERE id=$1', [zero.id, '2026-10-24']), 'immutable', '55000');
  const cancellable = await entryFixture(), cancelled = await committed(cancellable, 'cancel');
  assert.equal(cancelled.entry.amount, cancellable.amount); checks++;
  await reject(db, () => db.query("UPDATE payroll_entries SET status='draft' WHERE id=$1", [cancellable.id]), 'immutable', '55000');
  const approvedToCancel = await committed(await entryFixture(), 'approve');
  await committed(approvedToCancel.entry, 'cancel');
  // A statement/commit failure must roll back new financial and audit rows.
  const rollbackEntry = await committed(await entryFixture(), 'approve');
  const before = (await pool.query('SELECT (SELECT count(*) FROM expenses)::int expenses,(SELECT count(*) FROM payroll_calculation_entry_transitions)::int transitions')).rows[0];
  await reject(db, async () => { await act(db, rollbackEntry.entry, 'pay'); await db.query('SELECT 1/0'); }, null, '22012');
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM expenses)::int expenses,(SELECT count(*) FROM payroll_calculation_entry_transitions)::int transitions')).rows[0], before); checks++;
  // Legacy payroll components keep their old transition and duplicate-reference
  // contract when the expense belongs to no205 settlement.
  const oldExpense = await expense(pool, rollbackEntry.entry);
  const legacyA = (await insert(pool, 'payroll_entries', legacyRow(oldExpense.id))).rows[0];
  await insert(pool, 'payroll_entries', legacyRow(oldExpense.id));
  await pool.query("UPDATE payroll_entries SET status='approved' WHERE id=$1", [legacyA.id]); checks++;
  await pool.query(migration); checks++;
  console.log(`PASS payroll calculation entry lifecycle PostgreSQL QA (${checks} checks; actual public202/203/205 schema; synthetic freshness proof, NOT current POS source/HTTP acceptance)`);
} finally {
  for (const db of clients) { try { await db.query('ROLLBACK'); } catch {} await db.end(); }
  await pool.end();
}
