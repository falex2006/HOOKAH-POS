import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

// This suite creates business source facts through authenticated HTTP. SQL is
// restricted to a runner-owned disposable database, setup, evidence and attacks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^(?:orders|payables)_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'runner ownership is mandatory');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
assert.equal(target.url.hostname, '127.0.0.1');
assert.equal(target.url.port, '31931');
const db = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = Object.fromEntries(['org', 'otherOrg', 'venue', 'otherVenue', 'owner', 'seller', 'foreignOwner'].map(key => [key, randomUUID()]));
const marker = randomUUID().slice(0, 8), password = `qa-${randomUUID()}`;
const logins = Object.fromEntries(['owner', 'seller', 'foreignOwner'].map(key => [key, `recognition-${key}-${marker}`]));
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const evidence = { suite: 'pos-payroll-recognition', source: 'authenticated_http', officialPayrollReadinessAttested: false, checks: [] };
const evidenceDir = path.join(root, 'tmp', 'pos-payroll-recognition-qa', `${Date.now()}-${process.pid}`);
let server, output = '', base = '', token = '', ownerToken, sellerToken, foreignToken;
let cashAccount, cardAccount, product, zone, shift;
const check = (name, detail = {}) => { evidence.checks.push({ name, ...detail }); console.log(`PASS: ${name}`); };
const api = async (route, method = 'GET', body, expected = 200, bearer = token) => {
  const organization = body?.username === logins.foreignOwner || (foreignToken && bearer === foreignToken) ? ids.otherOrg : ids.org;
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'X-Organization-Id': organization, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: ${response.status} ${JSON.stringify(payload)}`);
  return { status: response.status, ...payload };
};
const verifyProducerWaitsForPayrollSnapshot = async (route, method, body, expected = 200, bearer = token) => {
  const blocker = new Client({ connectionString: target.url.href });
  await blocker.connect();
  const key = `payroll-official-source-v1:${ids.venue.toLowerCase()}`;
  await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
  let blocked = false;
  const pending = api(route, method, body, expected, bearer);
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock_shared%') AS blocked");
      if (state.rows[0]?.blocked) { blocked = true; break; }
      await delay(25);
    }
  } finally {
    await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
    await blocker.end();
  }
  const result = await pending;
  assert.equal(blocked, true, `${method} ${route} waits for payroll source snapshot fence`);
  return result;
};
const table = async name => api('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: zone.id, name: `${name}-${marker}`, capacity: 2 }, 201);
const openOrder = async (name, quantity = 3) => {
  const seat = await table(name);
  const order = await api('/api/orders', 'POST', { tableId: seat.id }, 201);
  const line = await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity }, 201, sellerToken);
  assert.equal(line.salesEmployeeId, ids.seller, 'seller is captured by server from authenticated staff');
  return { order, line, seat };
};
const payments = async orderId => (await db.query('SELECT id,amount::text,method FROM payments WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows;
const refundBody = (paymentId, quantity, key, amount = 1) => ({ amount, reason: 'Synthetic recognition acceptance', idempotencyKey: key, allocations: [{ sourcePaymentId: paymentId, amount, payoutMethod: 'card', paymentAccountId: cardAccount }], ...(quantity === null ? { noItemReturn: true, items: [] } : { items: [{ orderItemId: quantity.itemId, quantity: quantity.quantity }] }) });
const rejectedSql = async (name, action, expected = /./) => {
  await db.query('BEGIN');
  let caught;
  try { await action(db); await db.query('SET CONSTRAINTS ALL IMMEDIATE'); }
  catch (error) { caught = error; }
  finally { await db.query('ROLLBACK'); }
  assert.ok(caught, `${name}: SQL must reject before commit`);
  assert.match(caught.message, expected, name);
  check(name, { sqlState: caught.code });
};

try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() database,inet_server_addr()::text address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, 31931, 'POS payroll recognition QA');
  await db.query('BEGIN');
  try {
    for (const organization of [ids.org, ids.otherOrg]) {
      await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Recognition QA',$2,'network')", [organization, `recognition-${organization}`]);
      await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'network','active',30,10)", [organization]);
    }
    for (const venue of [ids.venue, ids.otherVenue]) await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Recognition QA','Asia/Yekaterinburg')", [venue, venue === ids.venue ? ids.org : ids.otherOrg]);
    for (const key of ['owner', 'seller', 'foreignOwner']) {
      const organization = key === 'foreignOwner' ? ids.otherOrg : ids.org;
      await db.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb)", [ids[key], key === 'foreignOwner' ? ids.otherVenue : ids.venue, organization, `QA ${key}`, logins[key], hash, key === 'seller' ? 'bartender' : 'owner']);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [organization, ids[key], key === 'seller' ? 'member' : 'owner']);
    }
    cardAccount = randomUUID();
    await db.query("INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by) VALUES($1,$2,'recognition_bank','QA bank','bank',ARRAY['card']::text[],$3)", [cardAccount, ids.venue, ids.owner]);
    cashAccount = (await db.query("SELECT id FROM finance_accounts WHERE venue_id=$1 AND code='main_cashbox'", [ids.venue])).rows[0].id;
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  const venueEpoch = (await db.query('SELECT to_jsonb(e) AS fact FROM pos_payroll_recognition_epochs e WHERE venue_id=$1', [ids.venue])).rows[0].fact;
  assert.equal(venueEpoch.activation_scope, 'new_venue');
  assert.equal(venueEpoch.policy_version, 1);
  assert.ok(venueEpoch.activated_at);
  assert.equal(venueEpoch.timezone_snapshot, 'Asia/Yekaterinburg');
  check('new venue receives server-owned recognition epoch at venue creation');
  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error('Isolated QA server failed to start');
    else await delay(50);
  }
  assert.ok(base, 'isolated server starts');
  assert.equal((await api('/api/health')).database, 'postgres');
  ownerToken = (await api('/api/login', 'POST', { username: logins.owner, password }, 200)).token;
  sellerToken = (await api('/api/login', 'POST', { username: logins.seller, password }, 200)).token;
  foreignToken = (await api('/api/login', 'POST', { username: logins.foreignOwner, password }, 200)).token;
  token = ownerToken;
  zone = await api('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: `Recognition ${marker}` }, 201);
  product = await api('/api/products', 'POST', { name: `Recognition ${marker}`, category: 'Бар', price: 100.50, inventoryMode: 'non_stock' }, 201);
  shift = await api('/api/shifts', 'POST', { openingCash: 0 }, 201);

  const fencedClose = await openOrder('Source fence close', 1);
  await verifyProducerWaitsForPayrollSnapshot(`/api/orders/${fencedClose.order.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
  check('authenticated sale close waits behind payroll source snapshot fence');

  const sale = await openOrder('Partial tender');
  const discount = await api(`/api/orders/${sale.order.id}/discount-requests`, 'POST', { type: 'percent', value: 1, reason: 'QA penny allocation' }, 201);
  await api(`/api/discount-requests/${discount.id}/approve`, 'POST', {}, 200);
  const partial = await api(`/api/orders/${sale.order.id}/payments`, 'POST', { amount: 10, method: 'card', paymentAccountId: cardAccount }, 201);
  assert.equal(partial.closed, false);
  assert.equal(partial.remaining, 288.48);
  const frozenPricing = (await db.query('SELECT to_jsonb(s) AS facts FROM pos_order_pricing_snapshots s WHERE venue_id=$1 AND order_id=$2', [ids.venue, sale.order.id])).rows;
  assert.equal(frozenPricing.length, 1);
  assert.equal((await api(`/api/orders/${sale.order.id}/items/${sale.line.id}`, 'DELETE', undefined, 409)).error, 'order_pricing_locked');
  assert.equal((await api(`/api/orders/${sale.order.id}/split`, 'POST', { itemIds: [sale.line.id] }, 409)).error, 'order_pricing_locked');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pos_payroll_sale_events WHERE order_id=$1', [sale.order.id])).rows[0].n, 0, 'first tender freezes pricing but does not recognize a sale');
  await db.query('UPDATE users SET venue_id=$1 WHERE id=$2', [ids.otherVenue, ids.seller]);
  await api(`/api/orders/${sale.order.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
  assert.deepEqual((await db.query('SELECT to_jsonb(s) AS facts FROM pos_order_pricing_snapshots s WHERE venue_id=$1 AND order_id=$2', [ids.venue, sale.order.id])).rows, frozenPricing, 'closing uses the first-tender frozen pricing');
  check('HTTP order/item/discount/partial tender/close preserve immutable pricing and reject locked split/delete');
  const salePayments = await payments(sale.order.id);
  const originalTender = salePayments.find(payment => payment.amount === '10.00');
  assert.ok(originalTender);
  const source = (await db.query('SELECT * FROM pos_payroll_sale_events WHERE venue_id=$1 AND order_id=$2', [ids.venue, sale.order.id])).rows[0];
  assert.equal(source.coverage_status, 'complete');
  assert.equal(source.timezone_snapshot, 'Asia/Yekaterinburg');
  const sourceLine = (await db.query('SELECT * FROM pos_payroll_sale_line_events WHERE sale_event_id=$1', [source.id])).rows[0];
  assert.equal(sourceLine.seller_id, ids.seller);
  assert.equal(sourceLine.eligibility_status, 'same_venue');
  assert.equal(sourceLine.employee_venue_id, ids.venue, 'eligibility was frozen when staff added the item, before moving venue');
  await db.query('UPDATE users SET venue_id=$1 WHERE id=$2', [ids.venue, ids.seller]);
  const saleFacts = (await db.query('SELECT to_jsonb(s) AS fact FROM pos_payroll_sale_events s WHERE id=$1', [source.id])).rows[0].fact;
  await db.query("UPDATE venues SET timezone='Pacific/Honolulu' WHERE id=$1", [ids.venue]);
  const firstBody = refundBody(originalTender.id, { itemId: sale.line.id, quantity: 1 }, `first-${marker}`);
  const firstRefund = await verifyProducerWaitsForPayrollSnapshot(`/api/finance/orders/${sale.order.id}/refunds`, 'POST', firstBody, 201);
  const readRefund = async refundId => (await db.query('SELECT to_jsonb(e) AS fact FROM pos_payroll_refund_events e WHERE venue_id=$1 AND refund_id=$2', [ids.venue, refundId])).rows[0]?.fact;
  const firstRecognition = await readRefund(firstRefund.id);
  assert.equal(firstRecognition.coverage_status, 'complete');
  assert.equal(firstRecognition.original_sale_event_id, source.id);
  assert.equal(firstRecognition.timezone_snapshot, 'Pacific/Honolulu');
  assert.equal(firstRecognition.payout_minor, 100);
  assert.equal(firstRecognition.tender_total_minor, 100);
  const firstLine = (await db.query('SELECT * FROM pos_payroll_refund_line_events WHERE refund_event_id=$1', [firstRecognition.id])).rows[0];
  assert.equal(firstLine.original_sale_line_event_id, sourceLine.id);
  assert.equal(Number(firstLine.returned_item_value_minor), 9949, '29848 minor over3 units rounds first return to9949, independently from100 payout');
  await db.query("UPDATE venues SET timezone='Asia/Yekaterinburg' WHERE id=$1", [ids.venue]);
  const replay = await api(`/api/finance/orders/${sale.order.id}/refunds`, 'POST', firstBody, 200);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.id, firstRefund.id);
  assert.deepEqual(await readRefund(firstRefund.id), firstRecognition, 'replay does not redate or recreate immutable recognition');
  assert.deepEqual((await db.query('SELECT to_jsonb(s) AS fact FROM pos_payroll_sale_events s WHERE id=$1', [source.id])).rows[0].fact, saleFacts);
  assert.deepEqual((await db.query('SELECT to_jsonb(e) AS fact FROM pos_payroll_recognition_epochs e WHERE venue_id=$1', [ids.venue])).rows[0].fact, venueEpoch, 'timezone changes do not reset activation epoch');
  await api(`/api/finance/orders/${sale.order.id}/refunds`, 'POST', { ...firstBody, reason: 'changed' }, 409);
  await api(`/api/finance/orders/${sale.order.id}/refunds`, 'GET', undefined, [403, 404], foreignToken);
  check('HTTP refund/replay conserves payout and merchandise amounts, waits for source fence, and preserves tenant/timezone facts');

  const secondRefund = await api(`/api/finance/orders/${sale.order.id}/refunds`, 'POST', refundBody(originalTender.id, { itemId: sale.line.id, quantity: 2 }, `second-${marker}`), 201);
  const secondRecognition = await readRefund(secondRefund.id);
  assert.equal(secondRecognition.coverage_status, 'complete');
  const secondLine = (await db.query('SELECT * FROM pos_payroll_refund_line_events WHERE refund_event_id=$1', [secondRecognition.id])).rows[0];
  assert.equal(Number(secondLine.producer_sequence), 2);
  assert.equal(Number(secondLine.previous_returned_item_value_minor), 9949);
  assert.equal(Number(secondLine.returned_item_value_minor), 19899);
  assert.equal(Number(secondLine.cumulative_returned_item_value_minor), 29848);
  check('partial then complete item return preserves cumulative rounding and source sequence');

  const splitSource = await openOrder('Split source', 1);
  const moved = await api(`/api/orders/${splitSource.order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201, sellerToken);
  const deleted = await api(`/api/orders/${splitSource.order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201, sellerToken);
  const attributionBefore = (await db.query('SELECT payroll_attribution_captured_at,payroll_eligibility_status,sales_employee_id,sold_at FROM order_items WHERE id=$1', [moved.id])).rows[0];
  await api(`/api/orders/${splitSource.order.id}/items/${deleted.id}`, 'DELETE');
  const split = await api(`/api/orders/${splitSource.order.id}/split`, 'POST', { itemIds: [moved.id] }, 201);
  assert.deepEqual((await db.query('SELECT payroll_attribution_captured_at,payroll_eligibility_status,sales_employee_id,sold_at FROM order_items WHERE id=$1', [moved.id])).rows[0], attributionBefore);
  await api(`/api/orders/${split.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
  assert.equal((await db.query('SELECT coverage_status FROM pos_payroll_sale_events WHERE order_id=$1', [split.id])).rows[0].coverage_status, 'complete');
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_payroll_sale_line_events WHERE order_item_id=$1', [deleted.id])).rows[0].n, 0);
  check('open item delete and same-venue split work; moved item retains original attribution and recognizes only once');

  const auto = await openOrder('Payment auto close', 1);
  const automaticallyClosed = await api(`/api/orders/${auto.order.id}/payments`, 'POST', { amount: 100.50, method: 'card', paymentAccountId: cardAccount }, 201);
  assert.equal(automaticallyClosed.closed, true);
  const autoFacts = (await db.query('SELECT coverage_status FROM pos_payroll_sale_events WHERE order_id=$1', [auto.order.id])).rows;
  assert.deepEqual(autoFacts, [{ coverage_status: 'complete' }]);
  check('actual final payment auto-close produces exactly one complete sale event');
  const emptySeat = await table('Known empty sale');
  const emptyOrder = await api('/api/orders', 'POST', { tableId: emptySeat.id }, 201);
  await api(`/api/orders/${emptyOrder.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
  const emptyFact = (await db.query('SELECT e.coverage_status,s.final_total_minor::text,(SELECT count(*)::int FROM pos_payroll_sale_line_events l WHERE l.sale_event_id=e.id) line_count FROM pos_payroll_sale_events e JOIN pos_order_pricing_snapshots s ON s.id=e.snapshot_id WHERE e.order_id=$1', [emptyOrder.id])).rows[0];
  assert.deepEqual(emptyFact, { coverage_status: 'complete', final_total_minor: '0', line_count: 0 });
  check('HTTP empty close with a real zero canonical snapshot is known zero, distinct from missing pricing');

  const observedOrders = [];
  for (const kind of ['unknown', 'cross_venue', 'pre144']) {
    const seat = await table(`Observed ${kind}`);
    const order = await api('/api/orders', 'POST', { tableId: seat.id }, 201);
    let staffId = ids.seller;
    if (kind === 'cross_venue') {
      // A valid same-organization employee may sell at another venue, but v1
      // records that limitation instead of inventing same-venue eligibility.
      const sibling = randomUUID();
      await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'QA sibling','Asia/Yekaterinburg')", [sibling, ids.org]);
      staffId = randomUUID();
      await db.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'QA cross venue',$4,$5,'bartender')", [staffId, sibling, ids.org, `cross-${marker}`, hash]);
    }
    await db.query('BEGIN');
    try {
      if (kind === 'pre144') await db.query('ALTER TABLE order_items DISABLE TRIGGER order_items_payroll_attribution_capture');
      // Only this historical fixture models a pre-upgrade source row. Restore
      // the trigger before commit/HTTP close; it must remain unknown afterward.
      await db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at) VALUES($1,$2,1,100.50,$3,$4,CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END)', [order.id, product.id, 'Бар', kind === 'unknown' ? null : staffId]);
      if (kind === 'pre144') await db.query('ALTER TABLE order_items ENABLE TRIGGER order_items_payroll_attribution_capture');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    await api(`/api/orders/${order.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
    const event = (await db.query('SELECT * FROM pos_payroll_sale_events WHERE order_id=$1', [order.id])).rows[0];
    const line = (await db.query('SELECT * FROM pos_payroll_sale_line_events WHERE sale_event_id=$1', [event.id])).rows[0];
    assert.equal(event.coverage_status, 'incomplete', kind);
    assert.ok(event.coverage_reasons.includes('seller_eligibility_unattested'), kind);
    assert.equal(line.eligibility_status, kind === 'cross_venue' ? 'cross_venue' : 'unknown');
    if (kind === 'pre144') assert.equal(line.attribution_captured_at, null, 'upgrade must not manufacture historical capture');
    observedOrders.push(order.id);
  }
  check('unknown seller, cross-venue seller and genuine pre144 null capture remain incomplete through real HTTP close');

  const race = await openOrder('Concurrent returns', 1);
  await api(`/api/orders/${race.order.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount });
  const racePayment = (await payments(race.order.id))[0];
  const raced = await Promise.all([1, 2].map(index => api(`/api/finance/orders/${race.order.id}/refunds`, 'POST', refundBody(racePayment.id, { itemId: race.line.id, quantity: '0.600' }, `race-${marker}-${index}`), [201, 409])));
  assert.equal(raced.filter(value => value.status === 201).length, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_payroll_refund_events WHERE order_id=$1', [race.order.id])).rows[0].n, 1);
  assert.equal(Number((await db.query('SELECT returned_quantity FROM pos_order_item_return_balances WHERE order_item_id=$1', [race.line.id])).rows[0].returned_quantity), 0.6);
  const raceWinner = raced.find(value => value.status === 201);
  check('concurrent authenticated refund attempts create one capped return and one recognition');

  // A lock without a row-version change cannot refresh an RR transaction's
  // snapshot. Both callers intentionally observe the same pre-refund state.
  // The producer must report unsupported isolation, never certify these facts.
  const rrA = new Client({ connectionString: target.url.href }), rrB = new Client({ connectionString: target.url.href });
  await rrA.connect(); await rrB.connect();
  const autoPayment = (await payments(auto.order.id))[0], rrIds = [];
  try {
    for (const client of [rrA, rrB]) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL statement_timeout='8s'");
      await client.query('SELECT count(*) FROM order_refund_tenders WHERE order_id=$1', [auto.order.id]);
    }
    const appendHeader = async (client, suffix) => (await client.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status) VALUES($1,$2,$3,80,'QA unsupported RR producer',$4,$5,'not_applicable') RETURNING id", [ids.venue, auto.order.id, shift.id, `rr-${marker}-${suffix}`, ids.owner])).rows[0].id;
    const appendTender = (client, refundId) => client.query("INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot) VALUES($1,$2,$3,$4,80,'card',$5,'QA bank')", [ids.venue, refundId, auto.order.id, autoPayment.id, cardAccount]);
    rrIds.push(await appendHeader(rrA, 'a'), await appendHeader(rrB, 'b'));
    await appendTender(rrA, rrIds[0]);
    const backend = (await rrB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = appendTender(rrB, rrIds[1]).then(() => ({ ok: true }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [backend])).rows[0].blocked;
      if (!waiting) await delay(10);
    }
    assert.equal(waiting, true, 'second RR tender actually queues behind first payment lock');
    await rrA.query('COMMIT');
    const second = await pending;
    assert.equal(second.error, undefined, second.error?.message);
    await rrB.query('COMMIT');
    for (const refundId of rrIds) {
      const fact = await readRefund(refundId);
      assert.equal(fact.coverage_status, 'incomplete');
      assert.ok(fact.coverage_reasons.includes('producer_isolation_unsupported'), 'RR must not falsely attest cumulative cap from a stale snapshot');
    }
  } finally {
    await rrA.query('ROLLBACK').catch(() => {}); await rrB.query('ROLLBACK').catch(() => {});
    await rrA.end(); await rrB.end();
  }
  check('two stale RR snapshots cannot claim complete refund coverage after serialized payment locks');

  for (const name of ['pos_payroll_sale_events', 'pos_payroll_sale_line_events', 'pos_payroll_refund_events', 'pos_payroll_refund_line_events']) {
    const key = name.includes('refund') ? (name.includes('line') ? firstLine.id : firstRecognition.id) : (name.includes('line') ? sourceLine.id : source.id);
    await rejectedSql(`${name} rejects update`, client => client.query(`UPDATE ${name} SET venue_id=venue_id WHERE id=$1`, [key]), /internal_immutable/);
    await rejectedSql(`${name} rejects delete`, client => client.query(`DELETE FROM ${name} WHERE id=$1`, [key]), /internal_immutable/);
    await rejectedSql(`${name} rejects direct insert`, client => client.query(`INSERT INTO ${name} SELECT * FROM ${name} WHERE id=$1`, [key]), /internal_immutable/);
    await rejectedSql(`${name} rejects truncate`, client => client.query(`TRUNCATE ${name} CASCADE`), /internal_immutable/);
  }
  for (const operation of ['UPDATE pos_payroll_recognition_epochs SET activated_at=now() WHERE venue_id=$1', 'DELETE FROM pos_payroll_recognition_epochs WHERE venue_id=$1', 'INSERT INTO pos_payroll_recognition_epochs SELECT * FROM pos_payroll_recognition_epochs WHERE venue_id=$1']) {
    await rejectedSql(`epoch rejects ${operation.split(' ')[0]}`, client => client.query(operation, [ids.venue]), /epoch_internal_immutable/);
  }
  await rejectedSql('epoch rejects truncate', client => client.query('TRUNCATE pos_payroll_recognition_epochs'), /epoch_internal_immutable/);
  await rejectedSql('caller cannot rewrite captured item seller', client => client.query('UPDATE order_items SET sales_employee_id=$1 WHERE id=$2', [ids.owner, splitSource.line.id]), /attribution_immutable/);
  await rejectedSql('caller cannot inject attribution capture', client => client.query("INSERT INTO order_items(order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at,payroll_attribution_captured_at) VALUES($1,$2,1,100.50,'Бар',$3,now(),now())", [splitSource.order.id, product.id, ids.seller]), /attribution_server_managed/);
  await rejectedSql('caller cannot inject refund recognition time', client => client.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,payroll_recognized_at) VALUES($1,$2,$3,1,'QA forged time',$4,$5,now()-interval '1 year')", [ids.venue, sale.order.id, shift.id, `forged-${marker}`, ids.owner]), /time_server_managed/);
  await rejectedSql('direct foreign-venue evidence cannot borrow original sale', client => client.query("INSERT INTO pos_payroll_sale_events SELECT (jsonb_populate_record(NULL::pos_payroll_sale_events,to_jsonb(s)||jsonb_build_object('id',$2::uuid,'venue_id',$3::uuid))).* FROM pos_payroll_sale_events s WHERE s.id=$1", [source.id, randomUUID(), ids.otherVenue]), /internal_immutable/);
  const foreignOrder = randomUUID();
  await db.query("INSERT INTO orders(id,venue_id,opened_by,status) VALUES($1,$2,$3,'open')", [foreignOrder, ids.otherVenue, ids.foreignOwner]);
  await rejectedSql('item cannot move across venue', client => client.query('UPDATE order_items SET order_id=$1 WHERE id=$2', [foreignOrder, splitSource.line.id]), /venue_mismatch/);
  await rejectedSql('late tender cannot change sealed refund', client => client.query("INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot) VALUES($1,$2,$3,$4,1,'card',$5,'QA bank')", [ids.venue, firstRefund.id, sale.order.id, originalTender.id, cardAccount]), /source_sealed/);
  const raceSnapshot = (await db.query('SELECT snapshot_id FROM pos_payroll_sale_events WHERE order_id=$1', [race.order.id])).rows[0].snapshot_id;
  await rejectedSql('late item cannot change sealed refund', client => client.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,0.1,NULL)', [ids.venue, raceWinner.id, race.order.id, raceSnapshot, race.line.id]), /source_sealed/);
  const blocker = new Client({ connectionString: target.url.href }), late = new Client({ connectionString: target.url.href });
  await blocker.connect(); await late.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM order_refunds WHERE id=$1 FOR UPDATE', [raceWinner.id]);
    await late.query('BEGIN');
    await late.query("SET LOCAL statement_timeout='8s'");
    const backend = (await late.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = late.query("INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot) VALUES($1,$2,$3,$4,1,'card',$5,'QA bank')", [ids.venue, raceWinner.id, race.order.id, racePayment.id, cardAccount]).then(() => ({ ok: true }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [backend])).rows[0].blocked;
      if (!waiting) await delay(10);
    }
    assert.equal(waiting, true, 'late writer must serialize on the header lock before observing the seal');
    await blocker.query('COMMIT');
    const result = await pending;
    assert.ok(result.error);
    assert.match(result.error.message, /source_sealed/);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); await late.query('ROLLBACK').catch(() => {});
    await blocker.end(); await late.end();
  }
  check('two-connection queued late tender rechecks the seal after acquiring source lock');

  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM order_refunds) headers,(SELECT count(*)::int FROM order_refund_items) items,(SELECT count(*)::int FROM pos_payroll_refund_events) events,(SELECT count(*)::int FROM pos_payroll_refund_line_events) lines`)).rows[0];
  const beforeRollback = await counts();
  const balanceBeforeRollback = (await db.query('SELECT * FROM pos_order_item_return_balances WHERE order_item_id=$1', [race.line.id])).rows[0];
  await db.query('BEGIN');
  try {
    const header = (await db.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status) VALUES($1,$2,$3,1,'QA deferred rollback',$4,$5,'complete') RETURNING id", [ids.venue, race.order.id, shift.id, `rollback-${marker}`, ids.owner])).rows[0];
    await db.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,0.1,NULL)', [ids.venue, header.id, race.order.id, raceSnapshot, race.line.id]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    const incomplete = await readRefund(header.id);
    assert.equal(incomplete.coverage_status, 'incomplete');
    assert.ok(incomplete.coverage_reasons.includes('tender_payout_mismatch'), 'item arithmetic cannot attest missing external payout');
    assert.equal((await counts()).events, beforeRollback.events + 1);
  } finally { await db.query('ROLLBACK'); }
  assert.deepEqual(await counts(), beforeRollback);
  assert.deepEqual((await db.query('SELECT * FROM pos_order_item_return_balances WHERE order_item_id=$1', [race.line.id])).rows[0], balanceBeforeRollback);
  check('deferred recognition is incomplete without tenders; full transaction rollback restores source balance and all evidence');

  const legacy = randomUUID();
  await db.query("INSERT INTO orders(id,venue_id,opened_by,status,closed_at,closed_in_shift_id) VALUES($1,$2,$3,'closed',now()-interval '1 day',$4)", [legacy, ids.venue, ids.owner, shift.id]);
  const unknown = (await db.query('SELECT * FROM pos_payroll_sale_events WHERE order_id=$1', [legacy])).rows[0];
  assert.equal(unknown.coverage_status, 'incomplete');
  assert.ok(unknown.coverage_reasons.includes('pricing_snapshot_missing'));
  assert.ok(unknown.coverage_reasons.includes('source_close_time_mismatch'), 'caller-supplied past close time cannot attest producer recognition');
  check('closed source without canonical pricing remains incomplete, never zero-value complete');
  await rejectedSql('late canonical header cannot complete a sealed unknown sale', client => client.query("INSERT INTO pos_order_pricing_snapshots(venue_id,order_id,sold_at,subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source) VALUES($1,$2,now(),0,0,0,0,'none')", [ids.venue, legacy]), /source_sealed/);

  const evidenceRows = async () => (await db.query(`SELECT jsonb_build_object('epochs',(SELECT jsonb_agg(to_jsonb(e) ORDER BY venue_id) FROM pos_payroll_recognition_epochs e),'sales',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM pos_payroll_sale_events s),'saleLines',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM pos_payroll_sale_line_events s),'refunds',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM pos_payroll_refund_events s),'refundLines',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM pos_payroll_refund_line_events s)) AS facts`)).rows[0].facts;
  const beforeReplay = await evidenceRows();
  const migration = readFileSync(path.join(root, 'migrations', '144_pos_payroll_recognition.sql'), 'utf8');
  for (let index = 0; index < 2; index++) {
    await db.query('BEGIN');
    try { await db.query(migration); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  assert.deepEqual(await evidenceRows(), beforeReplay, 'reapplying migration twice changes no historical facts');
  check('migration144 replay twice preserves every emitted source fact');
  const migrationFiles = readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql')).sort();
  await db.query('BEGIN');
  let applying;
  try {
    for (const file of migrationFiles) { applying = file; await db.query(readFileSync(path.join(root, 'migrations', file), 'utf8')); }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw Object.assign(new Error(`Full migration replay failed at ${applying}: ${error.message}`), { code: error.code }); }
  assert.deepEqual(await evidenceRows(), beforeReplay, 'normal full migration replay preserves emitted recognition facts');
  check('normal complete deployment migration chain replays on populated source facts', { migrationCount: migrationFiles.length });
  // A separate pre144 schema models a real upgrade. Migration112 explicitly
  // targets public, so apply only144's actual prerequisite chain through092
  // here; full normal deployment replay above covers the current public schema.
  const upgrade = new Client({ connectionString: target.url.href });
  const upgradeSchema = `recognition_upgrade_${randomBytes(8).toString('hex')}`;
  await upgrade.connect();
  try {
    await upgrade.query(`CREATE SCHEMA ${upgradeSchema}`);
    await upgrade.query(`SET search_path TO ${upgradeSchema},public`);
    await upgrade.query('BEGIN');
    await upgrade.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    for (const file of migrationFiles.filter(file => /^\d{3}/.test(file) && Number(file.slice(0, 3)) <= 92)) await upgrade.query(readFileSync(path.join(root, 'migrations', file), 'utf8'));
    const oldVenue = randomUUID();
    await upgrade.query("INSERT INTO venues(id,name,timezone) VALUES($1,'Pre144 installation','Asia/Yekaterinburg')", [oldVenue]);
    await upgrade.query('COMMIT');
    await upgrade.query('BEGIN');
    await upgrade.query(migration);
    await upgrade.query('COMMIT');
    const installed = (await upgrade.query('SELECT to_jsonb(e) AS fact FROM pos_payroll_recognition_epochs e WHERE venue_id=$1', [oldVenue])).rows[0].fact;
    assert.equal(installed.activation_scope, 'existing_at_install');
    assert.equal(installed.policy_version, 1);
    await upgrade.query('BEGIN'); await upgrade.query(migration); await upgrade.query('COMMIT');
    assert.deepEqual((await upgrade.query('SELECT to_jsonb(e) AS fact FROM pos_payroll_recognition_epochs e WHERE venue_id=$1', [oldVenue])).rows[0].fact, installed);
    check('true pre144 installation gets existing_at_install epoch and replay never resets the cutoff');
  } finally { await upgrade.query('ROLLBACK').catch(() => {}); await upgrade.end(); }
  assert.deepEqual(await evidenceRows(), beforeReplay, 'isolated upgrade fixture leaves main evidence unchanged');
  evidence.status = 'passed';
  evidence.sourceIds = { orderId: sale.order.id, saleEventId: source.id, refundId: firstRefund.id, refundEventId: firstRecognition.id };
} finally {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const closed = new Promise(resolve => server.once('close', resolve));
    if (process.platform === 'win32') {
      const kill = spawn('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => { kill.once('error', resolve); kill.once('exit', resolve); });
    } else server.kill('SIGTERM');
    await Promise.race([closed, delay(5000)]);
  }
  if (db._connected) await db.end();
}
console.log(`POS PAYROLL RECOGNITION POSTGRES QA: PASS (${evidence.checks.length} checks; ${evidenceDir})`);
