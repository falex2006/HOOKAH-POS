import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import shiftCloseContract from '../shift-close-contract.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const shiftGuardStart = source.indexOf('const employeeNeedsShift =');
const shiftGuardEnd = source.indexOf('\nasync function getShiftCashSummary', shiftGuardStart);
assert.ok(shiftGuardStart >= 0 && shiftGuardEnd > shiftGuardStart, 'shared open-shift guard is available');
const shiftGuardSource = source.slice(shiftGuardStart, shiftGuardEnd);
const memoryGuardShifts = [{ venueId: 'venue-b', closedAt: null }];
const openShiftGuard = new Function('process', 'repositories', 'shifts', 'defaultVenueDbId', 'json',
  `${shiftGuardSource}\nreturn requireOpenShift;`)(
  { env: { AUTH_REQUIRED: 'true' } }, null, memoryGuardShifts, 'venue-a',
  (res, status, data) => { res.status = status; res.body = data; return res; },
);
const foreignVenueGuardResponse = {};
assert.equal(await openShiftGuard({ user: { venueId: 'venue-a', role: 'bartender' } }, foreignVenueGuardResponse), true,
  'an open shift in another venue must not allow an operational staff write');
assert.equal(foreignVenueGuardResponse.status, 409);
assert.equal(foreignVenueGuardResponse.body.error, 'active_shift_required');
memoryGuardShifts.push({ venueId: 'venue-a', closedAt: null });
assert.equal(await openShiftGuard({ user: { venueId: 'venue-a', role: 'bartender' } }, {}), false,
  'the venue’s own open shift allows operational work');
const start = source.indexOf("if (pathname === '/api/shifts' && req.method === 'POST')");
const end = source.indexOf("if (pathname === '/api/venue' && req.method === 'GET')", start);
assert.ok(start >= 0 && end > start, 'shift open/close API block is available');
const orderEditStart = source.indexOf('const orderEdit = pathname.match(');
const orderDeleteStart = source.indexOf('const orderDelete = pathname.match(', orderEditStart);
assert.ok(orderEditStart >= 0 && orderDeleteStart > orderEditStart, 'order metadata edit route is available');
assert.match(source.slice(orderEditStart, orderDeleteStart), /denyUnless\(req, res, 'orders'\)[\s\S]*?requireOpenShift\(req, res\)[\s\S]*?const input = await body\(req\)/,
  'the order metadata edit requires an open shift before it parses or writes the request');
const block = source.slice(start, end);
const validShiftCashSource = source.slice(source.indexOf('const validCashAmount ='), source.indexOf('\nconst orderBalanceConflict', source.indexOf('const validCashAmount =')));
const cashSummaryStart = source.indexOf('async function getShiftCashSummary(');
const cashSummaryEnd = source.indexOf('\n}', cashSummaryStart) + 2;
assert.ok(cashSummaryStart >= 0 && cashSummaryEnd > cashSummaryStart, 'shared expected cash summary is available');
const getShiftCashSummary = new Function(`${source.slice(cashSummaryStart, cashSummaryEnd)}\nreturn getShiftCashSummary;`)();
const shiftId = '33333333-3333-4333-8333-333333333333';
const checklist = { version: 1, items: Object.fromEntries(shiftCloseContract.checklistItems.map(({ id }) => [id, true])) };

const makePool = ({ active = false, unresolvedLegacyCashCount = 0, unresolvedLegacyCashAmount = 0, attributedCashAmount = 300 } = {}) => {
  const calls = [];
  const state = { active, inserted: false, closed: false, expectedCash: null, closingCash: null, cashVariance: null, audits: [], snapshot: null };
  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK' || normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (normalized.startsWith('SELECT id FROM shifts WHERE venue_id=') && normalized.includes('LIMIT 1 FOR UPDATE')) return { rows: state.active ? [{ id: shiftId }] : [] };
    if (normalized.startsWith('INSERT INTO shifts')) { state.active = true; state.inserted = true; return { rows: [{ id: shiftId, openedAt: '2026-09-27T10:00:00Z', closedAt: null, openingCash: params[2], closingCash: null }] }; }
    if (normalized.startsWith('INSERT INTO audit_events')) { state.audits.push({ action: params[2], id: params[3], after: params[4] }); return { rows: [] }; }
    if (normalized.startsWith('SELECT id,venue_id,opening_cash AS')) return { rows: state.active && !state.closed ? [{ id: shiftId, venue_id: params[1], openingCash: '1000', openedAt: '2026-09-27T10:00:00Z' }] : [] };
    if (normalized.startsWith('SELECT $4::numeric')) return { rows: [{ expectedCash: String(Number(params[3]) + attributedCashAmount), unresolvedLegacyCashCount, unresolvedLegacyCashAmount: String(unresolvedLegacyCashAmount), cashPreviewAt: '2026-09-27T20:00:00Z' }] };
    if (normalized.startsWith('SELECT COUNT(*)::int AS count, COALESCE(SUM(p.amount),0) AS amount')) return { rows: [{ count: unresolvedLegacyCashCount, amount: String(unresolvedLegacyCashAmount) }] };
    if (normalized.startsWith('SELECT COALESCE(SUM(amount),0) AS amount FROM guest_deposit_receipts')) return { rows: [{ amount: '0' }] };
    if (normalized.startsWith('SELECT COALESCE(SUM(amount),0) AS amount FROM reservation_pre_payment_receipts')) return { rows: [{ amount: '0' }] };
    if (normalized.startsWith('SELECT COALESCE(SUM(p.amount),0)')) return { rows: [{ amount: String(attributedCashAmount) }] };
    if (normalized === 'CAPTURE CLOSE LEDGER') return { rows: [] };
    if (normalized.startsWith('WITH ')) return { rows: [{ count: 0, net: '0.00', items: [] }] };
    if (normalized.startsWith('SELECT source,event_id')) return { rows: [] };
    if (normalized.startsWith('SELECT COALESCE(NULLIF(timezone')) return { rows: [{ timezone: 'Asia/Yekaterinburg' }] };
    if (normalized.startsWith('UPDATE shifts SET closed_at=clock_timestamp()')) { state.closingCash = params[0]; state.expectedCash = params[1]; state.cashVariance = params[0] - params[1]; state.closed = true; state.active = false; return { rows: [{ id: shiftId, venueId: params[3], openedAt: '2026-09-27T10:00:00Z', closedAt: '2026-09-27T20:00:00Z', openingCash: 1000, closingCash: state.closingCash, expectedCash: state.expectedCash, cashVariance: state.cashVariance }] }; }
    if (normalized.startsWith('INSERT INTO shift_close_snapshots')) { state.snapshot = { id: 'snapshot-qa', venueId: params[0], shiftId: params[1], schemaVersion: 1, checklistVersion: params[2], payload: JSON.parse(params[3]), sha256: params[4], closedBy: params[5], capturedAt: '2026-09-27T20:00:00Z' }; return { rows: [state.snapshot] }; }
    throw new Error(`unexpected SQL: ${normalized}`);
  };
  return { calls, state, pool: { connect: async () => ({ query, release() {} }) } };
};

const run = async ({ db, pathname, payload }) => {
  const req = { method: 'POST', user: { id: '11111111-1111-4111-8111-111111111111', name: 'QA' } };
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','shifts','getShiftCashSummary','shiftCloseContract','captureShiftCloseLedger','crypto', `${validShiftCashSource}\nreturn (async()=>{${block}})();`)(
    pathname, req, {}, { pool: db.pool }, '22222222-2222-4222-8222-222222222222', () => false, async () => payload,
    (_res, status, data) => ({ status, data }), (_req, action, _type, id, before, after) => db.state.audits.push({ action, id, before, after }), [], getShiftCashSummary,
    shiftCloseContract, async (client) => { await client.query('CAPTURE CLOSE LEDGER'); return { sales: { closedOrderCount: 0, net: '0.00', items: [] }, receipts: [], payouts: [] }; }, { createHash },
  );
  return result;
};

const openedDb = makePool();
const opened = await run({ db: openedDb, pathname: '/api/shifts', payload: { openingCash: 1000 } });
assert.equal(opened.status, 201);
assert.equal(openedDb.state.inserted, true);
const openSql = openedDb.calls.map(({ sql }) => sql);
assert.ok(openSql.indexOf('BEGIN') < openSql.findIndex((sql) => sql.includes('pg_advisory_xact_lock')));
assert.ok(openSql.findIndex((sql) => sql.includes('pg_advisory_xact_lock')) < openSql.findIndex((sql) => sql.startsWith('SELECT id FROM shifts')));
assert.ok(openSql.findIndex((sql) => sql.startsWith('INSERT INTO shifts')) < openSql.indexOf('COMMIT'));

const duplicateDb = makePool({ active: true });
const duplicate = await run({ db: duplicateDb, pathname: '/api/shifts', payload: { openingCash: 1000 } });
assert.equal(duplicate.status, 409);
assert.equal(duplicate.data.error, 'shift_already_open');
assert.equal(duplicateDb.state.inserted, false);

const closeDb = makePool({ active: true, attributedCashAmount: 300 });
const closed = await run({ db: closeDb, pathname: `/api/shifts/${shiftId}/close`, payload: { closingCash: 1200, checklist } });
assert.equal(closed.status, 200, 'a shift with only explicitly attributed cash can close');
assert.equal(closed.data.expectedCash, 1300, 'reconciliation includes opening cash plus payments explicitly attributed to this shift');
assert.equal(closed.data.cashVariance, -100);
const closeSql = closeDb.calls.map(({ sql }) => sql);
const lockAt = closeSql.findIndex((sql) => sql.includes('opening_cash AS') && sql.includes('FOR UPDATE'));
const cashSummaryAt = closeSql.findIndex((sql) => sql.startsWith('SELECT $4::numeric'));
const ledgerAt = closeSql.indexOf('CAPTURE CLOSE LEDGER');
const closeUpdateAt = closeSql.findIndex((sql) => sql.startsWith('UPDATE shifts SET closed_at=clock_timestamp()'));
const snapshotAt = closeSql.findIndex((sql) => sql.startsWith('INSERT INTO shift_close_snapshots'));
const auditAt = closeSql.findIndex((sql, index) => index > snapshotAt && sql.startsWith('INSERT INTO audit_events'));
assert.ok(closeSql.indexOf('BEGIN') < lockAt && lockAt < cashSummaryAt && cashSummaryAt < ledgerAt && ledgerAt < closeUpdateAt && closeUpdateAt < snapshotAt && snapshotAt < auditAt && auditAt < closeSql.indexOf('COMMIT'));
assert.match(closeDb.calls[cashSummaryAt].sql, /p\.shift_id IS NULL/);
assert.match(closeDb.calls[cashSummaryAt].sql, /p\.created_at >= \$3/);
assert.equal(closed.data.closeSnapshot.payload.fiscalDocument, false);
assert.equal(closed.data.closeSnapshot.payload.checklist.items.length, 4);
assert.equal(closed.data.closeSnapshot.sha256, createHash('sha256').update(shiftCloseContract.stableJsonStringify(closed.data.closeSnapshot.payload)).digest('hex'));

const ambiguousDb = makePool({ active: true, unresolvedLegacyCashCount: 2, unresolvedLegacyCashAmount: 750 });
const ambiguous = await run({ db: ambiguousDb, pathname: `/api/shifts/${shiftId}/close`, payload: { closingCash: 1750, checklist } });
assert.equal(ambiguous.status, 409, 'an open transition shift with legacy unassigned cash cannot close silently');
assert.equal(ambiguous.data.error, 'shift_cash_attribution_unresolved');
assert.equal(ambiguous.data.count, 2);
assert.equal(ambiguous.data.amount, 750);
assert.equal(ambiguousDb.state.closed, false);
assert.ok(ambiguousDb.calls.some(({ sql }) => sql === 'ROLLBACK'));
assert.equal(ambiguousDb.calls.some(({ sql }) => sql.startsWith('UPDATE shifts SET closed_at=clock_timestamp()')), false);

const noLegacyCashDb = makePool({ active: true, unresolvedLegacyCashCount: 0, attributedCashAmount: 0 });
const noLegacyCash = await run({ db: noLegacyCashDb, pathname: `/api/shifts/${shiftId}/close`, payload: { closingCash: 1000, checklist } });
assert.equal(noLegacyCash.status, 200, 'a transition shift with no unassigned cash remains closable');
assert.equal(noLegacyCash.data.expectedCash, 1000);

const oldClosedDb = makePool({ active: false, unresolvedLegacyCashCount: 5, unresolvedLegacyCashAmount: 900 });
const oldClosed = await run({ db: oldClosedDb, pathname: `/api/shifts/${shiftId}/close`, payload: { closingCash: 1900, checklist } });
assert.equal(oldClosed.status, 404, 'historical closed shifts remain unchanged and are not reconciled again');
assert.equal(oldClosed.data.error, 'shift_not_found_or_closed');
assert.equal(oldClosedDb.calls.some(({ sql }) => sql.startsWith('SELECT $4::numeric')), false);
assert.equal(oldClosedDb.calls.some(({ sql }) => sql.startsWith('UPDATE shifts SET closed_at=clock_timestamp()')), false);

console.log('SHIFT TRANSACTION QA: PASS (open serialization, duplicate rejection, explicit attribution, legacy transition guard, and closed-shift isolation)');
