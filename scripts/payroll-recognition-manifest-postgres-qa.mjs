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
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i);
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
  product = await api('/api/products', 'POST', { name: `Manifest ${marker}`, category: 'Бар', price: 100.50, inventoryMode: 'non_stock' }, 201);
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
  const refund = await api(`/api/finance/orders/${order.id}/refunds`, 'POST', { amount: 1, reason: 'Manifest QA payout differs from merchandise',
    idempotencyKey: `manifest-${marker}`, allocations: [{ sourcePaymentId: payment.id, amount: 1, payoutMethod: 'card', paymentAccountId: cardAccount }],
    items: [{ orderItemId: line.id, quantity: 1 }] }, 201);
  const refundEvent = (await db.query('SELECT e.id::text,e.refund_id::text,l.returned_item_value_minor::text FROM pos_payroll_refund_events e JOIN pos_payroll_refund_line_events l ON l.refund_event_id=e.id WHERE e.refund_id=$1', [refund.id])).rows[0];
  assert.ok(refundEvent);
  assert.equal(refundEvent.returned_item_value_minor, '10050');
  assert.equal(Number((await db.query('SELECT amount FROM order_refunds WHERE id=$1', [refund.id])).rows[0].amount), 1, 'cash payout stays independent from merchandise return');
  const secondRefund = await api(`/api/finance/orders/${order.id}/refunds`, 'POST', { amount: 1, reason: 'Second item return for sequence QA',
    idempotencyKey: `manifest-second-${marker}`, allocations: [{ sourcePaymentId: payment.id, amount: 1, payoutMethod: 'card', paymentAccountId: cardAccount }],
    items: [{ orderItemId: line.id, quantity: 1 }] }, 201);
  const secondLineEvent = (await db.query(`SELECT l.producer_sequence::text,l.previous_returned_item_value_minor::text,l.returned_item_value_minor::text
    FROM pos_payroll_refund_events e JOIN pos_payroll_refund_line_events l ON l.refund_event_id=e.id WHERE e.refund_id=$1`, [secondRefund.id])).rows[0];
  assert.deepEqual(secondLineEvent, { producer_sequence: '2', previous_returned_item_value_minor: '10050', returned_item_value_minor: '10050' });

  const [year, month] = saleEvent.recognized_local_date.split('-').map(Number);
  const from = `${saleEvent.recognized_local_date.slice(0, 7)}-01`;
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const manifest = await read(db, { venueId: ids.venue, from, to, currency: 'RUB' });
  await db.query('COMMIT');
  assert.equal(manifest.status, 'available', JSON.stringify(manifest.reasons));
  assert.equal(manifest.officialReady, false);
  assert.equal(manifest.sales.length, 1); assert.equal(manifest.sales[0].eventId, saleEvent.id);
  assert.equal(manifest.saleLines.length, 1); assert.equal(manifest.saleLines[0].netMinor, 20100);
  assert.equal(manifest.refunds.length, 2); assert(manifest.refunds.every(row => row.payoutMinor === 100));
  assert.equal(manifest.relatedRefundCoverage.status, 'complete');
  assert.equal(manifest.relatedRefundCoverage.sourceWatermark, manifest.watermark);
  assert.equal(manifest.relatedRefundCoverage.relatedRefundHeaderIds.length, 2,
    'read-only manifest attests all raw refund headers for the selected order cohort');
  assert.equal(manifest.relatedRefundCoverage.relatedRefundEventIds.length, 2,
    'raw refund headers reconcile to the recognition-event set in the same snapshot');
  assert.deepEqual(manifest.refundOriginalSaleAttributions, [], 'same-period original sales do not need a related-sale attribution DTO');
  assert.equal(manifest.refunds[0].lines[0].returnedItemValueMinor, 10050);
  assert.equal(manifest.refundHistory[0].cumulativeReturnedItemValueMinor, 20100);

  const recognitionRows = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM pos_payroll_sale_events e WHERE venue_id=$1 AND order_id=$2) AS headers,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM pos_payroll_sale_line_events l WHERE venue_id=$1 AND order_id=$2) AS lines`,
  [ids.venue, order.id])).rows[0];
  const immutableBeforeStatusChange = await recognitionRows();
  // Only this runner-owned synthetic order is modified; original recognition
  // is retained and the fixture status change is rolled back, never reclosed.
  for (const status of ['cancelled', 'open']) {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await db.query('UPDATE orders SET status=$3 WHERE venue_id=$1 AND id=$2', [ids.venue, order.id, status]);
      await db.query('SET TRANSACTION READ ONLY');
      const nonClosed = await read(db, { venueId: ids.venue, from, to, currency: 'RUB' });
      assert.equal(nonClosed.status, 'incomplete');
      assert.ok(nonClosed.reasons.includes('sale_order_not_closed'));
      assert.equal(nonClosed.sales.length, 1);
      assert.equal(nonClosed.saleLines.length, 0);
      assert.notEqual(nonClosed.watermark, manifest.watermark);
      assert.deepEqual(await recognitionRows(), immutableBeforeStatusChange);
    } finally {
      await db.query('ROLLBACK');
    }
  }
  assert.deepEqual(await recognitionRows(), immutableBeforeStatusChange);

  // Corrupt only the runner-owned disposable database to emulate a late raw
  // refund header whose deferred recognition event was never materialized.
  // The header timestamp is outside the selected sale month; the manifest
  // must still discover it through the related-order cohort and fail closed.
  const orphanRefundId = randomUUID();
  const lateHeaderDate = new Date(Date.parse(`${to}T00:00:00.000Z`) + 5 * 86400000).toISOString().slice(0, 10);
  await db.query('ALTER TABLE order_refunds DISABLE TRIGGER order_refunds_payroll_recognition');
  try {
    await db.query(`INSERT INTO order_refunds(id,venue_id,order_id,shift_id,amount,item_attribution_status,reason,idempotency_key,actor_id,created_at)
      VALUES($1,$2,$3,$4,0.50,'not_applicable','Orphan header coverage QA',$5,$6,$7::timestamptz)`,
    [orphanRefundId, ids.venue, order.id, shift.id, `orphan-${marker}`, ids.owner, `${lateHeaderDate}T10:00:00Z`]);
  } finally {
    await db.query('ALTER TABLE order_refunds ENABLE TRIGGER order_refunds_payroll_recognition');
  }
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const orphanManifest = await read(db, { venueId: ids.venue, from, to, currency: 'RUB' });
  await db.query('COMMIT');
  assert.equal(orphanManifest.status, 'incomplete');
  assert(orphanManifest.reasons.includes('related_refund_recognition_missing'), JSON.stringify(orphanManifest.reasons));
  assert(orphanManifest.relatedRefundCoverage.relatedRefundHeaderIds.includes(orphanRefundId),
    'all-time related-order coverage sees a later-month raw refund header');
  assert.equal(orphanManifest.relatedRefundCoverage.relatedRefundEventIds.length, 2,
    'the orphan raw header is not silently counted as a recognized event');

  await db.query('BEGIN READ ONLY');
  await assert.rejects(() => read(db, { venueId: ids.venue, from, to }), /payroll_recognition_manifest_repeatable_read_read_only_required/);
  const stillInTransaction = (await db.query('SELECT txid_current_if_assigned() IS NULL AS unchanged')).rows[0].unchanged;
  assert.equal(stillInTransaction, true, 'reader rejects wrong isolation without ending caller transaction');
  await db.query('ROLLBACK');
  const payrollEntries = (await db.query('SELECT count(*)::int AS n FROM payroll_entries WHERE venue_id=$1', [ids.venue])).rows[0].n;
  const expenses = (await db.query('SELECT count(*)::int AS n FROM expenses WHERE venue_id=$1', [ids.venue])).rows[0].n;
  assert.equal(payrollEntries, 0); assert.equal(expenses, 0, 'read-only manifest must not create payroll entries or expenses');

  // Exercise the owner sourced-preview API with actual immutable POS sale and
  // refund events from a venue created after migration 144. This keeps the
  // existing-at-install coverage fixture above while making the new venue's
  // full month source coverage valid for the real transaction date.
  const liveVenueId = (await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Payroll sourced preview QA','Asia/Yekaterinburg') RETURNING id",
    [randomUUID(), ids.org])).rows[0].id;
  const liveOwnerId = randomUUID(), liveSellerId = randomUUID();
  const liveOwnerLogin = `recognition-live-owner-${marker}`, liveSellerLogin = `recognition-live-seller-${marker}`;
  await db.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'Sourced preview owner',$4,$5,'owner','[]'::jsonb),($6,$2,$3,'Sourced preview seller',$7,$5,'bartender','[]'::jsonb)`,
  [liveOwnerId, liveVenueId, ids.org, liveOwnerLogin, hash, liveSellerId, liveSellerLogin]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active')",
    [ids.org, liveOwnerId, liveSellerId]);
  const liveAccountId = randomUUID();
  await db.query("INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by) VALUES($1,$2,'payroll_preview_bank','QA bank','bank',ARRAY['card']::text[],$3)",
    [liveAccountId, liveVenueId, liveOwnerId]);
  const liveOwnerToken = (await api('/api/login', 'POST', { username: liveOwnerLogin, password }, 200, undefined)).token;
  const liveSellerToken = (await api('/api/login', 'POST', { username: liveSellerLogin, password }, 200, undefined)).token;
  const liveZone = await api('/api/floor/zones', 'POST', { expectedVenueId: liveVenueId, name: `Sourced ${marker}` }, 201, liveOwnerToken);
  const liveProduct = await api('/api/products', 'POST', { name: `Sourced ${marker}`, category: 'Бар', price: 100.50, inventoryMode: 'non_stock' }, 201, liveOwnerToken);
  await api('/api/shifts', 'POST', { openingCash: 0 }, 201, liveOwnerToken);
  const liveTable = await api('/api/floor/tables', 'POST', { expectedVenueId: liveVenueId, zoneId: liveZone.id,
    name: `Sourced ${marker}`, capacity: 2 }, 201, liveOwnerToken);
  const liveOrder = await api('/api/orders', 'POST', { tableId: liveTable.id }, 201, liveOwnerToken);
  const liveLine = await api(`/api/orders/${liveOrder.id}/items`, 'POST', { productId: liveProduct.id, quantity: 2 }, 201, liveSellerToken);
  await api(`/api/orders/${liveOrder.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: liveAccountId }, 200, liveOwnerToken);
  const livePayment = (await db.query('SELECT id::text,amount::text FROM payments WHERE order_id=$1 ORDER BY created_at,id', [liveOrder.id])).rows[0];
  assert.ok(livePayment);
  const cleanSaleEvent = (await db.query(`SELECT e.id::text,e.recognized_local_date::text,l.id::text AS sale_line_id
    FROM pos_payroll_sale_events e JOIN pos_payroll_sale_line_events l ON l.sale_event_id=e.id
    WHERE e.venue_id=$1 AND e.order_id=$2`, [liveVenueId, liveOrder.id])).rows[0];
  assert.ok(cleanSaleEvent);
  const cleanMonth = cleanSaleEvent.recognized_local_date.slice(0, 7);
  const cleanPeriodFrom = `${cleanMonth}-01`;
  const [cleanYear, cleanMonthNumber] = cleanMonth.split('-').map(Number);
  const cleanPeriodEnd = new Date(Date.UTC(cleanYear, cleanMonthNumber, 0)).toISOString().slice(0, 10);
  const employment = await api('/api/payroll/employment-eligibility', 'POST', { reason: 'Confirm QA seller eligibility for candidate payroll calculation',
    idempotencyKey: `candidate-eligibility-${marker}`, expectedRevisionId: null,
    periods: [{ employeeId: liveSellerId, effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd }] }, 201, liveOwnerToken);
  assert.equal(employment.periods[0].employeeId, liveSellerId);
  const cleanDefinition = { mode: 'percent_only', currency: 'RUB', effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd,
    roleParameters: { bartender: { stableRateBps: 1000 } },
    roleAssignments: [{ employeeId: liveSellerId, roleId: 'bartender', effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd }],
    employeeOverrides: [], itemRules: [],
    sourcePolicies: { schemaVersion: 1, selectionReason: 'QA confirms immutable line seller and recognized sale facts',
      saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
      refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
        paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } } };
  const cleanScheme = await api('/api/payroll/schemes', 'POST', { name: 'Clean sourced candidate calculation QA',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' }, definition: cleanDefinition
  }, 201, liveOwnerToken);
  const cleanVersionId = cleanScheme.versions[0].versionId;
  const persistedAcknowledgement = (await db.query(`SELECT config_json->'payoutRiskAcknowledgement'->>'confirmed' AS confirmed
    FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2`, [liveVenueId, cleanVersionId])).rows[0];
  assert.equal(persistedAcknowledgement.confirmed, 'true', 'new owner acknowledgement is persisted as a server-confirmed audit fact');
  await db.query(`UPDATE payroll_scheme_versions SET config_json=jsonb_set(config_json, '{payoutRiskAcknowledgement}',
    (config_json->'payoutRiskAcknowledgement') - 'confirmed') WHERE venue_id=$1 AND id=$2`, [liveVenueId, cleanVersionId]);
  const cleanVersion = await api(`/api/payroll/versions/${cleanVersionId}`, 'GET', undefined, 200, liveOwnerToken);
  assert.ok(cleanVersion.payoutRiskAcknowledgementCurrent, 'saved QA version must retain its current payout-risk acknowledgement');
  assert.equal(cleanVersion.payoutRiskAcknowledgement.confirmed, true,
    'a legacy server-issued audit with a valid current digest is normalized on read for compatibility');
  const cleanReadiness = await api(`/api/payroll/versions/${cleanVersionId}/source-readiness?from=${cleanPeriodFrom}&to=${cleanSaleEvent.recognized_local_date}`,
    'GET', undefined, 200, liveOwnerToken);
  assert.equal(cleanReadiness.components.payrollSaleCredit.watermarkScope, 'owner_policy_bound_pre_refund_sale_credit');
  const beforeCleanCandidate = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
      (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
      (SELECT count(*)::int FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.venue_id=$1) AS refunds`, [liveVenueId])).rows[0];
  const cleanPreviewRequest = { periodFrom: cleanPeriodFrom, periodTo: cleanSaleEvent.recognized_local_date };
  const cleanCandidate = await api(`/api/payroll/versions/${cleanVersionId}/preview/sourced`, 'POST', cleanPreviewRequest, 200, liveOwnerToken);
  const cleanCandidateReplay = await api(`/api/payroll/versions/${cleanVersionId}/preview/sourced`, 'POST', cleanPreviewRequest, 200, liveOwnerToken);
  for (const candidate of [cleanCandidate, cleanCandidateReplay]) {
    assert.equal(candidate.candidateCalculation.status, 'scenario_ready', JSON.stringify({ reasons: candidate.candidateCalculation.reasons,
      payrollSaleCredit: cleanReadiness.components.payrollSaleCredit, canonicalLinePricing: cleanReadiness.components.canonicalLinePricing,
      acknowledgement: cleanVersion.payoutRiskAcknowledgementCurrent }));
    assert.equal(candidate.candidateCalculation.candidateOnly, true);
    assert.equal(candidate.candidateCalculation.nonPayable, true);
    assert.equal(candidate.candidateCalculation.nonAccrual, true);
    assert.equal(candidate.candidateCalculation.officialReady, false);
    assert.equal(candidate.candidateCalculation.payoutEligible, false);
    assert.equal(candidate.candidateSnapshot?.candidateOnly, true);
    assert.equal(candidate.candidateSnapshot?.persistence, 'none');
    assert.equal(candidate.candidateSnapshot?.schemeVersionId, cleanVersionId);
    assert.equal(candidate.candidateSnapshot?.amountCents, candidate.candidateCalculation.amountCents);
    assert.equal(candidate.candidateSnapshot?.source?.inputWatermark, candidate.candidateCalculation.inputWatermark);
    assert.equal(candidate.candidateCalculation.amountCents, 2010, '10 percent of the immutable 20,100 kopek line net is 2,010 kopeks');
    assert.equal(candidate.candidateCalculation.employees.length, 1);
    assert.equal(candidate.candidateCalculation.employees[0].employeeId, liveSellerId);
    assert.equal(candidate.candidateCalculation.employees[0].amountCents, 2010);
    const saleDays = candidate.candidateCalculation.daily.flatMap(day => day.employees
      .filter(employee => employee.employeeId === liveSellerId && employee.amountCents > 0)
      .map(employee => ({ ...employee, date: day.date, lines: day.lines })));
    assert.equal(saleDays.length, 1, 'zero-revenue employee-days remain visible in the candidate period');
    assert.equal(saleDays[0].date, cleanSaleEvent.recognized_local_date);
    assert.equal(saleDays[0].amountCents, 2010);
    assert.equal(saleDays[0].lines.length, 1);
    assert.equal(saleDays[0].lines[0].lineId, cleanSaleEvent.sale_line_id);
    assert.equal(saleDays[0].lines[0].commissionBaseCents, 20100);
    assert.equal(saleDays[0].lines[0].commissionCents, 2010);
  }
  assert.deepEqual(cleanCandidate.candidateCalculation, cleanCandidateReplay.candidateCalculation,
    'repeated candidate calculation reproduces the complete employee/day/line result');
  assert.equal(cleanCandidate.candidateCalculation.inputWatermark, cleanCandidateReplay.candidateCalculation.inputWatermark,
    'repeated source calculation uses the same immutable input fingerprint');
  assert.equal(cleanCandidate.sourceWatermark, cleanCandidateReplay.sourceWatermark,
    'repeated preview uses the same sourced preview fingerprint');
  assert.deepEqual(cleanCandidate.candidateSnapshot, cleanCandidateReplay.candidateSnapshot,
    'candidate snapshot replay returns identical source-bound line evidence');
  const alternateDefinition = structuredClone(cleanDefinition);
  alternateDefinition.roleParameters.bartender.stableRateBps = 1500;
  const alternateVersion = await api(`/api/payroll/schemes/${cleanScheme.id}/versions`, 'POST', {
    definition: alternateDefinition, payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' }
  }, 201, liveOwnerToken);
  const sourcedComparisonRequest = { versionIds: [cleanVersionId, alternateVersion.versionId], baselineVersionId: cleanVersionId,
    periodFrom: cleanPeriodFrom, periodTo: cleanSaleEvent.recognized_local_date };
  const sourcedComparison = await api('/api/payroll/compare/sourced', 'POST', sourcedComparisonRequest, 200, liveOwnerToken);
  const sourcedComparisonReplay = await api('/api/payroll/compare/sourced', 'POST', sourcedComparisonRequest, 200, liveOwnerToken);
  assert.equal(sourcedComparison.comparisonKind, 'sourced_candidate');
  assert.equal(sourcedComparison.status, 'scenario_ready');
  assert.equal(sourcedComparison.candidateOnly, true);
  assert.equal(sourcedComparison.officialReady, false);
  assert.equal(sourcedComparison.persistence, 'none');
  assert.match(sourcedComparison.sharedSourceWatermark, /^[a-f0-9]{64}$/);
  assert.equal(sourcedComparison.comparisons[0].amountCents, 2010);
  assert.equal(sourcedComparison.comparisons[0].deltaToBaselineCents, 0);
  assert.equal(sourcedComparison.comparisons[1].amountCents, 3015);
  assert.equal(sourcedComparison.comparisons[1].deltaToBaselineCents, 1005);
  assert.equal(sourcedComparison.comparisons[1].employeeDeltas[0].deltaCents, 1005);
  assert.equal(sourcedComparison.results[0].candidateSnapshot?.persistence, 'none');
  assert.equal(sourcedComparison.results[1].candidateSnapshot?.amountCents, 3015);
  assert.deepEqual(sourcedComparison, sourcedComparisonReplay, 'same-source compare replays the same output and watermark');

  // Exercise the sourced team-fund candidate end-to-end against the same real
  // immutable POS sale before this fixture creates any refunds. The owner
  // persists the historical product mapping, employee eligibility, saved
  // payroll version, and approved attendance; the preview request supplies
  // only its local date period.
  const positiveWeightEmployeeId = randomUUID();
  const positiveWeightLogin = `recognition-live-team-seller-${marker}`;
  await db.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'Eligible team seller',$4,$5,'bartender','[]'::jsonb)`,
  [positiveWeightEmployeeId, liveVenueId, ids.org, positiveWeightLogin, hash]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",
    [ids.org, positiveWeightEmployeeId]);
  const positiveWeightToken = (await api('/api/login', 'POST', { username: positiveWeightLogin, password }, 200, undefined)).token;
  const teamTable = await api('/api/floor/tables', 'POST', { expectedVenueId: liveVenueId, zoneId: liveZone.id,
    name: `Team ${marker}`, capacity: 2 }, 201, liveOwnerToken);
  const teamOrder = await api('/api/orders', 'POST', { tableId: teamTable.id }, 201, liveOwnerToken);
  const teamOrderLine = await api(`/api/orders/${teamOrder.id}/items`, 'POST', { productId: liveProduct.id, quantity: 2 }, 201, positiveWeightToken);
  assert.equal(teamOrderLine.salesEmployeeId, positiveWeightEmployeeId);
  await api(`/api/orders/${teamOrder.id}/close`, 'POST', { paymentMethod: 'card', paymentAccountId: liveAccountId }, 200, liveOwnerToken);
  const teamSaleEvent = (await db.query(`SELECT e.id::text,e.recognized_local_date::text,l.id::text AS sale_line_id,
      l.seller_id::text AS employee_id FROM pos_payroll_sale_events e JOIN pos_payroll_sale_line_events l ON l.sale_event_id=e.id
    WHERE e.venue_id=$1 AND e.order_id=$2`, [liveVenueId, teamOrder.id])).rows[0];
  assert.ok(teamSaleEvent);
  assert.equal(teamSaleEvent.employee_id, positiveWeightEmployeeId);
  assert.equal(teamSaleEvent.recognized_local_date, cleanSaleEvent.recognized_local_date,
    'both team-fund source lines belong to the same venue-local day');
  const noSalesEmployeeId = randomUUID();
  const noSalesLogin = `recognition-live-no-sales-${marker}`;
  await db.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role,permission_scopes)
    VALUES($1,$2,$3,'Eligible team member without sales',$4,'bartender','[]'::jsonb)`,
  [noSalesEmployeeId, liveVenueId, ids.org, noSalesLogin]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",
    [ids.org, noSalesEmployeeId]);
  const teamEligibility = await api('/api/payroll/employment-eligibility', 'POST', {
    reason: 'Confirm eligible team roster for sourced team fund QA', idempotencyKey: `team-eligibility-${marker}`,
    expectedRevisionId: employment.revisionId || employment.id,
    periods: [liveSellerId, positiveWeightEmployeeId, noSalesEmployeeId].map(employeeId => ({ employeeId,
      effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd }))
  }, 201, liveOwnerToken);
  assert.equal(teamEligibility.periods.length, 3, 'saved owner eligibility includes both sellers and the no-sales team member');

  const mappingCollection = await api('/api/payroll/product-department-mappings', 'GET', undefined, 200, liveOwnerToken);
  const teamMapping = await api('/api/payroll/product-department-mappings/retroactive-revisions', 'POST', {
    expectedRevisionId: mappingCollection.currentRevision?.id || null,
    idempotencyKey: `team-department-${marker}`,
    reason: 'Classify the immutable QA sale line for team fund',
    effectiveFrom: cleanSaleEvent.recognized_local_date,
    retroactiveReason: 'Owner attests the product department at the historical sale date for QA',
    ownerAttestation: { confirmed: true, action: 'retroactive_payroll_product_department_mapping' },
    mappings: [{ productId: liveProduct.id, productName: liveProduct.name, departmentCode: 'drinks',
      departmentName: 'Напитки', effectiveFrom: cleanSaleEvent.recognized_local_date, effectiveTo: null }]
  }, 201, liveOwnerToken);
  assert.equal((await api(`/api/payroll/product-department-mappings/revisions/${teamMapping.id}`, 'GET', undefined, 200,
    liveOwnerToken)).payloadSha256, teamMapping.payloadSha256, 'owner can re-read the immutable historical department revision');
  const persistedTeamMapping = (await db.query(`SELECT count(*)::int AS rows FROM payroll_product_department_mappings
    WHERE venue_id=$1 AND revision_id=$2 AND product_id=$3 AND department_code='drinks'
      AND effective_from=$4::date AND effective_to IS NULL`,
  [liveVenueId, teamMapping.id, liveProduct.id, cleanSaleEvent.recognized_local_date])).rows[0].rows;
  assert.equal(persistedTeamMapping, 1, 'historical product mapping is stored under the owner revision');

  const teamSaleDate = cleanSaleEvent.recognized_local_date;
  await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
    VALUES($1,$2,$3::date,($3::date::text || 'T10:00:00+05:00')::timestamptz,
      ($3::date::text || 'T14:00:00+05:00')::timestamptz,$4)`, [liveVenueId, liveSellerId, teamSaleDate, liveOwnerId]);
  await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
    VALUES($1,$2,($3::date::text || 'T10:00:00+05:00')::timestamptz,
      ($3::date::text || 'T12:00:00+05:00')::timestamptz,'manual')`, [liveVenueId, liveSellerId, teamSaleDate]);
  await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
    VALUES($1,$2,$3::date,($3::date::text || 'T10:00:00+05:00')::timestamptz,
      ($3::date::text || 'T13:00:00+05:00')::timestamptz,$4)`, [liveVenueId, positiveWeightEmployeeId, teamSaleDate, liveOwnerId]);
  await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
    VALUES($1,$2,($3::date::text || 'T10:00:00+05:00')::timestamptz,
      ($3::date::text || 'T11:00:00+05:00')::timestamptz,'manual')`, [liveVenueId, positiveWeightEmployeeId, teamSaleDate]);
  const attendanceFrom = cleanPeriodFrom;
  const attendanceQuery = `from=${attendanceFrom}&to=${teamSaleDate}`;
  const attendanceCoverage = await api(`/api/payroll/attendance/approvals?${attendanceQuery}`, 'GET', undefined, 200, liveOwnerToken);
  assert.equal(attendanceCoverage.complete, true, JSON.stringify(attendanceCoverage.reasons));
  assert.equal(attendanceCoverage.shifts.length, 2);
  assert.deepEqual(attendanceCoverage.shifts.map(row => [row.employeeId, row.workedMinutes]).sort((a, b) => a[0].localeCompare(b[0])),
    [[liveSellerId, 120], [positiveWeightEmployeeId, 60]].sort((a, b) => a[0].localeCompare(b[0])));
  const teamAttendanceApproval = await api('/api/payroll/attendance/approvals', 'POST', {
    periodFrom: attendanceFrom, periodTo: teamSaleDate, sourceWatermark: attendanceCoverage.sourceWatermark,
    reason: 'Owner approves actual team member attendance for candidate QA',
    idempotencyKey: `team-attendance-${marker}`
  }, 201, liveOwnerToken);
  const attendanceReadback = await api(`/api/payroll/attendance/approvals?${attendanceQuery}`, 'GET', undefined, 200, liveOwnerToken);
  assert.equal(attendanceReadback.currentApproval.approvalId, teamAttendanceApproval.approvalId,
    'approved attendance survives a fresh owner API read');

  const teamDefinition = { mode: 'team_fund', currency: 'RUB', effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd,
    roleParameters: { bartender: { mode: 'team_fund', perShiftCents: 0, teamFund: { poolId: 'qa-drinks-day', targetCents: 50000,
      baseRateBps: 1000, bonusRateBps: 0, excessRatePolicy: 'replace_base', distributionPolicy: 'approved_minutes',
      departments: ['drinks'] } } },
    roleAssignments: [liveSellerId, positiveWeightEmployeeId, noSalesEmployeeId].map(employeeId => ({ employeeId, roleId: 'bartender',
      effectiveFrom: cleanPeriodFrom, effectiveTo: cleanPeriodEnd })),
    employeeOverrides: [], itemRules: [],
    sourcePolicies: { schemaVersion: 1, selectionReason: 'QA binds actual immutable sale seller, price, department and attendance',
      saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
      refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
        paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } } };
  const teamScheme = await api('/api/payroll/schemes', 'POST', { name: 'Sourced team fund candidate QA',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' }, definition: teamDefinition
  }, 201, liveOwnerToken);
  const teamVersionId = teamScheme.versions[0].versionId;
  const teamVersionReadback = await api(`/api/payroll/versions/${teamVersionId}`, 'GET', undefined, 200, liveOwnerToken);
  assert.equal(teamVersionReadback.versionId, teamVersionId);
  assert.equal(teamVersionReadback.mode, 'team_fund');
  assert.deepEqual(teamVersionReadback.roleAssignments.map(row => row.employeeId).sort(),
    [liveSellerId, positiveWeightEmployeeId, noSalesEmployeeId].sort(), 'saved team version retains the full eligible pool roster');
  const teamCountsBefore = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
      (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
      (SELECT count(*)::int FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.venue_id=$1) AS refunds`, [liveVenueId])).rows[0];
  const teamPreviewRequest = { periodFrom: attendanceFrom, periodTo: teamSaleDate };
  const teamCandidate = await api(`/api/payroll/versions/${teamVersionId}/preview/sourced`, 'POST', teamPreviewRequest, 200, liveOwnerToken);
  const teamCandidateReplay = await api(`/api/payroll/versions/${teamVersionId}/preview/sourced`, 'POST', teamPreviewRequest, 200, liveOwnerToken);
  for (const candidate of [teamCandidate, teamCandidateReplay]) {
    const calculation = candidate.candidateCalculation;
    assert.equal(calculation.status, 'scenario_ready', JSON.stringify({ reasons: calculation.reasons,
      components: candidate.sources?.readiness?.components, calculationInput: candidate.calculationInputContract?.reasons }));
    assert.equal(calculation.mode, 'team_fund');
    assert.equal(candidate.versionId, teamVersionId);
    assert.equal(calculation.schemeVersionId, teamVersionId);
    assert.equal(calculation.currency, 'RUB');
    assert.deepEqual(calculation.period, { from: attendanceFrom, to: teamSaleDate });
    assert.match(calculation.inputWatermark, /^[a-f0-9]{64}$/);
    assert.equal(calculation.amountCents, 4020, 'the mapped 40,200-cent pool basis below its 50,000-cent target earns a 10-percent team fund');
    assert.equal(calculation.candidateOnly, true);
    assert.equal(calculation.nonPayable, true);
    assert.equal(calculation.nonAccrual, true);
    assert.equal(calculation.officialReady, false);
    assert.equal(calculation.payoutEligible, false);
    assert.deepEqual(calculation.disclaimers, ['scenario_only', 'not_payable', 'not_accrued', 'no_payroll_run_created']);
    assert.equal(candidate.calculationInputContract.status, 'blocked',
      'the official calculator input contract stays blocked for candidate-only team fund evidence');
    assert(candidate.calculationInputContract.reasons.includes('payroll_team_fund_candidate_evidence_not_official'));
    assert.equal(candidate.sources.departmentAttribution.status, 'available');
    assert.equal(candidate.sources.fullEmployeeNetRevenue.status, 'available');
    assert.equal(candidate.sources.fullEmployeeNetRevenue.amount, 40200,
      'the independent full-net evidence exactly reconciles both discounted recognized sale lines before any refund');
    assert.deepEqual(candidate.sources.fullEmployeeNetRevenue.daily.map(row => [row.employeeId, row.date, row.netMinor]).sort((a, b) => a[0].localeCompare(b[0])),
      [[liveSellerId, teamSaleDate, 20100], [positiveWeightEmployeeId, teamSaleDate, 20100]].sort((a, b) => a[0].localeCompare(b[0])));
    assert.equal(candidate.sources.fullEmployeeNetRevenue.daily.some(row => row.employeeId === noSalesEmployeeId), false,
      'a complete source omits an employee/day with no recognized sale or refund events');
    assert.equal(calculation.employees.find(row => row.employeeId === liveSellerId)?.personalRevenueCents, 20100,
      'the existing scenario ceiling proxy reconciles to the independent merchandise-net source for this no-refund day');
    assert.equal(calculation.employees.find(row => row.employeeId === positiveWeightEmployeeId)?.personalRevenueCents, 20100,
      'both seller/day ceiling values match the independent complete source in this no-refund candidate');
    assert.equal(calculation.employees.find(row => row.employeeId === noSalesEmployeeId)?.personalRevenueCents, 0,
      'the existing calculator proxy is zero for the roster member with no recognized sale row');
    assert.equal(candidate.sources.departmentAttribution.coverage.mappingRevisionId, teamMapping.id);
    assert.equal(candidate.sources.departmentAttribution.mappingRevision.id, teamMapping.id);
    assert.equal(candidate.sources.departmentAttribution.coverage.recognitionWatermark,
      candidate.sources.readiness.components.recognitionManifest.sourceWatermark);
    assert.deepEqual(candidate.sources.departmentAttribution.rows.map(row => [row.saleLineEventId, row.employeeId,
      row.recognizedLocalDate, row.departmentCode]).sort((a, b) => a[0].localeCompare(b[0])),
    [[cleanSaleEvent.sale_line_id, liveSellerId, teamSaleDate, 'drinks'], [teamSaleEvent.sale_line_id, positiveWeightEmployeeId,
      teamSaleDate, 'drinks']].sort((a, b) => a[0].localeCompare(b[0])));
    assert.equal(candidate.sources.readiness.components.approvedAttendance.approvalId, teamAttendanceApproval.approvalId);
    for (const componentKey of ['approvedAttendance', 'immutableDepartmentAttribution', 'departmentShiftAllocation', 'teamMembershipAndWeights']) {
      const component = candidate.sources.readiness.components[componentKey];
      assert.equal(component.status, 'available', `${componentKey} is available for the team source`);
      assert.match(component.sourceWatermark, /^[a-f0-9]{64}$/);
    }
    assert.equal(candidate.sources.readiness.components.immutableDepartmentAttribution.sourceWatermark,
      candidate.sources.departmentAttribution.sourceWatermark);
    assert.equal(calculation.employees.find(row => row.employeeId === liveSellerId)?.teamFundCents, 2680);
    assert.equal(calculation.employees.find(row => row.employeeId === positiveWeightEmployeeId)?.teamFundCents, 1340);
    assert.equal(calculation.employees.find(row => row.employeeId === noSalesEmployeeId)?.teamFundCents, 0,
      'eligible no-sales member remains present with a real zero approved-minute weight');
    const saleDayCalculation = calculation.daily.find(day => day.date === teamSaleDate);
    assert.ok(saleDayCalculation, 'candidate includes the local sale day');
    assert.equal(saleDayCalculation.teamFunds.length, 1);
    assert.equal(saleDayCalculation.teamFunds[0].basisCents, 40200);
    assert.deepEqual(saleDayCalculation.teamFunds[0].departments, ['drinks']);
    assert.deepEqual(saleDayCalculation.teamFunds[0].memberIds.sort(), [liveSellerId, positiveWeightEmployeeId, noSalesEmployeeId].sort());
    assert.deepEqual(saleDayCalculation.teamFunds[0].sourceLineIds.sort(), [cleanSaleEvent.sale_line_id, teamSaleEvent.sale_line_id].sort());
    assert.deepEqual(saleDayCalculation.teamFunds[0].allocations.map(row => [row.id, row.weight, row.amountCents]).sort((a, b) => a[0].localeCompare(b[0])),
      [[liveSellerId, 120, 2680], [positiveWeightEmployeeId, 60, 1340], [noSalesEmployeeId, 0, 0]].sort((a, b) => a[0].localeCompare(b[0])),
      'approved-minute weights distribute exact shares to both selling members and retain the zero-weight no-sales member');
    assert.equal(saleDayCalculation.lines.length, 2);
    assert.deepEqual(saleDayCalculation.lines.map(line => ({ lineId: line.lineId, employeeId: line.employeeId,
      date: saleDayCalculation.date, department: line.department, commissionBaseCents: line.commissionBaseCents })).sort((a, b) => a.lineId.localeCompare(b.lineId)),
    [{ lineId: cleanSaleEvent.sale_line_id, employeeId: liveSellerId, date: teamSaleDate, department: 'drinks', commissionBaseCents: 20100 },
      { lineId: teamSaleEvent.sale_line_id, employeeId: positiveWeightEmployeeId, date: teamSaleDate, department: 'drinks', commissionBaseCents: 20100 }]
      .sort((a, b) => a.lineId.localeCompare(b.lineId)), 'calculated lines are bound to their immutable sellers/date/department facts');
  }
  assert.deepEqual(teamCandidate.candidateCalculation, teamCandidateReplay.candidateCalculation,
    'same saved team version and source revisions reproduce the exact candidate calculation');
  assert.deepEqual(teamCandidate.candidateSnapshot, teamCandidateReplay.candidateSnapshot,
    'team-fund snapshot retains the same source and distribution evidence on replay');
  assert.equal(teamCandidate.sourceWatermark, teamCandidateReplay.sourceWatermark);
  assert.equal(teamCandidateReplay.candidateCalculation.inputWatermark, teamCandidate.candidateCalculation.inputWatermark);
  assert.equal((await api(`/api/payroll/versions/${teamVersionId}/preview/sourced`, 'POST', teamPreviewRequest, 403,
    liveSellerToken)).error, 'payroll_scheme_owner_only', 'non-owner employee cannot read team payroll details');
  assert.equal((await api(`/api/payroll/versions/${teamVersionId}/preview/sourced`, 'POST', teamPreviewRequest, 404,
    ownerToken)).error, 'payroll_scheme_version_not_found', 'another venue owner cannot read this team payroll version');
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
      (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
      (SELECT count(*)::int FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.venue_id=$1) AS refunds`, [liveVenueId])).rows[0],
  teamCountsBefore, 'team candidate preview/replay and denied reads create no runs, entries, expenses, payments or refunds');

  const afterCleanCandidate = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
      (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
      (SELECT count(*)::int FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.venue_id=$1) AS refunds`, [liveVenueId])).rows[0];
  assert.deepEqual(afterCleanCandidate, { ...beforeCleanCandidate, payments: 2 },
    'candidate preview leaves payroll, expense, payment, and refund records unchanged');
  const liveRefundIds = [];
  for (const suffix of ['one', 'two']) {
    const refund = await api(`/api/finance/orders/${liveOrder.id}/refunds`, 'POST', { amount: 1, reason: `Sourced preview partial return ${suffix}`,
      idempotencyKey: `sourced-${marker}-${suffix}`, allocations: [{ sourcePaymentId: livePayment.id, amount: 1, payoutMethod: 'card', paymentAccountId: liveAccountId }],
      items: [{ orderItemId: liveLine.id, quantity: 1 }] }, 201, liveOwnerToken);
    liveRefundIds.push(refund.id);
  }
  const liveSaleEvents = (await db.query(`SELECT e.id::text,e.recognized_local_date::text,l.id::text AS sale_line_id,
      l.seller_id::text AS employee_id
    FROM pos_payroll_sale_events e JOIN pos_payroll_sale_line_events l ON l.sale_event_id=e.id
    WHERE e.venue_id=$1 AND e.order_id=ANY($2::uuid[]) ORDER BY e.order_id,l.id`,
    [liveVenueId, [liveOrder.id, teamOrder.id]])).rows;
  assert.equal(liveSaleEvents.length, 2, 'both real POS sellers have immutable source lines');
  const liveSaleEvent = liveSaleEvents.find(row => row.employee_id === liveSellerId);
  const liveTeamSaleEvent = liveSaleEvents.find(row => row.employee_id === positiveWeightEmployeeId);
  assert.ok(liveSaleEvent && liveTeamSaleEvent);
  const liveRefundFacts = (await db.query(`SELECT e.id::text AS event_id,e.refund_id::text,e.recognized_local_date::text,
      l.refund_item_id::text,l.original_sale_line_event_id::text,l.returned_item_value_minor::text,
      e.coverage_status='complete' AND e.item_attribution_status='complete' AS complete
    FROM pos_payroll_refund_events e JOIN pos_payroll_refund_line_events l ON l.refund_event_id=e.id
    WHERE e.venue_id=$1 AND e.order_id=$2 ORDER BY e.recognized_at,e.id,l.id`, [liveVenueId, liveOrder.id])).rows;
  assert.equal(liveRefundFacts.length, 2);
  assert(liveRefundFacts.every(row => row.complete));
  assert(liveRefundFacts.every(row => row.original_sale_line_event_id === liveSaleEvent.sale_line_id),
    'each refund fact points to the immutable original sale line');
  assert.deepEqual(liveRefundFacts.map(row => row.refund_id).sort(), liveRefundIds.sort());
  assert(liveRefundFacts.every(row => row.returned_item_value_minor === '10050'));
  const liveEventMonths = [...new Set([...liveSaleEvents.map(row => row.recognized_local_date), ...liveRefundFacts.map(row => row.recognized_local_date)]
    .map(date => date.slice(0, 7)))].sort();
  const liveFrom = `${liveEventMonths[0]}-01`;
  const lastMonth = liveEventMonths[liveEventMonths.length - 1];
  const [liveYear, liveMonth] = lastMonth.split('-').map(Number);
  const liveTo = new Date(Date.UTC(liveYear, liveMonth, 0)).toISOString().slice(0, 10);
  const teamRefundCountsBefore = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [liveVenueId])).rows[0];
  const teamRefundPreview = await api(`/api/payroll/versions/${teamVersionId}/preview/sourced`, 'POST',
    { periodFrom: liveFrom, periodTo: liveTo }, 200, liveOwnerToken);
  assert.equal(teamRefundPreview.candidateOnly, true);
  assert.equal(teamRefundPreview.officialReady, false);
  assert.equal(teamRefundPreview.candidateCalculation.status, 'blocked');
  assert.equal(teamRefundPreview.candidateSnapshot, null, 'refund-blocked candidate emits no snapshot bundle');
  assert(teamRefundPreview.candidateCalculation.reasons.includes('payroll_candidate_no_refund_coverage_not_proven'),
    'team-fund candidate fails closed after recognized refunds until the calculator can consume signed refund evidence');
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [liveVenueId])).rows[0], teamRefundCountsBefore,
  'refund-blocked team candidate leaves payroll, expense and run records unchanged');
  const liveScheme = await api('/api/payroll/schemes', 'POST', { name: 'Real sourced preview QA',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'percent_only', currency: 'RUB', effectiveFrom: liveFrom, effectiveTo: liveTo,
      roleParameters: { bartender: { stableRateBps: 1000 } }, roleAssignments: [], employeeOverrides: [], itemRules: [],
      sourcePolicies: { schemaVersion: 1, selectionReason: 'QA verifies immutable recognized source through owner preview',
        saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
        refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
          paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } } }
  }, 201, liveOwnerToken);
  const liveVersionId = liveScheme.versions[0].versionId;
  const beforePreviewCounts = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [liveVenueId])).rows[0];
  const expectedEvents = liveSaleEvents.map(row => ({ kind: 'sale', id: row.sale_line_id, eventId: row.id,
    employeeId: row.employee_id, amountMinor: 20100, date: row.recognized_local_date }));
  const saleEmployeeByLineId = new Map(liveSaleEvents.map(row => [row.sale_line_id, row.employee_id]));
  for (const row of liveRefundFacts) expectedEvents.push({ kind: 'refund', id: row.refund_item_id, eventId: row.event_id,
    employeeId: saleEmployeeByLineId.get(row.original_sale_line_event_id), originalSaleLineId: row.original_sale_line_event_id,
    amountMinor: -Number(row.returned_item_value_minor), date: row.recognized_local_date });
  for (const month of liveEventMonths) {
    const periodFrom = `${month}-01`;
    const [periodYear, periodMonth] = month.split('-').map(Number);
    const periodTo = new Date(Date.UTC(periodYear, periodMonth, 0)).toISOString().slice(0, 10);
    const liveCandidate = await api(`/api/payroll/versions/${liveVersionId}/preview/sourced`, 'POST',
      { periodFrom, periodTo }, 200, liveOwnerToken);
    assert.equal(liveCandidate.candidateOnly, true);
    assert.equal(liveCandidate.officialReady, false);
    assert.equal(liveCandidate.calculationStatus, 'unavailable');
    assert.equal(liveCandidate.amount, null);
    const liveSeries = liveCandidate.sources.fullEmployeeNetRevenue;
    assert.equal(liveSeries.status, 'available', JSON.stringify(liveSeries.reasons));
    const expectedForMonth = expectedEvents.filter(event => event.date.startsWith(month));
    const expectedByEmployeeAndDay = new Map();
    for (const event of expectedForMonth) {
      const key = `${event.employeeId}:${event.date}`;
      expectedByEmployeeAndDay.set(key, (expectedByEmployeeAndDay.get(key) || 0) + event.amountMinor);
    }
    const actualForMonth = liveSeries.daily.flatMap(day => {
      assert.equal(day.date.startsWith(month), true);
      assert.equal(expectedByEmployeeAndDay.has(`${day.employeeId}:${day.date}`), true, 'source day belongs to a seller with recognized events');
      assert.equal(day.sourceEvents.reduce((sum, event) => sum + event.amountMinor, 0), day.netMinor,
        'source event rows reconcile to each employee/day amount');
      assert.equal(day.netMinor, expectedByEmployeeAndDay.get(`${day.employeeId}:${day.date}`),
        'sale and refund net remains with the immutable original line seller');
      return day.sourceEvents.map(event => ({ ...event, employeeId: day.employeeId, date: day.date }));
    });
    const normalize = events => events.map(({ kind, id, eventId, employeeId, originalSaleLineId, amountMinor, date }) =>
      ({ kind, id, eventId, employeeId, ...(originalSaleLineId ? { originalSaleLineId } : {}), amountMinor, date }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    assert.deepEqual(normalize(actualForMonth), normalize(expectedForMonth),
      `every source event, sign, local recognition date, and original sale-line link reconciles for ${month}`);
    assert.equal(liveSeries.amount, expectedForMonth.reduce((sum, event) => sum + event.amountMinor, 0),
      `monthly series total reconciles to recognized source facts for ${month}`);
  }
  const afterPreviewCounts = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [liveVenueId])).rows[0];
  assert.deepEqual(afterPreviewCounts, beforePreviewCounts, 'candidate preview does not create runs, payroll entries, or expenses');
  console.log('PAYROLL SOURCED PREVIEW: PASS (HTTP POS sale/refunds → owner sourced API → original seller/day net, no payroll writes)');
  console.log('PAYROLL RECOGNITION MANIFEST POSTGRES: PASS (HTTP sale/refund producers, source manifest, full 092 history, payout/merchandise separation, RR/RO boundary, no payroll writes)');
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(5000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  await db.end().catch(() => {});
}
