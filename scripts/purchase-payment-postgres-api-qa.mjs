import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PurchaseDocumentRepository } from '../db.js';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i, 'purchase-payment API QA requires a runner-created disposable orders database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own the disposable database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid, 'the local regression runner owns the database lock');
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const validation = require('../purchase-document-validation.js');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const operationalRoleHelper = server.match(/const isOperationalEmployee = \(req\) => \[[^\]]+\]\.includes\(String\(req\.user\?\.role \|\| ''\)\.toLowerCase\(\)\);/)?.[0];
assert.ok(operationalRoleHelper, 'production employee-role predicate is available');
const isOperationalEmployee = new Function(`${operationalRoleHelper}; return isOperationalEmployee;`)();
const routeStart = server.indexOf("if (pathname === '/api/finance/purchase-payables' && req.method === 'GET')");
const routeEnd = server.indexOf("if (pathname === '/api/expenses' && req.method === 'GET')", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'supplier payable/payment API handlers are available');
const route = server.slice(routeStart, routeEnd);
const voidRouteStart = server.indexOf("if (purchaseDocumentVoidPath && req.method === 'POST')");
const voidRouteEnd = server.indexOf("if (purchaseDocumentPostPath && req.method === 'POST')", voidRouteStart);
assert.ok(voidRouteStart >= 0 && voidRouteEnd > voidRouteStart, 'draft receipt cancellation API handler is available');
const voidRoute = server.slice(voidRouteStart, voidRouteEnd);
const isValidIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
let venueId = null;
let otherVenueId = null;

const callApi = async ({ path, method = 'GET', body = {}, permissions = ['finance'], role = 'owner', venue = venueId }) => {
  let response;
  const pathname = path;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const denyUnlessAny = (req, res, required) => {
    if (required.some((permission) => req.user?.permissions?.includes(permission))) return false;
    json(res, 403, { error: 'forbidden', permissions: required });
    return true;
  };
  const denyUnless = (req, res, required) => denyUnlessAny(req, res, [required]);
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnlessAny','denyUnless','body','json','recordAudit','isOperationalEmployee','validatePurchasePaymentDocument','isValidIsoDate',
    `return (async()=>{${route}})();`)(
    pathname,
    { method, headers: {}, user: { id: null, permissions, role } }, {},
    { pool, purchaseDocuments: new PurchaseDocumentRepository(pool) }, venue,
    denyUnlessAny, denyUnless, async () => body,
    json, () => {}, isOperationalEmployee,
    validation.validateDataUrl, isValidIsoDate,
  );
  return response || result;
};
const callVoidApi = async (id, permissions = ['inventory']) => {
  let response;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const denyUnless = (req, res, required) => {
    if (req.user?.permissions?.includes(required)) return false;
    json(res, 403, { error: 'forbidden', permissions: [required] });
    return true;
  };
  const audit = [];
  await new Function('pathname','req','res','repositories','venueDbId','denyUnless','json','recordAudit',
    `return (async()=>{ const purchaseDocumentVoidPath=pathname.match(/^\\/api\\/inventory\\/purchase-documents\\/([^/]+)\\/void$/); ${voidRoute} })();`)(
    `/api/inventory/purchase-documents/${id}/void`, { method: 'POST', user: { id: null, permissions } }, {},
    { purchaseDocuments: new PurchaseDocumentRepository(pool) }, venueId, denyUnless, json,
    (_req, action, entity, entityId, before, after) => audit.push({ action, entity, entityId, before, after }));
  return { ...response, audit };
};

try {
  await setup.connect();
  const identity = (await setup.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'purchase-payment API disposable PostgreSQL');
  const organizationId = (await setup.query("INSERT INTO organizations (name,slug,timezone) VALUES ('Purchase-payment API QA','purchase-payment-api-qa-' || gen_random_uuid()::text,'Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  await setup.query("INSERT INTO organization_subscriptions (organization_id,status) VALUES ($1,'trialing')", [organizationId]);
  venueId = (await setup.query("INSERT INTO venues (organization_id,name) VALUES ($1,'Isolated purchase-payment API QA') RETURNING id", [organizationId])).rows[0].id;
  otherVenueId = (await setup.query("INSERT INTO venues (organization_id,name) VALUES ($1,'Isolated purchase-payment tenant QA') RETURNING id", [organizationId])).rows[0].id;
  const ingredientId = (await setup.query(`INSERT INTO ingredients (venue_id,name,unit,cost,is_marked,purchase_unit,pack_multiplier)
    VALUES ($1,'QA syrup','ml',0,true,'bottle',1000) RETURNING id`, [venueId])).rows[0].id;

  const repository = new PurchaseDocumentRepository(pool);
  const draft = await repository.saveDraft({
    venueId, supplierName: 'QA supplier', documentNumber: `QA-${process.pid}`, documentDate: '2026-09-27',
    lines: [{ ingredientId, quantity: 2, unit: 'bottle', unitCost: 100 }],
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.totalCost, 200);
  assert.equal(draft.lines[0].stockQuantity, 2000, 'purchase packaging converts to stock units');
  const voidable = await repository.saveDraft({
    venueId, supplierName: 'QA cancellable draft', documentNumber: '', documentDate: null,
    lines: [{ ingredientId, quantity: 3, unit: 'bottle', unitCost: 100 }],
  });
  const deniedVoid = await callVoidApi(voidable.id, []);
  assert.equal(deniedVoid.status, 403, 'unauthorized roles cannot cancel receipt drafts');
  const apiVoid = await callVoidApi(voidable.id);
  assert.equal(apiVoid.status, 200, 'draft cancellation API returns success');
  assert.equal(apiVoid.data.status, 'voided', 'a draft can be cancelled and remains in document history');
  assert.equal(apiVoid.audit[0]?.action, 'inventory.purchase_document_voided', 'draft cancellation is auditable');
  assert.equal(Number((await setup.query('SELECT COUNT(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2', [venueId, ingredientId])).rows[0].count), 0,
    'cancelling a draft never changes stock');
  assert.equal((await callVoidApi(voidable.id)).status, 409, 'a cancelled receipt cannot be cancelled again');
  const undated = await repository.saveDraft({
    venueId, supplierName: 'QA supplier without invoice date', documentNumber: '', documentDate: null,
    lines: [{ ingredientId, quantity: 1, unit: 'bottle', unitCost: 100 }],
  });
  assert.equal(undated.documentDate, null, 'an omitted supplier document date remains NULL in the document model');
  const undatedStored = await setup.query('SELECT document_date,recorded_at FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [undated.id, venueId]);
  assert.equal(undatedStored.rows[0].document_date, null, 'database stores an unknown supplier date as NULL');
  assert.ok(undatedStored.rows[0].recorded_at, 'system record timestamp remains present independently');
  await repository.updateDraft({
    id: undated.id, venueId, supplierName: 'QA supplier without invoice date', documentNumber: '', documentDate: null,
    lines: [{ ingredientId, quantity: 1, unit: 'bottle', unitCost: 100 }],
  });
  const orderedDocuments = await repository.list(venueId);
  const firstUndatedIndex = orderedDocuments.findIndex((document) => !document.documentDate);
  assert.ok(firstUndatedIndex >= 0 && orderedDocuments.some((document) => document.id === undated.id), 'undated document remains in the sorted list');
  assert.ok(orderedDocuments.slice(0, firstUndatedIndex).every((document) => Boolean(document.documentDate)), 'dated documents sort before undated documents');
  assert.ok(orderedDocuments.slice(firstUndatedIndex).every((document) => !document.documentDate), 'undated documents remain grouped last, ordered by system record time');
  const unposted = await callApi({ path: `/api/finance/purchase-payables/${draft.id}/payments`, method: 'POST', body: {
    amount: 1, paymentDate: '2026-09-27', paymentMethod: 'cash', idempotencyKey: `qa:draft:${process.pid}`,
  } });
  assert.equal(unposted.status, 409, 'payment API refuses to settle an unposted draft');
  assert.equal(unposted.data.error, 'purchase_document_not_posted');

  const posted = await repository.post(venueId, draft.id, null);
  assert.equal(posted.totalCost, 200);
  assert.equal(posted.movementIds.length, 1, 'posting creates a stock movement from the receipt');
  const onHand = await setup.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS amount FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredientId]);
  assert.equal(Number(onHand.rows[0].amount), 2000, 'posted receipt updates the stock ledger');
  assert.equal((await callVoidApi(draft.id)).status, 409,
    'a posted receipt cannot be cancelled without an explicit stock reversal');

  let payables = await callApi({ path: '/api/finance/purchase-payables' });
  assert.equal(payables.status, 200);
  assert.equal(payables.data.items.find((item) => item.id === draft.id).balanceDue, 200);
  const paymentPath = `/api/finance/purchase-payables/${draft.id}/payments`;
  const noPermissionRead = await callApi({ path: '/api/finance/purchase-payables', permissions: [] });
  assert.equal(noPermissionRead.status, 403, 'roles without finance access cannot read purchase balances');
  const managerRead = await callApi({ path: '/api/finance/purchase-payables', role: 'manager', permissions: ['finance_read'] });
  assert.equal(managerRead.status, 200, 'finance_read manager can inspect purchase balances');
  const managerHistory = await callApi({ path: paymentPath, role: 'manager', permissions: ['finance_read'] });
  assert.equal(managerHistory.status, 200, 'finance_read manager can inspect payment history');
  const employeeHistory = await callApi({ path: paymentPath, role: 'bartender', permissions: ['finance_read'] });
  assert.equal(employeeHistory.status, 403, 'operational employees cannot inspect purchase payment history');
  const employeePayables = await callApi({ path: '/api/finance/purchase-payables', role: 'bartender', permissions: ['finance_read'] });
  assert.equal(employeePayables.status, 403, 'operational employees cannot inspect supplier balances');
  const managerPayment = await callApi({ path: paymentPath, method: 'POST', role: 'manager', permissions: ['finance_read'], body: {
    amount: 10, paymentDate: '2026-09-27', paymentMethod: 'cash', idempotencyKey: `qa:manager-denied:${process.pid}`,
  } });
  assert.equal(managerPayment.status, 403, 'finance_read alone is read-only and cannot settle a supplier document');
  const noPermissionPayment = await callApi({ path: paymentPath, method: 'POST', permissions: [], body: {
    amount: 10, paymentDate: '2026-09-27', paymentMethod: 'cash', idempotencyKey: `qa:denied:${process.pid}`,
  } });
  assert.equal(noPermissionPayment.status, 403, 'roles without finance access cannot settle a supplier document');
  assert.equal((await setup.query("SELECT COUNT(*)::int AS count FROM expenses WHERE purchase_document_id=$1 AND source='purchase'", [draft.id])).rows[0].count, 0,
    'forbidden roles create no cash movements');
  const foreignHistory = await callApi({ path: paymentPath, venue: otherVenueId });
  assert.equal(foreignHistory.status, 404, 'payment history API hides another venue receipt');
  const foreignPayment = await callApi({ path: paymentPath, method: 'POST', venue: otherVenueId, body: {
    amount: 1, paymentDate: '2026-09-27', paymentMethod: 'cash', idempotencyKey: `qa:foreign:${process.pid}`,
  } });
  assert.equal(foreignPayment.status, 404, 'payment API cannot settle another venue receipt');
  const payment = { amount: 75, paymentDate: '2026-09-27', paymentMethod: 'bank_transfer', idempotencyKey: `qa:payment:${process.pid}` };
  const first = await callApi({ path: paymentPath, method: 'POST', body: payment });
  assert.equal(first.status, 201);
  assert.equal(first.data.balanceDue, 125);
  const retry = await callApi({ path: paymentPath, method: 'POST', body: payment });
  assert.equal(retry.status, 200, `same payment key returns an idempotent replay: ${JSON.stringify(retry)}`);
  assert.equal(retry.data.idempotent, true);
  const conflict = await callApi({ path: paymentPath, method: 'POST', body: { ...payment, amount: 74 } });
  assert.equal(conflict.status, 409, 'reusing the payment key with a changed amount is rejected');
  const overpay = await callApi({ path: paymentPath, method: 'POST', body: { ...payment, amount: 126, idempotencyKey: `qa:overpay:${process.pid}` } });
  assert.equal(overpay.status, 409);
  assert.equal(overpay.data.error, 'purchase_payment_exceeds_balance');

  const final = await callApi({ path: paymentPath, method: 'POST', body: { ...payment, amount: 125, idempotencyKey: `qa:final:${process.pid}`, paymentMethod: 'cash' } });
  assert.equal(final.status, 201);
  assert.equal(final.data.balanceDue, 0);
  payables = await callApi({ path: '/api/finance/purchase-payables' });
  assert.equal(payables.data.items.find((item) => item.id === draft.id).paymentStatus, 'paid');
  const history = await callApi({ path: paymentPath });
  assert.equal(history.status, 200);
  assert.equal(history.data.items.length, 2, 'payment history records each real settlement once');
  assert.deepEqual(history.data.items.map((item) => Number(item.amount)).sort((a, b) => a - b), [75, 125]);
  assert.ok(history.data.items.every((item) => item.paymentDate === '2026-09-27'),
    'payment history exposes the original local calendar day instead of a timezone-shifted JavaScript Date');
  const expenses = await setup.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, draft.id]);
  assert.equal(expenses.rows[0].count, 2, 'cashflow contains only two committed settlements');
  assert.equal(Number(expenses.rows[0].total), 200, 'settlements reconcile to receipt cost without duplicate retry or overpayment');

  const createPostedReceipt = async (documentNumber, lineCost) => {
    const receipt = await repository.saveDraft({
      venueId, supplierName: 'QA concurrency supplier', documentNumber,
      documentDate: '2026-09-27',
      lines: [{ ingredientId, quantity: 1, unit: 'bottle', unitCost: lineCost }],
    });
    assert.equal(receipt.status, 'draft');
    const result = await repository.post(venueId, receipt.id, null);
    assert.equal(result.document.status, 'posted');
    assert.equal(result.totalCost, lineCost);
    return receipt.id;
  };

  // Different keys race for the same final balance. The document row lock must
  // serialize the balance check so only one payment can commit.
  const competingDocumentId = await createPostedReceipt(`QA-RACE-${process.pid}`, 100);
  const competingPath = `/api/finance/purchase-payables/${competingDocumentId}/payments`;
  const competing = await Promise.all([
    callApi({ path: competingPath, method: 'POST', body: {
      amount: 100, paymentDate: '2026-09-27', paymentMethod: 'cash', idempotencyKey: `qa:race-a:${process.pid}`,
    } }),
    callApi({ path: competingPath, method: 'POST', body: {
      amount: 100, paymentDate: '2026-09-27', paymentMethod: 'card', idempotencyKey: `qa:race-b:${process.pid}`,
    } }),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort((a, b) => a - b), [201, 409],
    `exactly one distinct-key payment may consume the final balance: ${JSON.stringify(competing)}`);
  assert.equal(competing.filter((result) => result.status === 409 && result.data.error === 'purchase_payment_exceeds_balance').length, 1,
    'the competing payment must fail specifically because the balance was consumed');
  const competingTotals = await setup.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, competingDocumentId]);
  assert.equal(competingTotals.rows[0].count, 1, 'the final-balance race creates one cash movement');
  assert.equal(Number(competingTotals.rows[0].total), 100, 'concurrent payment attempts cannot overpay the posted receipt');
  const competingHistory = await callApi({ path: competingPath });
  assert.equal(competingHistory.status, 200);
  assert.equal(competingHistory.data.items.length, 1, 'history contains only the winning concurrent payment');

  // Identical concurrent retries share a key. They should both resolve as
  // success (created + idempotent replay) while persisting only one expense.
  const replayDocumentId = await createPostedReceipt(`QA-REPLAY-${process.pid}`, 100);
  const replayPath = `/api/finance/purchase-payables/${replayDocumentId}/payments`;
  const replayPayload = {
    amount: 40, paymentDate: '2026-09-27', paymentMethod: 'bank_transfer',
    idempotencyKey: `qa:parallel-replay:${process.pid}`,
  };
  const concurrentReplay = await Promise.all([
    callApi({ path: replayPath, method: 'POST', body: replayPayload }),
    callApi({ path: replayPath, method: 'POST', body: replayPayload }),
  ]);
  assert.deepEqual(concurrentReplay.map((result) => result.status).sort((a, b) => a - b), [200, 201],
    `identical concurrent retries both succeed as create/replay: ${JSON.stringify(concurrentReplay)}`);
  assert.equal(concurrentReplay.filter((result) => result.data.idempotent === true).length, 1,
    'exactly one concurrent retry reports an idempotent replay');
  const replayTotals = await setup.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, replayDocumentId]);
  assert.equal(replayTotals.rows[0].count, 1, 'parallel retry persists exactly one cash movement');
  assert.equal(Number(replayTotals.rows[0].total), 40, 'parallel retry does not double-count cash flow');
  const replayHistory = await callApi({ path: replayPath });
  assert.equal(replayHistory.status, 200);
  assert.equal(replayHistory.data.items.length, 1, 'parallel retry produces one history item');
  assert.equal(Number(replayHistory.data.items[0].amount), 40);

  console.log('PURCHASE PAYMENT POSTGRES API QA: PASS (real PostgreSQL nullable supplier dates + independent record timestamp; receipt → stock → payables; partial/full settlement; concurrent balance/idempotency checks)');
} finally {
  await pool.end();
  if (setup._connected) {
    if (venueId) {
      await setup.query('BEGIN');
      try {
        // The posted-receipt audit triggers intentionally prohibit deletion.
        // This is a disposable QA database and the venue is uniquely generated
        // by this test, so bypass user triggers only for this narrow cleanup tx.
        await setup.query('SET LOCAL session_replication_role = replica');
        await setup.query('DELETE FROM expenses WHERE venue_id=$1', [venueId]);
        await setup.query('DELETE FROM stock_movements WHERE venue_id=$1', [venueId]);
        await setup.query('DELETE FROM inventory_purchase_document_lines WHERE venue_id=$1', [venueId]);
        await setup.query('DELETE FROM inventory_purchase_documents WHERE venue_id=$1', [venueId]);
        await setup.query('DELETE FROM ingredients WHERE venue_id=$1', [venueId]);
        await setup.query('DELETE FROM venues WHERE id=$1', [venueId]);
        if (otherVenueId) await setup.query('DELETE FROM venues WHERE id=$1', [otherVenueId]);
        await setup.query('COMMIT');
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    await setup.end();
  }
}
