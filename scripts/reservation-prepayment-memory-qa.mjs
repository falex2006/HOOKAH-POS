import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const reservation = reservations.find((entry) => entry.id === reservationPrePaymentPath[1]');
const end = source.indexOf('const reservationAllocationReversal = pathname.match', start);
assert.ok(start >= 0 && end > start, 'memory prepayment handler exists');
const route = source.slice(start, end).replace(/\}\s*$/, '');
const venueId = 'venue-a';
const reservations = ['booking-a', 'booking-b'].map((id) => ({ id, venueId, status: 'confirmed', depositRequired: 100, depositPaid: 0, verifiedDepositPaid: 0, prepaymentReceipts: [] }));
const shifts = [{ id: 'shift-a', venueId, closedAt: null }];
const invoke = async (id, payload, venue = venueId) => {
  let response;
  const req = { method: 'POST', user: { id: 'cashier-a', name: 'QA cashier' }, headers: {} };
  await new Function('reservationPrePaymentPath','req','res','repositories','venueDbId','denyUnless','body','json','reservations','currentVenueId','validPaymentAmount','shifts','recordAudit','crypto','amount','method','reason','idempotencyKey',
    `return (async()=>{${route}})();`)(['', id], req, {}, {}, venue, () => false, async () => payload,
    (_res, status, data) => { response = { status, data }; return response; }, reservations, venue,
    (amount) => Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === amount * 100, shifts,
    () => {}, await import('node:crypto'), Number(payload.amount), payload.method, payload.reason, payload.idempotencyKey);
  return response;
};

const payload = { amount: 30, method: 'cash', reason: 'Memory QA', idempotencyKey: 'memory-key-0001' };
const first = await invoke('booking-a', payload);
assert.equal(first.status, 201);
const replay = await invoke('booking-a', payload);
assert.equal(replay.status, 200);
assert.equal(replay.data.idempotentReplay, true);
const reused = await invoke('booking-b', payload);
assert.equal(reused.status, 409);
assert.equal(reused.data.error, 'idempotency_key_reused');
assert.equal(reservations[0].verifiedDepositPaid, 30);
assert.equal(reservations[1].verifiedDepositPaid, 0, 'cross-booking key reuse must never create another receipt');
console.log('RESERVATION PREPAYMENT MEMORY QA: PASS (same-request replay and venue-wide key uniqueness)');
