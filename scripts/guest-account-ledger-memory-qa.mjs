import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const topUpStart = source.indexOf('const clientDepositTopUps = pathname.match');
const loyaltyStart = source.indexOf('const clientLoyalty = pathname.match', topUpStart);
const accountStart = source.indexOf('const clientAccountEntries = pathname.match', loyaltyStart);
const productImageStart = source.indexOf('const productImage = pathname.match', accountStart);
assert.ok(topUpStart >= 0 && loyaltyStart > topUpStart && accountStart > loyaltyStart && productImageStart > accountStart, 'guest account API handlers are present');
const handlers = source.slice(topUpStart, productImageStart);
const clients = [{ id: 'guest-ledger-qa', venueId: 'qa-venue', name: 'QA Guest', loyaltyPoints: 40, bonusBalance: 40, depositBalance: 0 }];
const shifts = [{ id: 'shift-deposit-qa', venueId: 'qa-venue', openedAt: new Date().toISOString(), closedAt: null, openingCash: 0 }];
const originalAuth = process.env.AUTH_REQUIRED;
process.env.AUTH_REQUIRED = 'false';

async function call(path, method = 'GET', payload = {}) {
  let response;
  const url = new URL(`http://localhost${path}`);
  const route = new Function('pathname','url','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','hasPermission','normalizePhoneNumbers','clients','discountGroups','shifts','validPaymentAmount','currentVenueId',
    `return (async()=>{${handlers}})();`);
  const result = await route(url.pathname, url, { method, headers: {}, user: { id: null, name: 'QA', permissions: ['loyalty'] } }, {}, undefined, 'qa-venue',
    () => false, async () => payload, (_res,status,data) => (response={status,data}), () => {}, () => true, (phones) => phones || [], clients, [], shifts, (amount) => Number.isFinite(Number(amount)) && Number(amount) > 0 && Math.abs(Number(amount) * 100 - Math.round(Number(amount) * 100)) < 1e-7, 'qa-venue');
  return response || result;
}

try {
  const first = await call('/api/clients/guest-ledger-qa/loyalty', 'POST', { delta: 15, reason: 'Test adjustment', idempotencyKey: 'memory-adjustment-1' });
  assert.equal(first.status, 200);
  assert.equal(first.data.bonusBalance, 55);
  const retry = await call('/api/clients/guest-ledger-qa/loyalty', 'POST', { delta: 15, reason: 'Test adjustment', idempotencyKey: 'memory-adjustment-1' });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(clients[0].bonusBalance, 55, 'idempotent retry does not apply the adjustment twice');
  const collision = await call('/api/clients/guest-ledger-qa/loyalty', 'POST', { delta: 16, reason: 'Different', idempotencyKey: 'memory-adjustment-1' });
  assert.equal(collision.status, 409);
  const overdraft = await call('/api/clients/guest-ledger-qa/loyalty', 'POST', { delta: -100, reason: 'Overdraft', idempotencyKey: 'memory-adjustment-2' });
  assert.equal(overdraft.status, 409);
  const history = await call('/api/clients/guest-ledger-qa/account-entries');
  assert.equal(history.status, 200);
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.balances.bonus, 55);
  assert.equal(history.data.items[0].sourceKey, 'loyalty-adjustment:memory-adjustment-1');
  const topup = await call('/api/clients/guest-ledger-qa/deposit-top-ups', 'POST', { amount: 18.25, method: 'card', reason: 'Memory deposit QA', idempotencyKey: 'memory-deposit-01' });
  assert.equal(topup.status, 201);
  assert.equal(topup.data.depositBalance, 18.25);
  const topupRetry = await call('/api/clients/guest-ledger-qa/deposit-top-ups', 'POST', { amount: 18.25, method: 'card', reason: 'Memory deposit QA', idempotencyKey: 'memory-deposit-01' });
  assert.equal(topupRetry.status, 200);
  assert.equal(topupRetry.data.idempotentReplay, true);
  assert.equal(clients[0].depositBalance, 18.25);
  const topupConflict = await call('/api/clients/guest-ledger-qa/deposit-top-ups', 'POST', { amount: 19, method: 'card', reason: 'Memory deposit QA', idempotencyKey: 'memory-deposit-01' });
  assert.equal(topupConflict.status, 409);
  clients.push({ id: 'guest-other-venue', venueId: 'different-venue', depositBalance: 0 });
  const crossVenueTopUp = await call('/api/clients/guest-other-venue/deposit-top-ups', 'POST', { amount: 12, method: 'cash', reason: 'Cross-venue QA', idempotencyKey: 'cross-venue-01' });
  assert.equal(crossVenueTopUp.status, 404, 'memory fallback does not locate another venue guest');
  assert.equal(clients[1].depositBalance, 0, 'cross-venue request cannot change another guest account');
  const depositHistory = await call('/api/clients/guest-ledger-qa/account-entries');
  assert.equal(depositHistory.data.balances.deposit, 18.25);
  assert.equal(depositHistory.data.items.filter((entry) => entry.accountType === 'deposit' && entry.sourceType === 'deposit_top_up').length, 1);
  console.log('GUEST ACCOUNT LEDGER MEMORY QA: PASS (audit trail, idempotency, overdraft guard, balance reconciliation)');
} finally {
  if (originalAuth === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuth;
}
