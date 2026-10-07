import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const { database } = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const { Client } = createRequire(import.meta.url)('pg');
const client = new Client({ connectionString: databaseUrl });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venueId = randomUUID();
const otherVenueId = randomUUID();
const zoneId = randomUUID();
const policyTableId = randomUUID();
const promoTableId = randomUUID();
const raceTableId = randomUUID();
let prePolicyOrderId = null;
const organizationId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const managerLogin = 'paid-order-manager-' + managerId;
const ownerLogin = 'paid-order-qa-' + ownerId;
const password = 'qa-' + randomUUID();
const passwordSalt = randomBytes(16).toString('hex');
const passwordHash = 'scrypt$' + passwordSalt + '$' + (await promisify(scryptCallback)(password, passwordSalt, 64)).toString('hex');
const productId = randomUUID();
const promoProductId = randomUUID();
const legacyClosedOrderId = randomUUID();
const legacyClosedItemId = randomUUID();
const legacyFallbackOrderId = randomUUID();
const legacyFallbackItemId = randomUUID();
const orderId = randomUUID();
const itemA = randomUUID();
const vipOrderId = randomUUID();
const vipItemId = randomUUID();
const groupOrderId = randomUUID();
const groupOrderItemId = randomUUID();
const redeemOrderId = randomUUID();
const redeemOrderItemId = randomUUID();
const guestId = randomUUID();
const raceGuestId = randomUUID();
const raceOrderIds = [randomUUID(), randomUUID()];
const raceItemIds = [randomUUID(), randomUUID()];
const groupId = randomUUID();
let server;
let serverExitPromise;
let output = '';
let base = '';
let passed = false;
let token = '';

const api = async (route, method = 'GET', data, expected = 200) => {
  const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
};

try {
  await client.connect();
  const identity = await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
  assertQaDatabaseIdentity(identity.rows[0], database, Number(new URL(databaseUrl).port || 5432), 'Paid-order QA database');
  await client.query("INSERT INTO organizations (id,name,slug,plan) VALUES ($1,'Paid order QA',$2,'network')", [organizationId, 'paid-order-qa-' + organizationId]);
  await client.query("INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'network','active',30,10)", [organizationId]);
  await client.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Paid order QA','Asia/Yekaterinburg')", [venueId, organizationId]);
  await client.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Other QA venue','Asia/Yekaterinburg')", [otherVenueId, organizationId]);
  await client.query("INSERT INTO zones (id,venue_id,name) VALUES ($1,$2,'Policy QA zone')", [zoneId, venueId]);
  await client.query("INSERT INTO tables (id,zone_id,name) VALUES ($1,$2,'Policy QA table')", [policyTableId, zoneId]);
  await client.query("INSERT INTO tables (id,zone_id,name) VALUES ($1,$2,'Promotion QA table')", [promoTableId, zoneId]);
  await client.query("INSERT INTO tables (id,zone_id,name) VALUES ($1,$2,'Race QA table')", [raceTableId, zoneId]);
  await client.query("INSERT INTO users (id,venue_id,organization_id,full_name,login,password_hash,role) VALUES ($1,$2,$3,'Paid order QA',$4,$5,'owner')", [ownerId, venueId, organizationId, ownerLogin, passwordHash]);
  await client.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'owner','active')", [organizationId, ownerId]);
  await client.query("INSERT INTO users (id,venue_id,organization_id,full_name,login,password_hash,role) VALUES ($1,$2,$3,'Policy manager',$4,$5,'manager')", [managerId, venueId, organizationId, managerLogin, passwordHash]);
  await client.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'member','active')", [organizationId, managerId]);
  const shiftId = (await client.query("INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,0) RETURNING id", [venueId, ownerId])).rows[0].id;
  await client.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA service','bar',100,'non_stock')", [productId, venueId]);
  await client.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA promotion service','promo',1000,'non_stock')", [promoProductId, venueId]);
  await client.query("INSERT INTO guest_discount_groups (id,venue_id,name,discount_percent,bonus_percent) VALUES ($1,$2,'QA accrual 5%',10,5)", [groupId, venueId]);
  await client.query("INSERT INTO guests (id,venue_id,full_name,discount_group_id) VALUES ($1,$2,'QA loyalty guest',$3)", [guestId, venueId, groupId]);
  await client.query("INSERT INTO guests (id,venue_id,full_name,loyalty_points) VALUES ($1,$2,'QA concurrent redemption guest',10)", [raceGuestId, venueId]);
  await client.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'bonus',10,'Concurrent QA opening balance','opening_balance','qa-concurrent-opening')", [venueId, raceGuestId]);
  await client.query("INSERT INTO orders (id,venue_id,opened_by,guest_id,status) VALUES ($1,$2,$3,$4,'open')", [orderId, venueId, ownerId, guestId]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,2,100,'bar')", [itemA, orderId, productId]);

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl, VENUE_ID: venueId,
      AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  serverExitPromise = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`);
    else await delay(50);
  }
  assert.ok(base, `QA server started: ${output}`);
  assert.equal((await api('/api/health')).database, 'postgres');
  const authenticated = await api('/api/login', 'POST', { username: ownerLogin, password });
  token = authenticated.token;
  assert.ok(token, 'synthetic owner gets a persisted authenticated session');
  const session = await api('/api/session');
  assert.equal(session.user.id, ownerId, 'all order actions use the synthetic owner, not a default actor');
  assert.equal(session.user.organizationId, organizationId);
  assert.equal(session.user.venueId, venueId);
  const ownerToken = token;
  const managerSession = await api('/api/login', 'POST', { username: managerLogin, password });
  token = managerSession.token;
  assert.equal((await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 20, minimumRedemptionPoints: 1 }, 403)).error, 'loyalty_settings_owner_admin_required');
  token = ownerToken;
  const defaultPolicy = await api('/api/loyalty/settings');
  assert.deepEqual([defaultPolicy.version, defaultPolicy.bonusRublesPerPoint, defaultPolicy.maxRedemptionPercent, defaultPolicy.minimumRedemptionPoints, defaultPolicy.source], [0, 1, 100, 1, 'legacy_default']);
  const promoNow = Date.now();
  const livePromotion = await api('/api/loyalty/promotions', 'POST', { expectedVenueId:venueId,name:'QA live promotion',startsAt:new Date(promoNow-60000).toISOString(),endsAt:new Date(promoNow+3600000).toISOString(),timezone:'Asia/Yekaterinburg',benefitKind:'percent',benefitValue:25,priority:5,includeProductIds:[promoProductId],excludeProductIds:[],includeCategories:[],excludeCategories:[] }, 201);
  assert.equal(livePromotion.status,'draft');
  const activePromotion = await api(`/api/loyalty/promotions/${livePromotion.promotionId}`, 'PATCH', { expectedVenueId:venueId,expectedVersion:1,status:'active' }, 200);
  assert.equal(activePromotion.version,2); assert.equal(activePromotion.status,'active');
  const legacyClosedAt = new Date(promoNow-120000);
  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,closed_at) VALUES ($1,$2,$3,'closed',$4)", [legacyClosedOrderId,venueId,ownerId,legacyClosedAt]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,2,1000,'bar')", [legacyClosedItemId,legacyClosedOrderId,promoProductId]);
  await client.query("INSERT INTO payments (order_id,method,amount,status,shift_id,created_at) VALUES ($1,'cash',2000,'paid',$2,$3)", [legacyClosedOrderId,shiftId,legacyClosedAt]);
  const legacyFallbackClosedAt = new Date(promoNow-90000);
  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,closed_at,final_total_snapshot,discount_total_snapshot) VALUES ($1,$2,$3,'closed',$4,NULL,NULL)", [legacyFallbackOrderId,venueId,ownerId,legacyFallbackClosedAt]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,2,1000,'bar')", [legacyFallbackItemId,legacyFallbackOrderId,promoProductId]);
  assert.equal((await api(`/api/orders/${legacyClosedOrderId}/payments`)).due,2000,'a closed legacy order without a price snapshot is not retroactively repriced by a current promotion');
  const historicalReconciliation = await api('/api/loyalty/reconciliation');
  assert.equal(historicalReconciliation.periodBusiness.sales.discounts,0,'historical reconciliation excludes promotions created after the legacy sale');
  assert.equal(historicalReconciliation.periodBusiness.sales.net,2000,'historical reconciliation preserves paid sale revenue without inventing money for the no-payment legacy order');
  const historicalFinanceReport = await api(`/api/finance/report?date=${historicalReconciliation.period.to}`);
  assert.equal(historicalFinanceReport.revenue,4000,'finance report includes payment revenue and the no-payment legacy fallback without a retroactive promotion');
  const pendingBeforePromo = Number((await api('/api/metrics')).pendingRevenue||0);
  const promoOrder = await api('/api/orders', 'POST', { tableId: policyTableId }, 201);
  await api(`/api/orders/${promoOrder.id}/items`, 'POST', { productId:promoProductId,quantity:2 }, 201);
  assert.equal(Number((await api('/api/metrics')).pendingRevenue)-pendingBeforePromo,1500,'pending-revenue CTE applies active promotion to an unpaid, unlocked order');
  const promoQuote = await api(`/api/orders/${promoOrder.id}/payments`);
  assert.equal(promoQuote.subtotal,2000); assert.equal(promoQuote.discount,500); assert.equal(promoQuote.due,1500);
  assert.equal(promoQuote.selectedPromotion.version,2); assert.equal(promoQuote.offers.find((offer)=>offer.source==='promotion')?.reasonCode,'selected');
  const promoPartial = await api(`/api/orders/${promoOrder.id}/payments`, 'POST', { amount:500,method:'cash' }, 201);
  assert.equal(promoPartial.remaining,1000); assert.equal((await api(`/api/orders/${promoOrder.id}/payments`)).pricingLocked,true);
  assert.equal(Number((await api('/api/metrics')).pendingRevenue)-pendingBeforePromo,1000,'pending-revenue CTE applies the active promotion to an unlocked quote and subtracts accepted tender');
  const promoV3 = await api(`/api/loyalty/promotions/${livePromotion.promotionId}`, 'PATCH', { expectedVenueId:venueId,expectedVersion:2,status:'active',benefitValue:80 }, 200);
  assert.equal(promoV3.version,3);
  const lockedPromoQuote = await api(`/api/orders/${promoOrder.id}/payments`);
  assert.equal(lockedPromoQuote.due,1500); assert.equal(lockedPromoQuote.selectedPromotion.version,2,'new active campaign version does not change a partially paid check');
  assert.equal(Number((await api('/api/metrics')).pendingRevenue)-pendingBeforePromo,1000,'report remainder continues to use the captured promotion price');
  const newPromoOrder = await api('/api/orders', 'POST', { tableId: promoTableId }, 201);
  await api(`/api/orders/${newPromoOrder.id}/items`, 'POST', { productId:promoProductId,quantity:2 }, 201);
  assert.equal((await api(`/api/orders/${newPromoOrder.id}/payments`)).due,400,'new order uses the newly activated promotion version');
  const promoClosed = await api(`/api/orders/${promoOrder.id}/payments`, 'POST', { amount:1000,method:'card' }, 201);
  assert.equal(promoClosed.closed,true); assert.equal(promoClosed.finalTotal,1500);
  const promoHistorical = await api(`/api/orders/${promoOrder.id}/payments`);
  assert.equal(promoHistorical.due,1500); assert.equal(promoHistorical.selectedPromotion.version,2); assert.equal(promoHistorical.offers.find((offer)=>offer.source==='promotion')?.reasonCode,'selected');
  await api(`/api/orders/${newPromoOrder.id}/payments`, 'POST', { amount:400,method:'cash' }, 201);
  const pendingBeforeActivationRace = Number((await api('/api/metrics')).pendingRevenue||0);
  const activationRaceOrder = await api('/api/orders', 'POST', { tableId: raceTableId }, 201);
  await api(`/api/orders/${activationRaceOrder.id}/items`, 'POST', { productId:promoProductId,quantity:2 }, 201);
  const raceExpectedVersion = promoV3.version;
  const [raceActivation, raceTender] = await Promise.all([
    api(`/api/loyalty/promotions/${livePromotion.promotionId}`, 'PATCH', { expectedVenueId:venueId,expectedVersion:raceExpectedVersion,status:'active',benefitValue:50 }, 200),
    api(`/api/orders/${activationRaceOrder.id}/payments`, 'POST', { amount:400,method:'cash' }, 201),
  ]);
  assert.equal(raceActivation.version,4);
  const raceReread = await api(`/api/orders/${activationRaceOrder.id}/payments`);
  assert.equal(raceReread.pricingLocked,true);
  assert.ok([400,1000].includes(raceReread.due),'the first tender linearizes wholly before or after promotion activation');
  assert.equal(raceTender.due,raceReread.due); assert.equal(raceTender.closed,raceReread.closed);
  assert.equal(raceReread.selectedPromotion.version,raceReread.due===400?3:4);
  assert.equal(Number((await api('/api/metrics')).pendingRevenue)-pendingBeforeActivationRace,raceReread.remaining,'pending revenue uses the same linearized campaign price after activation race');
  if (!raceReread.closed) await api(`/api/orders/${activationRaceOrder.id}/payments`, 'POST', { amount:raceReread.remaining,method:'card' }, 201);
  const prePolicyOrder = await api('/api/orders', 'POST', { tableId: policyTableId }, 201);
  prePolicyOrderId = prePolicyOrder.id;
  const policyV1 = await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 5, minimumRedemptionPoints: 2 }, 201);
  assert.equal(policyV1.version, 1);
  assert.equal((await api('/api/loyalty/settings')).maxRedemptionPercent, 5);
  const prePolicyQuote = await api('/api/orders/' + prePolicyOrderId + '/payments');
  assert.equal(prePolicyQuote.bonusRedemptionPolicy.version, 0);
  assert.equal(prePolicyQuote.bonusRedemptionPolicy.maxRedemptionPercent, 100, 'an open order retains settings captured on creation');
  token = managerSession.token;
  assert.equal((await api(`/api/orders/${prePolicyOrderId}/payments`)).closed, false, 'manager with orders permission can read the open-order pricing explanation');
  token = ownerToken;
  await client.query('INSERT INTO loyalty_program_settings (venue_id,version,max_redemption_percent,min_redemption_points) VALUES ($1,1,75,1)', [otherVenueId]);
  assert.equal((await api('/api/loyalty/settings')).maxRedemptionPercent, 5, 'settings from a sibling venue do not leak into the active venue response');
  assert.equal((await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 100, minimumRedemptionPoints: 1 }, 409)).error, 'loyalty_settings_version_conflict');
  assert.equal((await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: otherVenueId, expectedVersion: 1, bonusRublesPerPoint: 1, maxRedemptionPercent: 20, minimumRedemptionPoints: 2 }, 409)).error, 'venue_context_changed');
  assert.equal((await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 1, bonusRublesPerPoint: 1, maxRedemptionPercent: 5, minimumRedemptionPoints: 2, bonusExpirationDays: 30 }, 400)).error, 'unknown_loyalty_setting');
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action='loyalty.settings_version_created'", [venueId])).rows[0].count, 1);
  const topUp = await api(`/api/clients/${guestId}/deposit-top-ups`, 'POST', { amount: 50, method: 'cash', reason: 'QA wallet funding', idempotencyKey: 'qa-deposit-top-up-01' }, 201);
  assert.equal(topUp.depositBalance, 50);
  assert.equal(topUp.shiftId, shiftId);
  const topUpReplay = await api(`/api/clients/${guestId}/deposit-top-ups`, 'POST', { amount: 50, method: 'cash', reason: 'QA wallet funding', idempotencyKey: 'qa-deposit-top-up-01' }, 200);
  assert.equal(topUpReplay.idempotentReplay, true, 'replayed receipt does not increase the liability twice');
  assert.equal((await api(`/api/clients/${guestId}/deposit-top-ups`, 'POST', { amount: 51, method: 'cash', reason: 'QA wallet funding', idempotencyKey: 'qa-deposit-top-up-01' }, 409)).error, 'idempotency_key_reused');
  assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM guest_deposit_receipts WHERE venue_id=$1 AND idempotency_key=$2', [venueId, 'qa-deposit-top-up-01'])).rows[0].count, 1);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND account_type='deposit' AND source_type='deposit_top_up'", [guestId])).rows[0].count, 1);
  assert.equal((await api(`/api/orders/${orderId}/payments`)).due, 200);
  const paid = await api(`/api/orders/${orderId}/payments`, 'POST', { amount: 150, method: 'cash' }, 201);
  assert.equal(paid.remaining, 50);
  assert.equal(paid.closed, false);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND source_id=$2", [guestId, orderId])).rows[0].count, 0, 'partial payment creates no bonus movement');
  const edit = await api(`/api/orders/${orderId}/items/${itemA}`, 'PATCH', { quantity: 1 }, 409);
  assert.equal(edit.error, 'order_pricing_locked');
  assert.equal((await api(`/api/orders/${orderId}/items/${itemA}`, 'DELETE', undefined, 409)).error, 'order_pricing_locked');
  assert.equal((await api(`/api/orders/${orderId}/split`, 'POST', { itemIds: [itemA] }, 409)).error, 'order_pricing_locked');
  assert.equal((await api(`/api/orders/${orderId}/status`, 'POST', { status: 'cancelled' }, 409)).error, 'paid_order_cannot_cancel');
  assert.equal((await api(`/api/orders/${orderId}`, 'DELETE', { comment: 'QA', writeoff: false }, 409)).error, 'paid_order_cannot_cancel');
  const discountId = randomUUID();
  await client.query("INSERT INTO discounts (id,order_id,requested_by,type,value,reason,status) VALUES ($1,$2,$3,'percent',50,'QA paid conflict','requested')", [discountId, orderId, ownerId]);
  const conflict = await api(`/api/discount-requests/${discountId}/approve`, 'POST', {}, 409);
  assert.equal(conflict.error, 'order_pricing_locked', JSON.stringify(conflict));

  assert.equal((await client.query('SELECT status FROM discounts WHERE id=$1', [discountId])).rows[0].status, 'requested', 'failed decision rolled back');
  assert.equal((await api(`/api/orders/${orderId}/payments`)).due, 200, 'all failed mutations preserve bill');
  const persistedBeforeClose = await client.query('SELECT status FROM orders WHERE id=$1', [orderId]);
  assert.equal(persistedBeforeClose.rows[0].status, 'open', 'cancel/delete/split did not change the source order');
  const persistedItems = await client.query('SELECT order_id,quantity FROM order_items WHERE id=$1', [itemA]);
  assert.equal(persistedItems.rowCount, 1);
  assert.equal(persistedItems.rows[0].order_id, orderId);
  assert.equal(Number(persistedItems.rows[0].quantity), 2, 'edit, delete and split rolled back');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM orders WHERE venue_id=$1', [venueId])).rows[0].count, 7, 'failed split created no target order');
  assert.equal((await api(`/api/orders/${orderId}/payments`, 'POST', { amount: 50.01, method: 'card' }, 409)).error, 'payment_exceeds_due');
  const final = await api(`/api/orders/${orderId}/payments`, 'POST', { amount: 50, method: 'card' }, 201);
  assert.equal(final.closed, true);
  assert.equal(final.paid, 200);
  assert.equal(final.loyaltyBonusPercent, 5);
  assert.equal(final.loyaltyBonusBase, 200);
  assert.equal(final.loyaltyBonusEarned, 10);
  assert.equal(final.loyaltyBonusBalance, 10);
  const closeReadback = await api(`/api/orders/${orderId}/payments`);
  assert.equal(closeReadback.closed, true, 'payment readback identifies a closed order');
  assert.deepEqual([closeReadback.loyaltyBonusBase, closeReadback.loyaltyBonusPercent, closeReadback.loyaltyBonusEarned], [200, 5, 10], 'the closed-order UI fields match the persisted award snapshot');
  const closedOrder = await client.query('SELECT status,loyalty_bonus_percent,loyalty_bonus_base,loyalty_bonus_earned FROM orders WHERE id=$1', [orderId]);
  assert.equal(closedOrder.rows[0].status, 'closed');
  assert.deepEqual([Number(closedOrder.rows[0].loyalty_bonus_percent), Number(closedOrder.rows[0].loyalty_bonus_base), closedOrder.rows[0].loyalty_bonus_earned], [5, 200, 10]);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND account_type='bonus' AND source_id=$2 AND amount=10", [guestId, orderId])).rows[0].count, 1, 'closing order creates exactly one durable bonus movement');

  await client.query("INSERT INTO orders (id,venue_id,opened_by,status) VALUES ($1,$2,$3,'open')", [groupOrderId, venueId, ownerId]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,2,100,'bar')", [groupOrderItemId, groupOrderId, productId]);
  const linked = await api(`/api/orders/${groupOrderId}`, 'PATCH', { clientId: guestId });
  assert.equal(linked.groupDiscountPercent, 10);
  assert.equal(linked.source, 'guest_group');
  assert.equal(linked.discount, 20);
  assert.equal(linked.due, 180);
  await client.query('UPDATE guest_discount_groups SET discount_percent=40 WHERE id=$1', [groupId]);
  const capturedQuote = await api(`/api/orders/${groupOrderId}/summary`);
  assert.equal(capturedQuote.groupDiscountPercent, 10, 'open order keeps the captured group rate after policy edits');
  assert.equal(capturedQuote.due, 180);
  const groupPartial = await api(`/api/orders/${groupOrderId}/payments`, 'POST', { amount: 150, method: 'cash' }, 201);
  assert.equal(groupPartial.closed, false);
  assert.equal((await api(`/api/orders/${groupOrderId}/payments`)).pricingLocked, true, 'first accepted tender fixes complete price');
  assert.equal((await api(`/api/orders/${groupOrderId}/items/${groupOrderItemId}`, 'PATCH', { quantity: 3 }, 409)).error, 'order_pricing_locked');
  assert.equal((await api(`/api/orders/${groupOrderId}`, 'PATCH', { clientId: null }, 409)).error, 'order_pricing_locked');
  const groupFinal = await api(`/api/orders/${groupOrderId}/payments`, 'POST', { amount: 30, method: 'card' }, 201);
  assert.equal(groupFinal.closed, true);
  assert.equal(groupFinal.groupDiscountAmount, 20);
  assert.equal(groupFinal.effectiveDiscountSource, 'guest_group');
  assert.equal(groupFinal.finalTotalSnapshot, 180);
  assert.equal(groupFinal.loyaltyBonusBase, 180);
  assert.equal(groupFinal.loyaltyBonusEarned, 9);
  const groupSnapshot = await client.query('SELECT group_discount_group_id,group_discount_name,group_discount_percent,group_discount_base,group_discount_amount,effective_discount_source,subtotal_snapshot,discount_total_snapshot,minimum_adjustment_snapshot,final_total_snapshot,pricing_version FROM orders WHERE id=$1', [groupOrderId]);
  assert.deepEqual([groupSnapshot.rows[0].group_discount_group_id,groupSnapshot.rows[0].group_discount_name,Number(groupSnapshot.rows[0].group_discount_percent),Number(groupSnapshot.rows[0].group_discount_base),Number(groupSnapshot.rows[0].group_discount_amount),groupSnapshot.rows[0].effective_discount_source,Number(groupSnapshot.rows[0].subtotal_snapshot),Number(groupSnapshot.rows[0].discount_total_snapshot),Number(groupSnapshot.rows[0].minimum_adjustment_snapshot),Number(groupSnapshot.rows[0].final_total_snapshot),groupSnapshot.rows[0].pricing_version], [groupId,'QA accrual 5%',10,200,20,'guest_group',200,20,0,180,1]);
  assert.equal((await api(`/api/orders/${groupOrderId}/summary`)).due, 180, 'closed-order repricing uses its durable snapshot');
  await client.query('UPDATE guest_discount_groups SET discount_percent=40 WHERE id=$1', [groupId]);
  assert.equal((await api(`/api/orders/${groupOrderId}/payments`)).due, 180, 'closed bill is stable after group policy changes');
  assert.equal((await client.query('SELECT loyalty_points FROM guests WHERE id=$1', [guestId])).rows[0].loyalty_points, 19, 'group-discount order awards 9 more points');
  assert.equal((await api(`/api/orders/${orderId}/payments`, 'POST', { amount: 1, method: 'cash' }, 409)).error, 'order_already_final', 'a retry cannot award the closed order twice');

  assert.equal((await api(`/api/orders/${groupOrderId}/payments`)).guestAccount.bonusBalance, 19);
  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,loyalty_redemption_policy_version,loyalty_redemption_rate,loyalty_redemption_cap_percent,loyalty_redemption_min_points) VALUES ($1,$2,$3,'open',1,1,5,2)", [redeemOrderId, venueId, ownerId]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,2,100,'bar')", [redeemOrderItemId, redeemOrderId, productId]);
  await api(`/api/orders/${redeemOrderId}`, 'PATCH', { clientId: guestId });
  const redeemQuote = await api(`/api/orders/${redeemOrderId}/payments`);
  assert.equal(redeemQuote.due, 120);
  assert.equal(redeemQuote.guestAccount.bonusBalance, 19);
  assert.equal(redeemQuote.guestAccount.depositBalance, 50);
  assert.equal(redeemQuote.guestAccount.bonusPercent, 5);
  assert.equal(redeemQuote.bonusRedemptionRemaining, 6);
  assert.equal(redeemQuote.bonusRedemptionPolicy.version, 1);
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 1.5, method: 'bonus', idempotencyKey: 'qa-pg-invalid' }, 400)).error, 'invalid_bonus_points');
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 20, method: 'bonus', idempotencyKey: 'qa-pg-insufficient-1' }, 409)).error, 'bonus_redemption_limit_exceeded');
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 51, method: 'deposit', idempotencyKey: 'qa-pg-deposit-insufficient' }, 409)).error, 'insufficient_deposit_balance');
  const depositPayment = await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 25.50, method: 'deposit', idempotencyKey: 'qa-pg-deposit-tender-01' }, 201);
  assert.equal(depositPayment.guestAccount.depositBalance, 24.5);
  const depositReplay = await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 25.50, method: 'deposit', idempotencyKey: 'qa-pg-deposit-tender-01' }, 200);
  assert.equal(depositReplay.idempotentReplay, true);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND source_id=$2 AND account_type='deposit' AND amount=-25.50", [guestId, redeemOrderId])).rows[0].count, 1);
  assert.equal((await api('/api/orders/' + redeemOrderId + '/payments', 'POST', { amount: 1, method: 'bonus', idempotencyKey: 'qa-pg-bonus-below-minimum' }, 409)).error, 'bonus_redemption_below_minimum');
  assert.equal((await api('/api/orders/' + redeemOrderId + '/payments', 'POST', { amount: 7, method: 'bonus', idempotencyKey: 'qa-pg-bonus-over-cap' }, 409)).error, 'bonus_redemption_limit_exceeded');
  const bonusPayment = await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-pg-bonus-redeem-01' }, 201);
  assert.equal(bonusPayment.guestAccount.bonusBalance, 14);
  assert.equal(bonusPayment.shiftId, shiftId, 'noncash bonus tender is attributed to the active shift');
  assert.equal(bonusPayment.closed, false);
  assert.equal((await api('/api/orders/' + redeemOrderId + '/payments')).bonusRedemptionRemaining, 1);
  await client.query(`CREATE FUNCTION qa_reject_order_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN IF NEW.action='order.payment_added' THEN RAISE EXCEPTION 'qa payment audit failure'; END IF; RETURN NEW; END $function$`);
  await client.query(`CREATE TRIGGER qa_reject_order_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa_reject_order_payment_audit()`);
  const beforeRejectedPaymentBalance = Number((await client.query('SELECT loyalty_points FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId])).rows[0].loyalty_points);
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 1, method: 'cash', idempotencyKey: 'qa-payment-audit-failure' }, 409)).error, 'payment_create_failed');
  assert.equal(Number((await client.query('SELECT loyalty_points FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId])).rows[0].loyalty_points), beforeRejectedPaymentBalance, 'a rejected payment audit rolls back its balance movement');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM payments WHERE order_id=$1 AND idempotency_key=$2', [redeemOrderId, 'qa-payment-audit-failure'])).rows[0].count, 0, 'a rejected payment audit rolls back its payment receipt');
  await client.query('DROP TRIGGER qa_reject_order_payment_audit ON audit_events');
  await client.query('DROP FUNCTION qa_reject_order_payment_audit()');
  await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 1, bonusRublesPerPoint: 1, maxRedemptionPercent: 50, minimumRedemptionPoints: 1 }, 201);
  assert.equal((await api('/api/orders/' + redeemOrderId + '/payments')).bonusRedemptionPolicy.version, 1);
  await client.query(`CREATE FUNCTION qa_reject_loyalty_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN IF NEW.action='loyalty.settings_version_created' THEN RAISE EXCEPTION 'qa audit failure'; END IF; RETURN NEW; END $function$`);
  await client.query(`CREATE TRIGGER qa_reject_loyalty_settings_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa_reject_loyalty_settings_audit()`);
  assert.equal((await api('/api/loyalty/settings', 'PATCH', { expectedVenueId: venueId, expectedVersion: 2, bonusRublesPerPoint: 1, maxRedemptionPercent: 60, minimumRedemptionPoints: 1 }, 503)).error, 'loyalty_settings_save_failed');
  await client.query('DROP TRIGGER qa_reject_loyalty_settings_audit ON audit_events');
  await client.query('DROP FUNCTION qa_reject_loyalty_settings_audit()');
  assert.equal((await api('/api/loyalty/settings')).version, 2, 'audit failure rolls back the new version');
  const replay = await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-pg-bonus-redeem-01' }, 200);
  assert.equal(replay.idempotentReplay, true);
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 6, method: 'bonus', idempotencyKey: 'qa-pg-bonus-redeem-01' }, 409)).error, 'idempotency_key_reused');
  const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(new Date());
  const shiftReport = await api(`/api/dashboard/shift-kpis?date=${reportDate}&shiftId=${shiftId}`);
  assert.equal(shiftReport.totals.other, 30.5, 'shift payment breakdown includes bonus and stored-value tenders as other');
  assert.deepEqual(shiftReport.totals.depositTopUps, { total: 50, cash: 50, cashless: 0, count: 1 }, 'wallet funding is reported separately from order revenue');
  const actualShiftCash = Number((await client.query("SELECT COALESCE(SUM(amount),0) AS cash FROM payments WHERE shift_id=$1 AND method='cash'", [shiftId])).rows[0].cash);
  assert.equal(shiftReport.totals.cash, actualShiftCash, 'shift cash matches cash tenders and excludes noncash bonus tender');
  const redeemedClose = await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 89.5, method: 'cash', idempotencyKey: 'qa-pg-bonus-cash-0001' }, 201);
  assert.equal(redeemedClose.closed, true);
  assert.equal(redeemedClose.loyaltyBonusBase, 115, 'new bonus accrual excludes bonus tender but counts stored value paid toward the sale');
  assert.equal(redeemedClose.loyaltyBonusEarned, 5);
  const redeemPayments = await api(`/api/orders/${redeemOrderId}/payments`);
  assert.equal(redeemPayments.paid, 120);
  assert.equal(redeemPayments.items.filter((entry) => entry.method === 'bonus').length, 1);
  assert.equal(redeemPayments.guestAccount.bonusBalance, 19);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND source_id=$2 AND account_type='bonus' AND amount=-5", [guestId, redeemOrderId])).rows[0].count, 1);
  assert.equal((await client.query("SELECT COALESCE(SUM(amount),0) AS cash FROM payments WHERE order_id=$1 AND method='cash'", [redeemOrderId])).rows[0].cash, '89.50');
  assert.equal((await client.query("SELECT COALESCE(SUM(amount),0) AS cash FROM payments WHERE order_id=$1 AND method='bonus'", [redeemOrderId])).rows[0].cash, '5.00');
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 5, method: 'bonus', idempotencyKey: 'qa-pg-bonus-redeem-01' }, 200)).idempotentReplay, true, 'bonus POST replay still returns its prior result after close');
  assert.equal((await api(`/api/orders/${redeemOrderId}/payments`, 'POST', { amount: 25.50, method: 'deposit', idempotencyKey: 'qa-pg-deposit-tender-01' }, 200)).idempotentReplay, true, 'deposit tender replay still returns its prior result after close');

  for (let index = 0; index < raceOrderIds.length; index += 1) {
    await client.query("INSERT INTO orders (id,venue_id,opened_by,status) VALUES ($1,$2,$3,'open')", [raceOrderIds[index], venueId, ownerId]);
    await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,1,100,'bar')", [raceItemIds[index], raceOrderIds[index], productId]);
    await api(`/api/orders/${raceOrderIds[index]}`, 'PATCH', { clientId: raceGuestId });
  }
  const concurrentRedemptions = await Promise.all(raceOrderIds.map(async (id, index) => {
    const response = await fetch(`${base}/api/orders/${id}/payments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 7, method: 'bonus', idempotencyKey: `qa-concurrent-bonus-${index}` }) });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(concurrentRedemptions.map((entry) => entry.status).sort(), [201, 409], 'guest row lock prevents two orders overspending the same bonus balance');
  assert.equal(concurrentRedemptions.find((entry) => entry.status === 409).body.error, 'insufficient_bonus_balance');
  assert.equal(Number((await client.query('SELECT loyalty_points FROM guests WHERE id=$1 AND venue_id=$2', [raceGuestId, venueId])).rows[0].loyalty_points), 3);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND account_type='bonus' AND source_id=ANY($2::uuid[]) AND amount=-7", [raceGuestId, raceOrderIds])).rows[0].count, 1);
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM payments WHERE order_id=ANY($1::uuid[]) AND method='bonus'", [raceOrderIds])).rows[0].count, 1);

  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,vip_minimum) VALUES ($1,$2,$3,'open',250)", [vipOrderId, venueId, ownerId]);
  await client.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,1,100,'bar')", [vipItemId, vipOrderId, productId]);
  await api(`/api/orders/${vipOrderId}`, 'PATCH', { clientId: guestId });
  await client.query("INSERT INTO discounts (order_id,requested_by,type,value,reason,status) VALUES ($1,$2,'percent',10,'QA loyalty base','approved')", [vipOrderId, ownerId]);
  const vipClose = await api(`/api/orders/${vipOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(vipClose.finalTotal, 250);
  assert.equal(vipClose.source, 'guest_group', 'better group discount wins over a smaller manual discount');
  assert.equal(vipClose.discount, 40);
  assert.equal(vipClose.loyaltyBonusBase, 60, 'best discount reduces the bonus base while VIP minimum uplift stays excluded');
  assert.equal(vipClose.loyaltyBonusEarned, 3, 'fractional points are rounded down');
  assert.equal(vipClose.loyaltyBonusBalance, 22);
  assert.equal((await api(`/api/orders/${vipOrderId}/payments`)).loyaltyBonusEarned, 3, 'direct-close snapshot is available after reread');
  assert.equal((await client.query("SELECT count(*)::int AS count FROM guest_account_entries WHERE guest_id=$1 AND account_type='bonus' AND source_id=$2 AND amount=3", [guestId, vipOrderId])).rows[0].count, 1);
  assert.equal((await api(`/api/orders/${vipOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409)).error, 'order_already_final', 'duplicate direct close cannot award twice');
  const discountPolicyOrderId = randomUUID();
  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,vip_minimum) VALUES ($1,$2,$3,'open',0)", [discountPolicyOrderId, venueId, ownerId]);
  await client.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,1,100,'bar')", [discountPolicyOrderId, productId]);
  await api(`/api/orders/${discountPolicyOrderId}`, 'PATCH', { clientId: guestId });
  const firstManualDiscount = await api(`/api/orders/${discountPolicyOrderId}/discount-requests`, 'POST', { type: 'percent', value: 100, reason: 'QA first approved discount' }, 201);
  await api(`/api/discount-requests/${firstManualDiscount.id}/approve`, 'POST', {}, 200);
  const secondManualDiscount = await api(`/api/orders/${discountPolicyOrderId}/discount-requests`, 'POST', { type: 'percent', value: 50, reason: 'QA second sequential request' }, 201);
  assert.equal((await api(`/api/discount-requests/${secondManualDiscount.id}/approve`, 'POST', {}, 409)).error, 'approved_discount_exists', 'PostgreSQL blocks a second approved discount under order lock');
  assert.equal((await api(`/api/orders/${discountPolicyOrderId}/payments`)).due, 0, 'approved discount cannot create a negative payable total');
  assert.equal((await api(`/api/orders/${discountPolicyOrderId}/summary`)).source, 'manual', 'larger approved manual discount replaces the group offer instead of stacking');
  const concurrentDiscountOrderId = randomUUID(); const concurrentDiscountIds = [randomUUID(), randomUUID()];
  await client.query("INSERT INTO orders (id,venue_id,opened_by,status,vip_minimum) VALUES ($1,$2,$3,'open',0)", [concurrentDiscountOrderId, venueId, ownerId]);
  await client.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,1,100,'bar')", [concurrentDiscountOrderId, productId]);
  for (const [index, id] of concurrentDiscountIds.entries()) await client.query("INSERT INTO discounts (id,order_id,requested_by,type,value,reason,status) VALUES ($1,$2,$3,'percent',$4,$5,'requested')", [id, concurrentDiscountOrderId, ownerId, index + 10, `QA concurrent decision ${index}`]);
  const concurrentResults = await Promise.all(concurrentDiscountIds.map(async (id) => {
    const response = await fetch(`${base}/api/discount-requests/${id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(concurrentResults.map((entry) => entry.status).sort(), [200, 409], 'order row lock serializes concurrent approvals to one winner');
  assert.equal(concurrentResults.find((entry) => entry.status === 409).body.error, 'approved_discount_exists');
  const persistedPayments = await client.query('SELECT amount FROM payments WHERE order_id=$1 ORDER BY created_at', [orderId]);
  assert.deepEqual(persistedPayments.rows.map((row) => Number(row.amount)).sort((a, b) => a - b), [50, 150], 'exactly two payments persisted');
  assert.equal(persistedPayments.rows.reduce((sum, row) => sum + Number(row.amount), 0), 200, 'bonus award is a ledger liability, not an additional cash/card payment');
  const cashComponents = await client.query("SELECT (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.shift_id=$2 AND p.method='cash' AND p.status IN ('paid','partially_paid')) + (SELECT COALESCE(SUM(amount),0) FROM guest_deposit_receipts WHERE venue_id=$1 AND shift_id=$2 AND payment_method='cash') AS amount", [venueId, shiftId]);
  const cashClose = await api(`/api/shifts/${shiftId}/close`, 'POST', { checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } }, closingCash: Number(cashComponents.rows[0].amount) }, 200);
  assert.equal(Number(cashClose.expectedCash), Number(cashComponents.rows[0].amount), 'cash wallet funding is reconciled without adding it to sales revenue');
  passed = true;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  if (serverExitPromise && server?.exitCode === null && server?.signalCode === null) {
    await Promise.race([serverExitPromise, delay(3000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    await Promise.race([serverExitPromise, delay(3000)]);
  }
  if (client._connected) {
    const cleanupErrors = [];
    await client.query('DROP TRIGGER IF EXISTS qa_reject_order_payment_audit ON audit_events').catch((error) => cleanupErrors.push(error));
    await client.query('DROP FUNCTION IF EXISTS qa_reject_order_payment_audit()').catch((error) => cleanupErrors.push(error));
    for (const [query, params] of [
      ['DELETE FROM auth_sessions WHERE user_id=$1', [ownerId]],
      ['DELETE FROM guest_deposit_receipts WHERE venue_id=$1', [venueId]],
      ['DELETE FROM guest_account_entries WHERE venue_id=$1', [venueId]],
      ['DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]],
      ['DELETE FROM discounts WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]],
      ['DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]],
      ['DELETE FROM order_costs WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]],
      ['DELETE FROM orders WHERE venue_id=$1', [venueId]],
      ['DELETE FROM tables WHERE id=$1', [policyTableId]],
      ['DELETE FROM tables WHERE id=$1', [promoTableId]],
      ['DELETE FROM tables WHERE id=$1', [raceTableId]],
      ['DELETE FROM zones WHERE id=$1', [zoneId]],
      ['DELETE FROM guests WHERE venue_id=$1', [venueId]],
      ['DELETE FROM guest_discount_groups WHERE venue_id=$1', [venueId]],
      ['DELETE FROM shifts WHERE venue_id=$1', [venueId]],
      ['DELETE FROM audit_events WHERE venue_id=$1', [venueId]],
      ['DELETE FROM organization_memberships WHERE organization_id=$1', [organizationId]],
    ]) {
      try { await client.query(query, params); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET venue_id=NULL WHERE id=ANY($1::uuid[])', [[ownerId, managerId]]);
      await client.query('DELETE FROM products WHERE venue_id=ANY($1::uuid[])', [[venueId, otherVenueId]]);
      await client.query('DELETE FROM venues WHERE id=ANY($1::uuid[])', [[otherVenueId, venueId]]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      cleanupErrors.push(error);
    }
    for (const [query, params] of [
      ['DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [[ownerId, managerId]]],
      ['DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, managerId]]],
      ['DELETE FROM organization_subscriptions WHERE organization_id=$1', [organizationId]],
      ['DELETE FROM organizations WHERE id=$1', [organizationId]],
    ]) {
      try { await client.query(query, params); } catch (error) { cleanupErrors.push(error); }
    }
    const guards = await client.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname IN ('loyalty_program_settings_immutable','loyalty_promotions_immutable','loyalty_promotion_scopes_immutable')
        AND tgenabled='O'`).catch((error) => { cleanupErrors.push(error); return null; });
    if (guards) {
      try { assert.equal(guards.rows[0].count, 3, 'QA cleanup leaves every immutable loyalty trigger enabled'); }
      catch (error) { cleanupErrors.push(error); }
    }
    const residue = await client.query('SELECT count(*)::int AS count FROM venues WHERE id=$1', [venueId])
      .catch((error) => { cleanupErrors.push(error); return null; });
    await client.end().catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'QA fixture cleanup failed');
    if (residue) assert.equal(residue.rows[0].count, 0, 'QA venue and child records were removed');
  }
}
if (passed) console.log('PAID ORDER BALANCE POSTGRES QA: PASS (HTTP transactions, rollback, exact balance, close, cleanup)');
