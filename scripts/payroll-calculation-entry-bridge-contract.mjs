import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence');
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1), userId = id(2), runId = id(3), employeeId = id(4), entryId = id(5);
const principal = { venueId, userId }, actor = { ...principal, name: 'Owner' };
const input = { employeeId, financeCategoryId: null, idempotencyKey: 'entry-contract-001' };
const LOCK = 'SELECT pg_advisory_lock(hashtextextended($1,0))';
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked';
const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE';
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const error = (code, status = 409) => Object.assign(new Error(code), { code, status });
function isolated(path, seams) {
  const filename = require.resolve(path), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}

// Behavioral integration of the actual bridge, service wrapper, and source fence.
// Saved-source reader/replay/freshness dependencies are module-local seams; SQL
// results are a fake. This does not establish PostgreSQL triggers, rollback,
// exclusion concurrency, financial accounting, or actual source freshness.
function fixture(options = {}) {
  const calls = [], releases = [], entries = [], requests = [];
  let connects = 0;
  const settings = { authorized: true, cents: '125', replayAmount: 125, freshness: 'current', ...options };
  const row = () => ({ id: entryId, user_id: employeeId, status: 'draft', calculation_run_id: runId,
    calculation_provenance_sha256: 'a'.repeat(64), calculation_gross_cents: settings.cents, net_cents: settings.cents,
    period_from: '2026-09-01', period_to: '2026-09-30', employee_name_snapshot: 'Frozen employee',
    calculation_scheme_name_snapshot: 'Frozen scheme', finance_category_id: null });
  if (settings.existing) entries.push({ ...row(), ...settings.existing });
  const step = name => { calls.push(name); if (settings.failAt === name) throw settings.failure || error('injected_failure'); };
  const client = {
    async query(sql, values = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if ([LOCK, UNLOCK, BEGIN, 'COMMIT', 'ROLLBACK', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'].includes(text)) {
        step(text);
        if ([LOCK, UNLOCK].includes(text)) assert.deepEqual(values, [`payroll-official-source-v1:${venueId}`]);
        if (text === UNLOCK && settings.unlockError) throw settings.unlockError;
        if (text === 'ROLLBACK' && settings.rollbackError) throw settings.rollbackError;
        return { rows: text === UNLOCK ? [{ unlocked: true }] : [] };
      }
      if (text.startsWith('SELECT id, full_name AS name FROM users')) {
        step('owner'); assert.deepEqual(values, [userId, venueId]);
        assert.match(text, /role = 'owner' AND is_active = true AND deleted_at IS NULL/);
        if (fence.hasPayrollVerifiedWriteSnapshot(client, venueId)) assert.match(text, /FOR SHARE$/);
        return { rows: settings.authorized ? [{ id: userId, name: actor.name }] : [] };
      }
      assert.equal(values[0], venueId, 'every entry/request query must use authenticated tenant');
      if (text.startsWith('SELECT request_hash')) {
        step('requestReplay'); return { rows: requests.filter(r => r.key === values[1]) };
      }
      if (text.startsWith('SELECT ') && text.includes('FROM payroll_entries')) {
        if (text.includes('AND id=$2')) { step('currentEntry'); return { rows: entries.filter(r => r.id === values[1]) }; }
        step('existingEntry'); assert.equal(values[1], runId);
        return { rows: entries.filter(r => r.calculation_run_id === values[1] && (values.length === 2 || r.user_id === values[2])) };
      }
      if (text.startsWith('SELECT sum(d.final_amount')) {
        step('snapshotSum'); assert.deepEqual(values, [venueId, runId, employeeId]);
        return { rows: settings.missingSnapshot ? [] : [{ cents: settings.cents, employee_name: 'Frozen employee', evidence_sha256: 'a'.repeat(64) }] };
      }
      if (text.startsWith('INSERT INTO payroll_entries')) {
        step('insertEntry'); assert.equal(fence.hasPayrollVerifiedWriteSnapshot(client, venueId), true);
        assert.match(text, /VALUES \(\$1,\$2,NULL,\$3,\$4,\$5,'draft'/);
        assert.doesNotMatch(text.split(' RETURNING ')[0], /expense_id|payment_date|paid_at|approved_at/,
          'materialization writes no approval or settlement fields; RETURNING may expose their current values');
        assert.deepEqual(values.slice(0, 10), [venueId, employeeId, '2026-09-01', '2026-09-30',
          `${BigInt(settings.replayAmount) / 100n}.${String(BigInt(settings.replayAmount) % 100n).padStart(2, '0')}`,
          null, runId, 'a'.repeat(64), settings.replayAmount, userId]);
        entries.push(row()); return { rows: [entries.at(-1)] };
      }
      if (text.startsWith('INSERT INTO payroll_calculation_entry_requests')) {
        step('saveRequest'); assert.equal(fence.hasPayrollVerifiedWriteSnapshot(client, venueId), true);
        const [venue, key, request_hash, createdBy, entry_id, response_payload, response_sha256] = values;
        assert.equal(createdBy, userId); assert.equal(sha(response_payload), response_sha256);
        assert.deepEqual(Object.keys(JSON.parse(response_payload)), ['schemaVersion', 'entry', 'replayed', 'existing'],
          'every persisted request retains migration202 receipt fields only');
        requests.push({ venue, key, request_hash, entry_id, response_payload, response_sha256 }); return { rows: [] };
      }
      assert.fail(`Unexpected SQL: ${text}`);
    },
    release(discard) { releases.push(discard); }
  };
  const reader = { async loadSavedRunEvidenceInTransaction(db, venue, run) {
    step('savedEvidence'); assert.equal(db, client); assert.equal(venue, venueId);
    if (run !== runId || settings.missingRun) throw error('payroll_saved_run_not_found', 404);
    return { header: { period: { from: '2026-09-01', to: '2026-09-30' }, currency: settings.currency || 'RUB', scheme: { name: 'Frozen scheme' } },
      evidence: { calculatorReplay: { token: 'frozen' } } };
  } };
  const replay = { executeCalculatorReplay(value) {
    step('replay'); assert.deepEqual(value, { token: 'frozen' });
    return { matched: settings.replayMatched !== false, replayVerified: settings.replayVerified !== false,
      result: { employees: settings.employees || [{ employeeId, amountCents: settings.replayAmount }] } };
  } };
  const bridge = isolated('../payroll-calculation-entry-bridge', {
    './payroll-saved-run-reader': reader, './payroll-calculator-replay': replay });
  const freshness = { async checkPayrollRunSourceFreshnessInTransaction(db, owner, run) {
    step('freshness'); assert.equal(db, client); assert.deepEqual(owner, actor); assert.equal(run, runId);
    assert.equal(fence.hasPayrollVerifiedWriteSnapshot(client, venueId), true); return { status: settings.freshness };
  } };
  const serviceModule = isolated('../payroll-scheme-service', { './payroll-calculation-entry-bridge': bridge,
    './payroll-run-source-freshness': freshness });
  const pool = { async connect() { connects++; return client; }, async query() { assert.fail('private client required'); } };
  return { service: serviceModule.makeService(pool), bridge, client, settings, entries, requests, calls, releases, get connects() { return connects; } };
}
const invoke = (f, body = input, owner = principal, run = runId) => Promise.resolve().then(() => f.service.materializeCalculationEntry(owner, run, body));
function cleanup(f, discarded) {
  assert.deepEqual(f.releases, [discarded]);
  assert.deepEqual(f.calls.slice(0, 3), [LOCK, BEGIN, 'owner']);
  assert.equal(f.calls.filter(x => x === UNLOCK).length, 1);
  assert.equal(f.calls.at(-1), UNLOCK);
  assert.equal(fence.hasPayrollVerifiedWriteSnapshot(f.client, venueId), false);
}
{
  const f = fixture(), first = await invoke(f);
  assert.deepEqual(f.calls.slice(3), ['requestReplay', 'existingEntry', 'savedEvidence', 'replay', 'snapshotSum', 'freshness', 'insertEntry', 'saveRequest', 'COMMIT', UNLOCK]);
  assert.equal(first.entry.amountCents, 125); assert.equal(first.entry.status, 'draft');
  assert.deepEqual(first.entry.allowedActions, ['cancel']); assert.equal(first.entry.payoutEligible, false);
  assert.equal(first.entry.officialReady, false); assert.equal(first.existing, false); cleanup(f);
  assert.equal(first.currentEntry.amountCents, 125); assert.equal(first.currentEntry.grossCents, 125);
  assert.equal(first.currentEntry.transitionStateRequired, true); assert.deepEqual(first.currentEntry.allowedActions, []);
  assert.deepEqual(JSON.parse(f.requests[0].response_payload), {
    schemaVersion: 1, entry: first.entry, replayed: false, existing: false
  }, 'migration202 receipt shape remains unchanged and excludes live state');
  const originalReceipt = clone(f.requests[0]);
  assert.equal(f.requests[0].request_hash, sha(JSON.stringify({ venueId, userId, runId, employeeId, financeCategoryId: null })),
    'replay key is bound to authenticated tenant, owner, run, employee and category');
  f.entries[0].status = 'cancelled'; f.entries[0].net_cents = '75';
  f.calls.length = 0; f.releases.length = 0; f.settings.failAt = 'freshness';
  const repeated = await invoke(f);
  assert.deepEqual(repeated.entry, first.entry, 'replay preserves original draft outcome');
  assert.equal(repeated.currentEntry.status, 'cancelled'); assert.deepEqual(repeated.currentEntry.allowedActions, []);
  assert.equal(repeated.currentEntry.amountCents, 75); assert.equal(repeated.currentEntry.grossCents, 125);
  assert.deepEqual(f.requests[0], originalReceipt, 'retry never rewrites the immutable materialization receipt');
  assert.equal(repeated.replayed, true); assert.equal(f.entries.length, 1); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls.slice(3), ['requestReplay', 'currentEntry', 'COMMIT', UNLOCK]); cleanup(f);
  for (const mutate of [r => { r.request_hash = 'b'.repeat(64); }, r => { r.response_sha256 = 'b'.repeat(64); },
    r => { r.response_payload = '{'; r.response_sha256 = sha(r.response_payload); },
    r => { const p = JSON.parse(r.response_payload); p.entry.id = id(99); r.response_payload = JSON.stringify(p); r.response_sha256 = sha(r.response_payload); }]) {
    const prior = clone(f.requests[0]); mutate(f.requests[0]); f.calls.length = 0;
    await assert.rejects(invoke(f), e => ['payroll_entry_idempotency_conflict', 'payroll_entry_request_integrity_invalid'].includes(e.code));
    assert.equal(f.calls.includes('freshness'), false); Object.assign(f.requests[0], prior);
  }
}
for (const value of [0, 999999999999]) {
  const f = fixture({ cents: String(value), replayAmount: value });
  const result = await invoke(f); assert.equal(result.entry.amountCents, value); cleanup(f);
}
for (const status of ['draft', 'approved', 'paid', 'cancelled']) {
  const paid = status === 'paid';
  const f = fixture({ existing: { status, net_cents: '75', expense_id: paid ? id(55) : null,
    payment_date: paid ? '2026-10-01' : null }, failAt: 'freshness' }), result = await invoke(f);
  assert.equal(result.existing, true); assert.equal(result.entry.status, status);
  assert.equal(result.entry.amountCents, 125, 'historical receipt always records calculation gross');
  assert.equal(result.currentEntry.amountCents, 75); assert.equal(result.currentEntry.grossCents, 125);
  assert.equal(result.currentEntry.status, status); assert.equal(result.currentEntry.transitionStateRequired, true);
  assert.deepEqual(result.currentEntry.allowedActions, [], 'live list is not transition authorization');
  assert.equal(result.currentEntry.expenseId, paid ? id(55) : null);
  assert.equal(result.currentEntry.paymentDate, paid ? '2026-10-01' : null);
  assert.equal(Object.hasOwn(JSON.parse(f.requests[0].response_payload), 'currentEntry'), false);
  assert.deepEqual(f.calls.slice(3), ['requestReplay', 'existingEntry', 'saveRequest', 'COMMIT', UNLOCK]); cleanup(f);
  const saved = clone(f.requests[0]); f.calls.length = 0; f.releases.length = 0;
  const repeated = await invoke(f);
  assert.deepEqual(repeated.entry, result.entry); assert.deepEqual(repeated.currentEntry, result.currentEntry);
  assert.equal(repeated.replayed, true); assert.deepEqual(f.requests[0], saved);
  assert.deepEqual(f.calls.slice(3), ['requestReplay', 'currentEntry', 'COMMIT', UNLOCK]); cleanup(f);
}
{
  const f = fixture({ existing: { finance_category_id: id(22) } });
  await assert.rejects(invoke(f), { code: 'payroll_entry_existing_category_conflict' }); cleanup(f);
}
for (const cents of ['-1', '1.2', '001', '', 'NaN', 'Infinity', '1000000000000', null, 125]) {
  const f = fixture({ cents }); await assert.rejects(invoke(f), { code: 'payroll_entry_calculation_amount_invalid' });
  assert.equal(f.calls.includes('insertEntry'), false); assert.equal(f.calls.includes('freshness'), false); cleanup(f);
}
for (const [options, code] of [
  [{ replayMatched: false }, 'payroll_entry_replay_required'], [{ replayVerified: false }, 'payroll_entry_replay_required'],
  [{ currency: 'USD' }, 'payroll_entry_replay_required'], [{ employees: [] }, 'payroll_entry_employee_not_in_calculation'],
  [{ replayAmount: -1 }, 'payroll_entry_calculation_amount_invalid'], [{ replayAmount: 1.1 }, 'payroll_entry_calculation_amount_invalid'],
  [{ replayAmount: 1000000000000 }, 'payroll_entry_calculation_amount_invalid'],
  [{ cents: '124' }, 'payroll_entry_calculation_basis_invalid'], [{ missingSnapshot: true }, 'payroll_entry_calculation_basis_invalid'],
  [{ freshness: 'stale' }, 'payroll_entry_calculation_sources_changed'], [{ freshness: 'blocked' }, 'payroll_entry_calculation_sources_changed'],
  [{ missingRun: true }, 'payroll_saved_run_not_found'], [{ authorized: false }, 'payroll_scheme_owner_only']
]) {
  const f = fixture(options); await assert.rejects(invoke(f), { code });
  assert.equal(f.calls.includes('insertEntry'), false); assert.equal(f.calls.includes('saveRequest'), false); cleanup(f);
}
for (const body of [null, {}, [], { ...input, amountCents: 1 }, { ...input, venueId }, { ...input, employeeId: 'bad' },
  { ...input, financeCategoryId: '' }, { ...input, idempotencyKey: 'bad key!' }, { ...input, [Symbol('x')]: 1 },
  Object.defineProperty({ ...input }, 'employeeId', { get() { throw new Error('must not execute'); } })]) {
  const f = fixture(); await assert.rejects(invoke(f, body), { code: 'invalid_payroll_entry_materialization_request' }); assert.equal(f.connects, 0);
}
for (const owner of [null, { ...principal, venueId: 'bad' }, Object.create(principal)]) {
  const f = fixture(); await assert.rejects(invoke(f, input, owner), { code: 'authenticated_owner_required' }); assert.equal(f.connects, 0);
}
{
  const f = fixture(); await assert.rejects(f.bridge.materializeCalculationEntry(f.client, actor,
    f.bridge.normalizeEntryMaterialization(runId, input), () => assert.fail('freshness must not run')), { code: 'payroll_entry_source_transaction_required' });
  assert.equal(f.calls.length, 0);
}
for (const [sqlCode, publicCode] of [['40001', 'payroll_entry_materialization_retry_required'], ['40P01', 'payroll_entry_materialization_retry_required'],
  ['23505', 'payroll_entry_materialization_conflict'], ['23P01', 'payroll_period_overlap'], ['42P01', 'payroll_entry_materialization_schema_required'],
  ['42703', 'payroll_entry_materialization_schema_required'], ['23514', 'payroll_entry_materialization_rejected'], ['23503', 'payroll_entry_materialization_rejected'], ['55000', 'payroll_entry_materialization_rejected']]) {
  const f = fixture({ failAt: 'insertEntry', failure: error(sqlCode) });
  await assert.rejects(invoke(f), { code: publicCode, status: 409 }); cleanup(f);
}
for (const failAt of ['requestReplay', 'savedEvidence', 'replay', 'snapshotSum', 'freshness', 'insertEntry', 'saveRequest', 'COMMIT']) {
  const f = fixture({ failAt }); await assert.rejects(invoke(f)); assert.ok(f.calls.includes('ROLLBACK')); cleanup(f);
}
for (const kind of ['rollbackError', 'unlockError']) {
  const problem = error(`bad_${kind}`), f = fixture({ failAt: 'freshness', [kind]: problem });
  await assert.rejects(invoke(f)); cleanup(f, problem);
}
for (const status of ['draft', 'approved', 'paid', 'cancelled']) {
  const f = fixture({ existing: { status, net_cents: '75', expense_id: status === 'paid' ? id(55) : null,
    payment_date: status === 'paid' ? '2026-10-01' : null } });
  const result = await f.service.listCalculationEntries(principal, runId);
  assert.equal(result.items[0].status, status); assert.deepEqual(result.items[0].allowedActions, []);
  assert.equal(result.items[0].amountCents, 75); assert.equal(result.items[0].grossCents, 125);
  assert.equal(result.items[0].transitionStateRequired, true);
  assert.equal(result.items[0].expenseId, status === 'paid' ? id(55) : null);
  assert.equal(result.items[0].paymentDate, status === 'paid' ? '2026-10-01' : null);
  assert.equal(Object.hasOwn(result.items[0], 'officialReady'), false);
  assert.equal(Object.hasOwn(result.items[0], 'payoutEligible'), false);
  assert.deepEqual(f.calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'owner', 'savedEvidence', 'existingEntry', 'COMMIT']);
  assert.deepEqual(f.releases, [undefined]);
}
for (const net_cents of ['-1', '126', '1.2', '', null, 75]) {
  const f = fixture({ existing: { net_cents } });
  await assert.rejects(f.service.listCalculationEntries(principal, runId), { code: 'payroll_entry_calculation_amount_invalid' });
  assert.equal(f.requests.length, 0);
}
{
  const f = fixture({ existing: { status: 'paid', net_cents: '0', expense_id: null, payment_date: '2026-10-01' } });
  const materialized = await invoke(f);
  assert.equal(materialized.entry.amountCents, 125);
  assert.equal(materialized.currentEntry.amountCents, 0);
  assert.equal(materialized.currentEntry.grossCents, 125);
  assert.equal(materialized.currentEntry.expenseId, null, 'zero settlement is not represented as a cash expense');
  const listed = await f.service.listCalculationEntries(principal, runId);
  assert.deepEqual(listed.items[0], materialized.currentEntry);
}
{
  const f = fixture(); await assert.rejects(f.service.listCalculationEntries(principal, id(99)), { code: 'payroll_saved_run_not_found', status: 404 });
  assert.equal(f.calls.includes('existingEntry'), false, 'unknown tenant-scoped run must not return an empty success');
  assert.deepEqual(f.releases, [undefined]);
}

// Actual router with a service seam: method/auth/body/status/error contracts.
const path = `/api/payroll/calculation-runs/${runId}/entries`;
async function route(options = {}) {
  const response = { reads: 0, calls: [], headers: {} };
  const req = { method: options.method || 'POST', user: { id: userId, venueId, role: 'owner' },
    headers: { host: 'test.local', origin: 'https://test.local', 'content-type': 'application/json' }, socket: { encrypted: true }, ...options };
  const service = Object.fromEntries(['materializeCalculationEntry', 'listCalculationEntries'].map(name => [name, async (...args) => {
    response.calls.push([name, ...args]); if (options.failure) throw options.failure; return options.result || { replayed: false, existing: false };
  }]));
  response.handled = await handlePayrollSchemeRoute({ req, res: { setHeader: (k, v) => { response.headers[k] = v; } },
    url: new URL(options.path || path, 'https://test.local'), service,
    readBody: async () => { response.reads++; return Object.hasOwn(options, 'body') ? options.body : input; },
    json: (_, status, body) => Object.assign(response, { status, body }) });
  return response;
}
for (const method of ['GET', 'POST']) {
  const r = await route({ method }); assert.equal(r.handled, true); assert.equal(r.status, method === 'GET' ? 200 : 201);
  assert.deepEqual(r.calls[0], method === 'GET' ? ['listCalculationEntries', principal, runId] : ['materializeCalculationEntry', principal, runId, input]);
  for (const user of [null, { id: userId, venueId, role: 'manager' }]) {
    const denied = await route({ method, user }); assert.equal(denied.status, user ? 403 : 401);
    assert.equal(denied.reads, 0); assert.equal(denied.calls.length, 0);
  }
  for (const badPath of [path + '?limit=1', path.replace(runId, 'bad'), path.replace(runId, '%xx')]) {
    const bad = await route({ method, path: badPath }); assert.equal(bad.status, 400); assert.equal(bad.calls.length, 0);
  }
}
for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await route({ method })).status, 405);
for (const body of [null, [], {}, { ...input, amount: 1 }, { ...input, userId }]) {
  const r = await route({ body }); assert.equal(r.status, 400); assert.equal(r.calls.length, 0);
}
assert.equal((await route({ headers: { host: 'test.local', origin: 'https://evil.test', 'content-type': 'application/json' } })).status, 403);
assert.equal((await route({ headers: { host: 'test.local', origin: 'https://test.local', 'content-type': 'text/plain' } })).status, 415);
for (const result of [{ replayed: true }, { existing: true }]) assert.equal((await route({ result })).status, 200);
assert.deepEqual((await route({ failure: error('payroll_period_overlap') })).body, { error: 'payroll_period_overlap' });
assert.deepEqual((await route({ failure: new Error('private SQL details') })).body, { error: 'payroll_scheme_unavailable' });
console.log('PASS payroll-calculation-entry-bridge-contract: real bridge/service/fence/router with module-local source seams and fake DB; no PostgreSQL/source-proof claim');
