import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { handleFinanceFundingRoute } = require('../finance-funding.js');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaName = `finance_funding_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let pool;
let created = false;

async function insert(client, table, row) {
  const fields = Object.keys(row); const values = fields.map((field) => row[field]);
  return (await client.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`, values)).rows[0].id;
}
async function call({ method = 'POST', path: routePath = '/api/finance/funding-documents', venueId, userId, body = {}, permissions = ['finance'] }) {
  const result = {};
  const handled = await handleFinanceFundingRoute({
    req: { method, user: { id: userId, role: 'owner' } }, res: result,
    url: new URL(routePath, 'http://localhost'), pool, venueId,
    json: (_res, status, payload) => Object.assign(result, { status, payload }),
    readBody: async () => body, hasPermission: (permission) => permissions.includes(permission), recordAudit: () => {},
  });
  assert.notEqual(handled, false, 'funding route handles the requested API path');
  return result;
}
const key = () => crypto.randomUUID();

try {
  await admin.connect();
  const identity = (await admin.query(`SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await admin.query(`CREATE SCHEMA ${schemaName}`); created = true;
  await admin.query(`SET search_path TO ${schemaName}`);
  await admin.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const migration = readFileSync(path.join(root, 'migrations/138_finance_funding_events.sql'), 'utf8');
  await admin.query(migration); await admin.query(migration);
  pool = new Pool({ connectionString: scopedUrl.href, max: 8 });

  const venueId = await insert(admin, 'venues', { name: 'Finance funding QA', timezone: 'Asia/Yekaterinburg' });
  const userId = await insert(admin, 'users', { venue_id: venueId, full_name: 'QA owner', login: `${schemaName}-owner`, role: 'owner' });
  const otherVenue = await insert(admin, 'venues', { name: 'Other funding QA' });
  const bankId = await insert(admin, 'finance_accounts', { venue_id: venueId, code: 'funding_qa_bank', name: 'QA банк', kind: 'bank', allowed_payment_methods: ['bank_transfer'], created_by: userId });
  const today = (await admin.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const document = (documentType, principalLimit = null, idempotencyKey = key()) => ({ documentType, counterpartyName: documentType === 'loan' ? 'Кредитор QA' : 'Владелец QA', basis: 'Тестовый документ', documentReference: 'QA-1', principalLimit, idempotencyKey });
  const postEvent = (id, eventType, amount, idempotencyKey = key(), financeAccountId = bankId, eventDate = today) => call({ venueId, userId, path: `/api/finance/funding-documents/${id}/events`, body: { eventType, amount, eventDate, financeAccountId, paymentMethod: financeAccountId === bankId ? 'bank_transfer' : 'cash', note: '', idempotencyKey } });

  const docKey = key();
  let result = await call({ venueId, userId, permissions: ['finance_read'], body: document('loan', '100.00', docKey) });
  assert.equal(result.status, 403, 'finance_read cannot create a funding document');
  result = await call({ venueId, userId, body: document('loan', '100.00', docKey) });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  const loanId = result.payload.id;
  assert.equal(result.payload.status, 'draft');
  assert.equal((await call({ venueId, userId, body: document('loan', '100.00', docKey) })).status, 200, 'document create is idempotent');
  assert.equal((await call({ venueId, userId, body: document('loan', '101.00', docKey) })).status, 409, 'document key cannot be reused with changed data');
  assert.equal((await call({ method: 'GET', venueId, userId, path: `/api/finance/funding-documents/${loanId}`, permissions: ['finance_read'] })).status, 200);
  assert.equal((await call({ method: 'GET', venueId: otherVenue, userId, path: `/api/finance/funding-documents/${loanId}`, permissions: ['finance_read'] })).status, 404, 'document ID is tenant-scoped');

  const prematureRepayment = await postEvent(loanId, 'loan_principal_repaid', '1.00');
  assert.equal(prematureRepayment.status, 409, 'repayment before receipt is rejected');
  const drawKey = key();
  result = await postEvent(loanId, 'loan_principal_received', '80.00', drawKey);
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.status, 'active', 'first event activates the document');
  assert.equal(result.payload.principalOutstanding, '80.00');
  assert.equal((await postEvent(loanId, 'loan_principal_received', '80.00', drawKey)).status, 200, 'event replay returns the original fact');
  assert.equal((await postEvent(loanId, 'loan_principal_received', '79.00', drawKey)).status, 409, 'event key cannot be reused with changed data');
  assert.equal((await postEvent(loanId, 'loan_principal_received', '30.00')).status, 409, 'principal draw cannot exceed the document limit');
  result = await postEvent(loanId, 'loan_principal_repaid', '25.00');
  assert.equal(result.status, 201); assert.equal(result.payload.principalOutstanding, '55.00');
  assert.equal((await postEvent(loanId, 'loan_principal_repaid', '56.00')).status, 409, 'repayment cannot exceed received principal');
  const races = await Promise.all([postEvent(loanId, 'loan_principal_received', '15.00'), postEvent(loanId, 'loan_principal_received', '15.00')]);
  assert.deepEqual(races.map((item) => item.status).sort(), [201, 409], 'document lock serializes concurrent principal cap checks');
  const totals = (await call({ method: 'GET', venueId, userId, path: `/api/finance/funding-documents/${loanId}`, permissions: ['finance_read'] })).payload;
  assert.equal(totals.receivedAmount, '95.00'); assert.equal(totals.repaidAmount, '25.00'); assert.equal(totals.principalOutstanding, '70.00');
  assert.equal((await call({ method: 'PATCH', venueId, userId, path: `/api/finance/funding-documents/${loanId}`, body: { basis: 'Попытка переписать' } })).status, 409, 'document is immutable after its first event');
  await assert.rejects(() => admin.query('UPDATE finance_funding_events SET note=$1 WHERE venue_id=$2', ['rewrite', venueId]), /finance_funding_events_append_only/);
  await assert.rejects(() => admin.query('DELETE FROM finance_funding_events WHERE venue_id=$1', [venueId]), /finance_funding_events_append_only/);

  const contribution = await call({ venueId, userId, body: document('owner_contribution') });
  assert.equal(contribution.status, 201);
  const editedContribution = await call({ venueId, userId, method: 'PATCH', path: `/api/finance/funding-documents/${contribution.payload.id}`, body: { counterpartyName: 'Владелец QA обновлён', basis: 'Уточнённое основание', documentReference: 'QA-2' } });
  assert.equal(editedContribution.status, 200, 'an unposted draft can be edited');
  assert.equal(editedContribution.payload.basis, 'Уточнённое основание');
  assert.equal((await postEvent(contribution.payload.id, 'owner_contribution_received', '500.00')).status, 201);
  const contributionState = (await call({ method: 'GET', venueId, userId, path: `/api/finance/funding-documents/${contribution.payload.id}`, permissions: ['finance_read'] })).payload;
  assert.equal(contributionState.receivedAmount, '500.00'); assert.equal(contributionState.principalOutstanding, '0.00');

  const posAccount = (await admin.query("SELECT id,name FROM finance_accounts WHERE venue_id=$1 AND kind='pos_cashbox' AND active", [venueId])).rows[0];
  const shiftId = await insert(admin, 'shifts', { venue_id: venueId, opened_by: userId, opening_cash: '0' });
  const cashDoc = await call({ venueId, userId, body: document('owner_contribution') });
  assert.equal(cashDoc.status, 201);
  result = await postEvent(cashDoc.payload.id, 'owner_contribution_received', '12.50', key(), posAccount.id);
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.events.at(-1).shiftId, shiftId, 'POS cash contribution is bound to the one open shift');
  assert.equal((await postEvent(cashDoc.payload.id, 'owner_contribution_received', '12.50', key(), posAccount.id, '2000-01-01')).status, 409, 'POS cash events must use the current local date');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.includes("e.event_type IN ('owner_contribution_received','loan_principal_received')") && server.includes("'owner_contribution',e.id,NULL,'receipt'") && server.includes("'loan_principal_repaid',e.id,NULL,'payout'"), 'POS funding events feed expected cash and close ledger');
  const report = readFileSync(path.join(root, 'finance-unified-report.js'), 'utf8');
  assert.ok(report.includes('financingEvents') && report.includes("'none'::text AS \"pnlEffect\"") && report.includes("source==='funding'&&name==='financing'"), 'funding is reported as external cash flow outside P&L');

  console.log('FINANCE FUNDING POSTGRES QA: PASS (migration replay, tenant isolation, permissions, idempotency, concurrent loan cap, repayment cap, append-only DB guards, contribution, POS shift/date binding, close ledger and P&L separation)');
} finally {
  await pool?.end();
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
