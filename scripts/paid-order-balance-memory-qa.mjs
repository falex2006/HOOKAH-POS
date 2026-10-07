import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'true', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
async function call(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
try {
  assert.equal((await call('/api/health')).database, 'memory');
  await call('/api/shifts', 'POST', { openingCash: 0 }, 201);
  const product = await call('/api/products', 'POST', { name: 'QA paid order service', category: 'Услуги', price: 100, inventoryMode: 'non_stock' }, 201);
  const order = await call('/api/orders', 'POST', { tableId: 'paid-order-balance-qa' }, 201);
  const item = await call(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 2 }, 201);
  assert.equal((await call(`/api/orders/${order.id}`, 'PATCH', { clientId: 'missing-client', notes: 'must rollback' }, 404)).error, 'client_not_found');
  assert.equal((await call('/api/orders')).items.find((entry) => entry.id === order.id)?.notes, '', 'rejected guest edit leaves memory notes unchanged');
  for (const quantity of [1.5, 1000]) assert.equal((await call(`/api/orders/${order.id}/items/${item.id}`, 'PATCH', { quantity }, 400)).error, 'quantity_must_be_positive');
  await call(`/api/orders/${order.id}/payments`, 'POST', { amount: 150, method: 'cash' }, 201);
  const initial = await call(`/api/orders/${order.id}/payments`);
  assert.equal(initial.remaining, 50);
  const edit = await call(`/api/orders/${order.id}/items/${item.id}`, 'PATCH', { quantity: 1 }, 409);
  assert.equal(edit.error, 'paid_order_total_conflict');
  assert.equal(edit.paid, 150);
  assert.equal(edit.due, 100);
  assert.equal((await call(`/api/orders/${order.id}/payments`)).due, 200, 'rejected edit preserves total');
  assert.equal((await call(`/api/orders/${order.id}/items/${item.id}`, 'DELETE', undefined, 409)).error, 'paid_order_total_conflict');
  assert.equal((await call(`/api/orders/${order.id}/split`, 'POST', { itemIds: [item.id] }, 409)).error, 'paid_order_total_conflict');
  assert.equal((await call(`/api/orders/${order.id}/status`, 'POST', { status: 'cancelled' }, 409)).error, 'paid_order_cannot_cancel');
  assert.equal((await call(`/api/orders/${order.id}`, 'DELETE', { comment: 'QA', writeoff: false }, 409)).error, 'paid_order_cannot_cancel');
  const discount = await call(`/api/orders/${order.id}/discount-requests`, 'POST', { type: 'percent', value: 50, reason: 'QA' }, 201);
  assert.equal((await call(`/api/discount-requests/${discount.id}/approve`, 'POST', {}, 409)).error, 'paid_order_total_conflict');
  assert.equal((await call(`/api/orders/${order.id}/payments`)).due, 200, 'rejected discount preserves total');
  assert.equal((await call(`/api/orders/${order.id}/payments`, 'POST', { amount: 50.01, method: 'card' }, 409)).error, 'payment_exceeds_due');
  assert.equal((await call(`/api/orders/${order.id}/payments`, 'POST', { amount: 0.001, method: 'card' }, 400)).error, 'valid_method_and_amount_required');
  assert.equal((await call(`/api/orders/${order.id}/payments`, 'POST', { amount: 50.001, method: 'card' }, 400)).error, 'valid_method_and_amount_required');
  const final = await call(`/api/orders/${order.id}/payments`, 'POST', { amount: 50, method: 'card' }, 201);
  assert.equal(final.closed, true);
  assert.equal(final.paid, 200);
  assert.equal(final.loyaltyBonusEarned, 0, 'an unlinked order does not award loyalty points');
  assert.equal((await call(`/api/orders/${order.id}/payments`)).loyaltyBonusEarned, 0, 'the no-award snapshot survives order reread');

  const group = await call('/api/discount-groups', 'POST', { name: 'QA accrual 5%', discountPercent: 10, bonusPercent: 5 }, 201);
  const guest = await call('/api/clients', 'POST', { name: 'QA loyalty guest', discountGroupId: group.id }, 201);
  const loyaltyOrder = await call('/api/orders', 'POST', { tableId: 'paid-order-loyalty-qa' }, 201);
  await call(`/api/orders/${loyaltyOrder.id}/items`, 'POST', { productId: product.id, quantity: 2 }, 201);
  await call(`/api/orders/${loyaltyOrder.id}`, 'PATCH', { clientId: guest.id }, 200);
  const groupQuote = await call(`/api/orders/${loyaltyOrder.id}/summary`);
  assert.equal(groupQuote.due, 180);
  assert.equal(groupQuote.discount, 20);
  assert.equal(groupQuote.source, 'guest_group');
  await call(`/api/discount-groups/${group.id}`, 'PATCH', { discountPercent: 40 }, 200);
  assert.equal((await call(`/api/orders/${loyaltyOrder.id}/summary`)).groupDiscountPercent, 10, 'summary retains the captured group rate');
  assert.equal((await call(`/api/orders/${loyaltyOrder.id}/payments`)).due, 180, 'an open order keeps the group rate captured when its guest was attached');
  const loyaltyPartial = await call(`/api/orders/${loyaltyOrder.id}/payments`, 'POST', { amount: 150, method: 'cash' }, 201);
  assert.equal(loyaltyPartial.closed, false);
  assert.equal((await call(`/api/orders/${loyaltyOrder.id}`, 'PATCH', { clientId: null }, 409)).error, 'guest_change_after_payment', 'guest cannot be transferred after a partial payment');
  assert.equal(guest.loyaltyPoints, 0, 'partial payment never earns points');
  assert.equal((await call(`/api/clients/${guest.id}/account-entries`)).items.length, 0, 'partial payment leaves the loyalty ledger unchanged');
  const loyaltyFinal = await call(`/api/orders/${loyaltyOrder.id}/payments`, 'POST', { amount: 30, method: 'card' }, 201);
  assert.equal(loyaltyFinal.closed, true);
  assert.equal(loyaltyFinal.groupDiscountAmount, 20);
  assert.equal(loyaltyFinal.effectiveDiscountSource, 'guest_group');
  assert.equal(loyaltyFinal.finalTotalSnapshot, 180);
  assert.equal(loyaltyFinal.loyaltyBonusBase, 180);
  assert.equal(loyaltyFinal.loyaltyBonusPercent, 5);
  assert.equal(loyaltyFinal.loyaltyBonusEarned, 9);
  assert.equal(loyaltyFinal.loyaltyBonusBalance, 9);
  assert.equal((await call(`/api/orders/${loyaltyOrder.id}/payments`)).loyaltyBonusEarned, 9, 'the earned amount survives a fresh order read');
  const updatedGuest = (await call('/api/clients')).items.find((item) => item.id === guest.id);
  assert.equal(updatedGuest.loyaltyPoints, 9);
  const guestLedger = await call(`/api/clients/${guest.id}/account-entries`);
  assert.equal(guestLedger.items.filter((entry) => entry.sourceId === loyaltyOrder.id).length, 1, 'one ledger movement is stored for the order');
  assert.equal((await call(`/api/orders/${loyaltyOrder.id}/payments`, 'POST', { amount: 1, method: 'cash' }, 409)).error, 'order_already_final');
  const redeemOrder = await call('/api/orders', 'POST', { tableId: 'paid-order-bonus-redeem-qa' }, 201);
  await call(`/api/orders/${redeemOrder.id}/items`, 'POST', { productId: product.id, quantity: 2 }, 201);
  await call(`/api/orders/${redeemOrder.id}`, 'PATCH', { clientId: guest.id }, 200);
  const redeemQuote = await call(`/api/orders/${redeemOrder.id}/payments`);
  assert.equal(redeemQuote.guestAccount.bonusBalance, 9);
  const topUp = await call(`/api/clients/${guest.id}/deposit-top-ups`, 'POST', { amount: 35, method: 'cash', reason: 'Memory wallet funding', idempotencyKey: 'qa-memory-wallet-01' }, 201);
  assert.equal(topUp.depositBalance, 35);
  assert.equal((await call(`/api/clients/${guest.id}/deposit-top-ups`, 'POST', { amount: 35, method: 'cash', reason: 'Memory wallet funding', idempotencyKey: 'qa-memory-wallet-01' }, 200)).idempotentReplay, true);
  assert.equal((await call(`/api/clients/${guest.id}/deposit-top-ups`, 'POST', { amount: 36, method: 'cash', reason: 'Memory wallet funding', idempotencyKey: 'qa-memory-wallet-01' }, 409)).error, 'idempotency_key_reused');
  assert.equal(redeemQuote.due, 120);
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 1.5, method: 'bonus', idempotencyKey: 'qa-bonus-invalid' }, 400)).error, 'valid_method_and_amount_required');
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 10, method: 'bonus' }, 400)).error, 'valid_method_and_amount_required');
  const depositTender = await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 25.5, method: 'deposit', idempotencyKey: 'qa-memory-deposit-tender-01' }, 201);
  assert.equal(depositTender.guestAccount.depositBalance, 9.5);
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 10, method: 'deposit', idempotencyKey: 'qa-memory-deposit-insufficient' }, 409)).error, 'insufficient_deposit_balance');
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 25.5, method: 'deposit', idempotencyKey: 'qa-memory-deposit-tender-01' }, 200)).idempotentReplay, true);
  const debit = await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-bonus-redeem-0001' }, 201);
  assert.equal(debit.guestAccount.bonusBalance, 4);
  const replay = await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-bonus-redeem-0001' }, 200);
  assert.equal(replay.idempotentReplay, true);
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`)).items.filter((entry) => entry.method === 'bonus').length, 1);
  const redeemedClose = await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 89.5, method: 'cash', idempotencyKey: 'qa-bonus-redeem-cash-01' }, 201);
  assert.equal(redeemedClose.closed, true);
  assert.equal(redeemedClose.loyaltyBonusBase, 115, 'bonuses are not earned on the 5 ₽ redeemed tender');
  assert.equal(redeemedClose.loyaltyBonusEarned, 5);
  assert.equal((await call(`/api/clients/${guest.id}/account-entries`)).items.filter((entry) => entry.sourceId === redeemOrder.id && entry.amount === -5).length, 1);
  assert.equal((await call(`/api/clients/${guest.id}/account-entries`)).items.filter((entry) => entry.sourceId === redeemOrder.id && entry.accountType === 'deposit' && entry.amount === -25.5).length, 1);
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-bonus-redeem-0001' }, 200)).idempotentReplay, true, 'successful redemption can be safely retried after closure');
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`)).guestAccount.bonusBalance, 9, 'balance reread includes debit and excludes points earned on the redeemed share');
  assert.equal((await call(`/api/orders/${redeemOrder.id}/payments`)).guestAccount.depositBalance, 9.5, 'stored-value balance is available after payment reread');

  const vipOrder = await call('/api/orders', 'POST', { tableId: 'paid-order-loyalty-vip-qa', minimumOrderTotal: 250 }, 201);
  await call(`/api/orders/${vipOrder.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  await call(`/api/orders/${vipOrder.id}`, 'PATCH', { clientId: guest.id }, 200);
  const vipDiscount = await call(`/api/orders/${vipOrder.id}/discount-requests`, 'POST', { type: 'percent', value: 10, reason: 'QA loyalty base' }, 201);
  await call(`/api/discount-requests/${vipDiscount.id}/approve`, 'POST', {}, 200);
  const vipClosed = await call(`/api/orders/${vipOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(vipClosed.finalTotal, 250);
  assert.equal(vipClosed.loyaltyBonusBase, 60, 'the group discount reduces the earning base and VIP uplift remains excluded');
  assert.equal(vipClosed.loyaltyBonusEarned, 3, 'fractional points are rounded down');
  assert.equal((await call(`/api/orders/${vipOrder.id}/payments`)).loyaltyBonusEarned, 3, 'direct-close snapshot is available after reread');
  assert.equal((await call('/api/clients')).items.find((item) => item.id === guest.id).loyaltyPoints, 12);
  assert.equal((await call(`/api/clients/${guest.id}/account-entries`)).items.filter((entry) => entry.sourceId === vipOrder.id).length, 1);

  const shift = (await call('/api/shifts')).current;
  const ordersForCash = (await call('/api/orders')).items;
  const cashPayments = ordersForCash.flatMap((entry) => entry.payments || []).filter((entry) => entry.method === 'cash' && entry.shiftId === shift.id).reduce((sum, entry) => sum + Number(entry.amount), 0);
  const topupCash = (await call('/api/clients')).items.flatMap((entry) => entry.depositTopUps || []).filter((entry) => entry.shiftId === shift.id && entry.method === 'cash').reduce((sum, entry) => sum + Number(entry.amount), 0);
  const shiftReport = await call(`/api/dashboard/shift-kpis?date=${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(new Date())}&shiftId=${shift.id}`);
  assert.deepEqual(shiftReport.totals.depositTopUps, { total: topupCash, cash: topupCash, cashless: 0, count: 1 }, 'cash wallet top-ups are visible separately from sales revenue');
  const shiftCash = await call(`/api/shifts/${shift.id}/close`, 'POST', { checklistConfirmed: true, closingCash: cashPayments + topupCash }, 200);
  assert.equal(shiftCash.expectedCash, cashPayments + topupCash, 'cash deposit top-ups enter shift cash while remaining outside order payments');

  const discountOrder = await call('/api/orders', 'POST', { tableId: 'paid-order-discount-policy-qa' }, 201);
  await call(`/api/orders/${discountOrder.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  await call(`/api/orders/${discountOrder.id}`, 'PATCH', { clientId: guest.id }, 200);
  const firstDiscount = await call(`/api/orders/${discountOrder.id}/discount-requests`, 'POST', { type: 'percent', value: 100, reason: 'QA one approved discount per order' }, 201);
  await call(`/api/discount-requests/${firstDiscount.id}/approve`, 'POST', {}, 200);
  assert.equal((await call(`/api/orders/${discountOrder.id}/payments`)).due, 0, 'discount cannot reduce due below zero');
  assert.equal((await call(`/api/orders/${discountOrder.id}/summary`)).source, 'manual', 'approved manual discount replaces rather than stacks with the group discount');
  const secondDiscount = await call(`/api/orders/${discountOrder.id}/discount-requests`, 'POST', { type: 'percent', value: 50, reason: 'QA sequential request' }, 201);
  assert.equal((await call(`/api/discount-requests/${secondDiscount.id}/approve`, 'POST', {}, 409)).error, 'approved_discount_exists', 'a second approved manual discount is rejected');
  console.log('PAID ORDER BALANCE MEMORY QA: PASS');
} finally {
  child.kill();
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
