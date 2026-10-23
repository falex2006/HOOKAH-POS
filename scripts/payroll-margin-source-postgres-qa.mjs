import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

// Exercises the payroll read adapter against producer-owned immutable 144/090/092 facts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { readPayrollRecognitionManifestInTransaction: read } = require('../payroll-recognition-manifest');
const { Client } = require('pg');
const { readSaleCostEvidence } = require('../pos-sale-cost-evidence');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'runner ownership is mandatory');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
assert.equal(target.url.hostname, '127.0.0.1'); assert.equal(target.url.port, '31931');
const db = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = Object.fromEntries(['org', 'venue', 'owner', 'seller'].map(key => [key, randomUUID()]));
const marker = randomUUID().slice(0, 8), password = `qa-${randomUUID()}`;
const logins = { owner: `recognition-manifest-owner-${marker}`, seller: `recognition-manifest-seller-${marker}` };
const salt = randomBytes(16).toString('hex'), hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
let server, output = '', base = '', ownerToken, sellerToken, cardAccount, zone, product, shift;
const assertIsolated = async () => {
  const identity = (await db.query(`SELECT current_database() database,inet_server_addr()::text address,
    inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, 31931, 'payroll recognition manifest QA');
};
const api = async (route, method = 'GET', body, expected = 200, bearer = ownerToken) => {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'X-Organization-Id': ids.org,
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
};

try {
  await db.connect(); await assertIsolated();
  const relatedRefundIndexMigration = readFileSync(path.join(root, 'migrations/190_payroll_refund_related_order_index.sql'), 'utf8');
  await db.query(relatedRefundIndexMigration);
  await db.query(relatedRefundIndexMigration);
  assert.equal((await db.query("SELECT to_regclass('order_refund_items_venue_order_refund_idx') IS NOT NULL AS present")).rows[0].present,
    true, 'fresh QA migrations and migration replay install the venue/order-leading raw refund-item index');
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Payroll recognition manifest QA',$2,'network')", [ids.org, `payroll-manifest-${ids.org}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'network','active',20,10)", [ids.org]);
    await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Payroll recognition manifest QA','Asia/Yekaterinburg')", [ids.venue, ids.org]);
    for (const key of ['owner', 'seller']) {
      await db.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb)",
        [ids[key], ids.venue, ids.org, `QA ${key}`, logins[key], hash, key === 'seller' ? 'bartender' : 'owner']);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')",
        [ids.org, ids[key], key === 'owner' ? 'owner' : 'member']);
    }
    cardAccount = randomUUID();
    await db.query("INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by) VALUES($1,$2,'manifest_bank','QA bank','bank',ARRAY['card']::text[],$3)", [cardAccount, ids.venue, ids.owner]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0',
    DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`isolated server failed to start: ${output.slice(-4000)}`);
    else await delay(50);
  }
  assert.ok(base, 'isolated QA server starts'); assert.equal((await api('/api/health', 'GET', undefined, 200, undefined)).database, 'postgres');
  ownerToken = (await api('/api/login', 'POST', { username: logins.owner, password }, 200, undefined)).token;
  sellerToken = (await api('/api/login', 'POST', { username: logins.seller, password }, 200, undefined)).token;
  zone = await api('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: `Manifest ${marker}` }, 201);
  product = await api('/api/products', 'POST', { name: `Manifest ${marker}`, category: 'Бар', price: 100.50, inventoryMode: 'tracked' }, 201);
  const businessDate = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const ingredient = await api('/api/inventory/items', 'POST', { name: 'Margin QA ingredient', unit: 'мл', itemType: 'ingredient', cost: 0, department: 'bar' }, 201);
  const purchase = await api('/api/inventory/purchase-documents', 'POST', { supplierName: 'Margin QA supplier', documentNumber: marker,
    documentDate: businessDate, lines: [{ ingredientId: ingredient.id, quantity: 1000, unit: 'мл', unitCost: 0.25 }] }, 201);
  await api(`/api/inventory/purchase-documents/${purchase.id}/post`, 'POST', {}, 200);
  const recipe = await api('/api/recipes', 'POST', { productId: product.id, name: product.name,
    ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: '100 мл' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, 201);
  shift = await api('/api/shifts', 'POST', { openingCash: 0 }, 201);
  const table = await api('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: zone.id, name: `Manifest ${marker}`, capacity: 2 }, 201);
  const order = await api('/api/orders', 'POST', { tableId: table.id }, 201);
  const line = await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 2 }, 201, sellerToken);
  assert.equal(line.salesEmployeeId, ids.seller);
  await api(`/api/orders/${order.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: cardAccount }, 200);
  const payment = (await db.query('SELECT id::text,amount::text FROM payments WHERE order_id=$1 ORDER BY created_at,id', [order.id])).rows[0];
  assert.ok(payment);
  const saleEvent = (await db.query('SELECT id::text,recognized_local_date::text,coverage_status FROM pos_payroll_sale_events WHERE venue_id=$1 AND order_id=$2', [ids.venue, order.id])).rows[0];
  assert.equal(saleEvent.coverage_status, 'complete');
  const from = `${saleEvent.recognized_local_date.slice(0,7)}-01`, to = saleEvent.recognized_local_date;
  await api('/api/payroll/employment-eligibility', 'POST', { reason: 'Margin QA eligible seller', idempotencyKey: `margin-employment-${marker}`,
    expectedRevisionId: null, periods: [{ employeeId: ids.seller, effectiveFrom: from, effectiveTo: null }] }, 201);
  const scheme = await api('/api/payroll/schemes', 'POST', { name: 'Historical margin QA',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'margin_target', currency: 'RUB', effectiveFrom: from,
      roleParameters: { bartender: { perShiftCents: 0, targetCents: 100000, baseRateBps: 1000, bonusRateBps: 1000,
        excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' } },
      roleAssignments: [{ employeeId: ids.seller, roleId: 'bartender', effectiveFrom: from }], employeeOverrides: [], itemRules: [],
      sourcePolicies: { schemaVersion: 1, selectionReason: 'Margin QA immutable producer inputs', saleCredit: { kind: 'line_seller_snapshot' },
        discountAllocation: { kind: 'immutable_line_snapshot' }, refunds: { recognition: 'recognized_event_date',
          closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
          uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } } } }, 201);
  const version = scheme.versions[0].versionId;
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) runs,
    (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) entries,(SELECT count(*)::int FROM expenses WHERE venue_id=$1) expenses`, [ids.venue])).rows[0];
  const preview = async () => { const before = await counts(); const result = await api(`/api/payroll/versions/${version}/preview/sourced`, 'POST', { periodFrom: from, periodTo: to });
    assert.deepEqual(await counts(), before, 'preview performs no payroll or expense posting'); return result; };
  assert.equal((await preview()).candidateCalculation.status, 'blocked', 'missing department and attendance fail closed');
  await api('/api/payroll/product-department-mappings/retroactive-revisions', 'POST', { expectedRevisionId: null,
    idempotencyKey: `margin-department-${marker}`, reason: 'Margin QA historical department', effectiveFrom: to,
    retroactiveReason: 'Owner attests department of historical sale', ownerAttestation: { confirmed: true, action: 'retroactive_payroll_product_department_mapping' },
    mappings: [{ productId: product.id, productName: product.name, departmentCode: 'drinks', departmentName: 'Напитки', effectiveFrom: to, effectiveTo: null }] }, 201);
  assert.equal((await preview()).candidateCalculation.status, 'blocked', 'missing approved attendance fails closed');
  await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
    VALUES($1,$2,$3::date,($3::date::text||'T00:00:00+05:00')::timestamptz,($3::date::text||'T23:59:00+05:00')::timestamptz,$4)`, [ids.venue,ids.seller,to,ids.owner]);
  await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
    VALUES($1,$2,($3::date::text||'T00:00:00+05:00')::timestamptz,($3::date::text||'T23:59:00+05:00')::timestamptz,'manual')`,[ids.venue,ids.seller,to]);
  const attendance = await api(`/api/payroll/attendance/approvals?from=${from}&to=${to}`);
  assert.equal(attendance.complete,true,JSON.stringify(attendance.reasons));
  await api('/api/payroll/attendance/approvals','POST',{periodFrom:from,periodTo:to,sourceWatermark:attendance.sourceWatermark,
    reason:'Approve actual margin QA attendance',idempotencyKey:`margin-attendance-${marker}`},201);
  const ready = await preview();
  assert.equal(ready.candidateCalculation.status,'scenario_ready',JSON.stringify(ready.candidateCalculation.reasons));
  assert.equal(ready.candidateCalculation.amountCents,1510,'(20100 revenue - 5000 historical cost) * 10%');
  assert.equal(ready.officialReady,false);
  assert.equal(ready.candidateSnapshotStatus,'available');
  assert.equal(ready.candidateSnapshot.amountCents,1510);
  assert.equal(ready.candidateSnapshot.personalRevenueCeilingSource.status,'available');
  assert.equal(ready.candidateSnapshot.personalRevenueCeilingSource.policyCode,'employee_attributed_merchandise_net_v1');
  assert.deepEqual(ready.candidateSnapshot.personalRevenueCeilingSource.daily,
    [{ employeeId:ids.seller,date:to,netRevenueCents:20100 }]);
  assert.match(ready.candidateSnapshot.personalRevenueCeilingSource.sourceWatermark,/^[a-f0-9]{64}$/);
  assert.equal(ready.candidateSnapshot.lines.length,1);
  const frozenLine = ready.candidateSnapshot.lines[0];
  assert.equal(frozenLine.costSnapshot.costCents,5000); assert.equal(frozenLine.signedMarginCents,15100);
  assert.match(frozenLine.producerWatermark,/^[a-f0-9]{64}$/);
  assert.match(frozenLine.costSourceWatermark,/^[a-f0-9]{64}$/);
  assert.equal(frozenLine.costSnapshot.version,frozenLine.producerWatermark);
  const persistedCost = (await db.query('SELECT watermark FROM pos_sale_cost_evidence WHERE venue_id=$1 AND order_id=$2',[ids.venue,order.id])).rows[0];
  assert.equal(frozenLine.producerWatermark,persistedCost.watermark);
  const calculationLines = ready.candidateCalculation.daily.flatMap(day=>day.lines);
  assert.equal(calculationLines.length,1); assert.equal(calculationLines[0].costSnapshot.costCents,5000);
  await api(`/api/inventory/items/${ingredient.id}`,'PATCH',{cost:9},200);
  await api(`/api/recipes/${recipe.id}`,'PATCH',{ingredients:[{ingredientId:ingredient.id,name:ingredient.name,quantity:'200 мл'}]},200);
  const again = await preview();
  assert.deepEqual(again.candidateCalculation,ready.candidateCalculation,'current recipe and cost do not rewrite historical source');
  assert.deepEqual(again.candidateSnapshot,ready.candidateSnapshot,'repeated snapshot remains source-identical');
  await api(`/api/payroll/versions/${version}/preview/sourced`,'POST',{periodFrom:from,periodTo:to},403,sellerToken);
  await api(`/api/finance/orders/${order.id}/refunds`,'POST',{amount:1,reason:'Margin QA linked return',idempotencyKey:`margin-refund-${marker}`,
    allocations:[{sourcePaymentId:payment.id,amount:1,payoutMethod:'card',paymentAccountId:cardAccount}],items:[{orderItemId:line.id,quantity:1}]},201);
  const refunded = await preview();
  assert.equal(refunded.candidateCalculation.status,'blocked'); assert.equal(refunded.candidateSnapshot,null);
  // Reader-level missing/foreign evidence checks do not manufacture immutable
  // cost rows. The legacy fixture is deliberately not an HTTP-produced sale.
  const foreign = await readSaleCostEvidence(db, { venueId: randomUUID(), orderId: order.id });
  assert.equal(foreign.status, 'unavailable'); assert.equal(foreign.totalCostMinor, null);
  const missingOrder = (await db.query(`INSERT INTO orders(venue_id,opened_by,status,closed_at)
    VALUES($1,$2,'closed',now()) RETURNING id`, [ids.venue, ids.owner])).rows[0].id;
  const missing = await readSaleCostEvidence(db, { venueId: ids.venue, orderId: missingOrder });
  assert.equal(missing.status,'incomplete'); assert.equal(missing.totalCostMinor,null);
  assert.ok(missing.reasons.includes('historical_sale_cost_unavailable'));
  const zeroIngredient = await api('/api/inventory/items','POST',{name:'Unattested zero margin QA',unit:'мл',itemType:'ingredient',cost:0,department:'bar'},201);
  await api('/api/inventory/movements','POST',{itemId:zeroIngredient.id,delta:100,unit:'мл',reason:'Synthetic zero valuation stock'},201);
  const zeroProduct = await api('/api/products','POST',{name:'Zero cost margin QA',category:'Бар',price:10,inventoryMode:'tracked'},201);
  await api('/api/recipes','POST',{productId:zeroProduct.id,name:zeroProduct.name,
    ingredients:[{ingredientId:zeroIngredient.id,name:zeroIngredient.name,quantity:'1 мл'}],yieldQuantity:1,yieldUnit:'порция',portionCount:1},201);
  const zeroOrder = await api('/api/orders','POST',{tableId:table.id},201);
  await api(`/api/orders/${zeroOrder.id}/items`,'POST',{productId:zeroProduct.id,quantity:1},201,sellerToken);
  await api(`/api/orders/${zeroOrder.id}/close`,'POST',{paymentMethod:'card',paymentAccountId:cardAccount},200);
  const zeroEvidence = await readSaleCostEvidence(db,{venueId:ids.venue,orderId:zeroOrder.id});
  assert.equal(zeroEvidence.status,'incomplete'); assert.equal(zeroEvidence.totalCostMinor,null);
  assert.ok(zeroEvidence.reasons.includes('valuation_zero_unattested'));
  console.log('PASS payroll-margin-source-postgres-qa: real purchase/recipe/close to historical cost and margin candidate; mutable sources ignored; refund blocked; no posting');
} finally {
  if(server && server.exitCode === null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}
  await db.end().catch(()=>{});
}

