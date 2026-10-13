import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const qaTarget = validateQaDatabaseUrl(databaseUrl, 'Finance employee PostgreSQL QA URL');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const scrypt = promisify(scryptCallback);
const client = new Client({ connectionString: databaseUrl });
const venueId = randomUUID();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const otherVenueId = randomUUID();
const employeeId = randomUUID();
const coworkerId = randomUUID();
const login = 'finance-employee-qa-' + venueId;
const password = 'qa-' + randomUUID() + '-' + randomUUID();
const timezone = 'Pacific/Kiritimati';
const processTimezone = 'Etc/GMT+12';
let server;
let output = '';
let baseUrl = '';
let token = '';
let checks = 0;

const passwordSalt = randomBytes(16).toString('hex');
const passwordDerived = await scrypt(password, passwordSalt, 64);
const passwordHash = 'scrypt$' + passwordSalt + '$' + passwordDerived.toString('hex');

const request = async (route, options = {}) => {
  const method = options.method || 'GET';
  const body = options.body;
  const auth = options.auth === undefined ? token : options.auth;
  const response = await fetch(baseUrl + route, {
    method,
    headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
};

const deleteSyntheticRows = async () => {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM auth_sessions WHERE user_id IN ($1,$2)', [employeeId, coworkerId]);
    await client.query('DELETE FROM audit_events WHERE venue_id=ANY($1::uuid[])', [[venueId, otherVenueId]]);
    await client.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=ANY($1::uuid[]))', [[venueId, otherVenueId]]);
    await client.query('DELETE FROM orders WHERE venue_id=ANY($1::uuid[])', [[venueId, otherVenueId]]);
    await client.query('DELETE FROM users WHERE venue_id=$1', [venueId]);
    await client.query('DELETE FROM venues WHERE id=ANY($1::uuid[])', [[venueId, otherVenueId]]);
    await client.query('DELETE FROM organization_subscriptions WHERE organization_id=ANY($1::uuid[])', [[organizationId, otherOrganizationId]]);
    await client.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[organizationId, otherOrganizationId]]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
};

try {
  await client.connect();
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, qaTarget.database, 'connected test database matches the guarded loopback URL');
  await client.query('INSERT INTO organizations (id,name,slug,plan,is_active) VALUES ($1,$2,$3,$4,true)', [organizationId, 'QA Finance Organization', 'finance-qa-' + organizationId, 'network']);
  await client.query('INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,$2,$3,30,10)', [organizationId, 'network', 'active']);
  await client.query('INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,$3,$4)', [venueId, organizationId, 'QA finance ' + venueId, timezone]);
  await client.query('INSERT INTO users (id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes,is_active) VALUES ($1,$2,$11,$3,$4,$5,$6,$7::jsonb,true),($8,$2,$11,$9,$10,NULL,$6,$7::jsonb,true)',
    [employeeId, venueId, 'QA Finance Employee', login, passwordHash, 'bartender', '[]', coworkerId, 'QA Finance Coworker', login + '-coworker', organizationId]);
  await client.query('INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,$4,$5),($1,$3,$4,$5)', [organizationId, employeeId, coworkerId, 'member', 'active']);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl,
      VENUE_ID: venueId, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false',
      NODE_ENV: 'test', API_RATE_LIMIT: '5000', BUSINESS_TIMEZONE: processTimezone,
      PGOPTIONS: '-c timezone=UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

  const waitUntil = Date.now() + 20000;
  while (!baseUrl && Date.now() < waitUntil) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) baseUrl = 'http://127.0.0.1:' + match[1];
    else if (server.exitCode !== null) throw new Error('isolated AUTH_REQUIRED PostgreSQL API failed to start: ' + output);
    else await delay(50);
  }
  assert.ok(baseUrl, 'isolated API server starts: ' + output);

  const health = await request('/api/health', { auth: '' });
  assert.equal(health.status, 200);
  assert.equal(health.data.database, 'postgres', 'test uses real PostgreSQL repositories'); checks++;

  const loginResult = await request('/api/login', { method: 'POST', auth: '', body: { username: login, password } });
  assert.equal(loginResult.status, 200, 'synthetic bartender login succeeds: ' + JSON.stringify(loginResult.data));
  token = loginResult.data.token;
  assert.ok(token, 'login returns a persisted-session token');
  assert.ok(loginResult.data.permissions.includes('finance_read'));
  assert.ok(!loginResult.data.permissions.includes('finance'), 'employee cannot receive full finance permission'); checks += 3;

  const session = await request('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.user.id, employeeId, 'subsequent request resolves user through persistent auth_sessions');
  assert.equal(session.data.user.role, 'bartender'); checks += 2;
  assert.equal(session.data.user.organizationId, organizationId, 'persisted session remains in the synthetic organization');
  assert.equal(session.data.user.venueId, venueId, 'persisted session remains in the synthetic venue'); checks += 2;

  const businessDate = (await client.query('SELECT (now() AT TIME ZONE $1)::date::text AS date', [timezone])).rows[0].date;
  const previousDate = (await client.query('SELECT ($1::date - 1)::text AS date', [businessDate])).rows[0].date;
  const expectedRevenue = 150;
  const ownToday = (await client.query('INSERT INTO orders (venue_id,opened_by,status,closed_at) VALUES ($1,$2,$3,(($4::date::timestamp + INTERVAL \'12 hours\') AT TIME ZONE $5)) RETURNING id',
    [venueId, employeeId, 'closed', businessDate, timezone])).rows[0].id;
  await client.query('INSERT INTO payments (order_id,method,amount,status) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)',
    [ownToday, 'cash', 120, 'paid', 'card', 30, 'partially_paid']);
  const ownPrior = (await client.query('INSERT INTO orders (venue_id,opened_by,status,closed_at) VALUES ($1,$2,$3,(($4::date::timestamp + INTERVAL \'12 hours\') AT TIME ZONE $5)) RETURNING id',
    [venueId, employeeId, 'closed', previousDate, timezone])).rows[0].id;
  await client.query('INSERT INTO payments (order_id,method,amount,status,created_at) SELECT id,$2,$3,$4,closed_at FROM orders WHERE id=$1', [ownPrior, 'cash', 700, 'paid']);
  assert.equal((await client.query('SELECT (created_at AT TIME ZONE $2)::date::text AS date FROM payments WHERE order_id=$1', [ownPrior, timezone])).rows[0].date, previousDate, 'prior-day receipt itself is dated yesterday, not only its order closure'); checks++;
  const coworkerToday = (await client.query('INSERT INTO orders (venue_id,opened_by,status,closed_at) VALUES ($1,$2,$3,(($4::date::timestamp + INTERVAL \'12 hours\') AT TIME ZONE $5)) RETURNING id',
    [venueId, coworkerId, 'closed', businessDate, timezone])).rows[0].id;
  await client.query('INSERT INTO payments (order_id,method,amount,status) VALUES ($1,$2,$3,$4)', [coworkerToday, 'cash', 900, 'paid']);

  const forgedDate = '2000-01-01';
  const summary = await request('/api/finance/summary?date=' + forgedDate);
  assert.equal(summary.status, 200, 'employee finance summary works: ' + JSON.stringify(summary.data));
  assert.deepEqual(Object.keys(summary.data).sort(), ['date','employeeView','revenue'].sort(), 'summary exposes revenue only');
  assert.equal(summary.data.employeeView, true);
  assert.equal(summary.data.date, businessDate, 'summary ignores forged date and uses venue-local current date');
  assert.equal(summary.data.revenue, expectedRevenue, 'summary excludes coworker and prior-day sales'); checks += 5;

  const report = await request('/api/finance/report?date=' + forgedDate + '&type=waiter');
  assert.equal(report.status, 200, 'employee finance report works: ' + JSON.stringify(report.data));
  assert.deepEqual(Object.keys(report.data).sort(), ['type','date','generatedAt','reportNumber','checksCount','revenue','employeeView'].sort(),
    'report exposes no payment methods, staff, shift details or full report data');
  assert.equal(report.data.type, 'x', 'employee cannot request waiter/Z report variants');
  assert.equal(report.data.date, businessDate, 'report ignores forged date and uses venue-local current date');
  assert.equal(report.data.checksCount, 1);
  assert.equal(report.data.revenue, expectedRevenue, 'report is scoped to employee and current venue-local date'); checks += 6;

  const insertOrder = async (status, day = businessDate, scopedVenue = venueId) => (await client.query('INSERT INTO orders (venue_id,opened_by,status,closed_at) VALUES ($1,$2,$3::order_status,CASE WHEN $3::order_status=\'closed\' THEN (($4::date::timestamp + INTERVAL \'12 hours\') AT TIME ZONE $5) ELSE NULL END) RETURNING id', [scopedVenue, employeeId, status, day, timezone])).rows[0].id;
  const insertReceipt = (order, amount, day, status = 'paid', method = 'cash') => client.query('INSERT INTO payments (order_id,method,amount,status,created_at) VALUES ($1,$2,$3,$4,(($5::date::timestamp + INTERVAL \'12 hours\') AT TIME ZONE $6))', [order, method, amount, status, day, timezone]);
  const overnight = await insertOrder('closed');
  await insertReceipt(overnight, 40, previousDate);
  await insertReceipt(overnight, 60, businessDate, 'paid', 'qr');
  const stillOpen = await insertOrder('open');
  await insertReceipt(stillOpen, 20, businessDate, 'partially_paid');
  await insertOrder('closed'); // Receipt-free closed check counts as a check, never as invented revenue.
  const closedWithPriorReceipt = await insertOrder('closed');
  await insertReceipt(closedWithPriorReceipt, 30, previousDate);
  await client.query('INSERT INTO organizations (id,name,slug,plan) VALUES ($1,$2,$3,$4)', [otherOrganizationId, 'QA Foreign Finance Organization', 'foreign-finance-qa-' + otherOrganizationId, 'network']);
  await client.query('INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,$3,$4)', [otherVenueId, otherOrganizationId, 'QA foreign finance venue', timezone]);
  // Deliberately use the same actor in a foreign tenant fixture: actor filtering alone cannot protect this receipt.
  const foreignOrder = await insertOrder('closed', businessDate, otherVenueId);
  await insertReceipt(foreignOrder, 1000, businessDate);
  const enrichedRevenue = 150 + 60 + 20;
  const enrichedSummary = await request('/api/finance/summary?date=' + forgedDate);
  assert.equal(enrichedSummary.status, 200);
  assert.deepEqual(Object.keys(enrichedSummary.data).sort(), ['date','employeeView','revenue'].sort());
  assert.equal(enrichedSummary.data.date, businessDate);
  assert.equal(enrichedSummary.data.revenue, enrichedRevenue, 'summary counts only today own receipts, including partial/open/overnight, excluding other actor/tenant and prior receipts'); checks += 4;
  const dashboard = await request('/api/dashboard/shift-kpis?date=' + forgedDate + '&shiftId=forged-shift');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.date, businessDate);
  assert.equal(dashboard.data.employeeView, true);
  assert.equal(dashboard.data.selectedShiftId, null);
  assert.deepEqual(dashboard.data.shifts, [{ id:'employee-today' }]);
  assert.deepEqual(dashboard.data.totals, { revenue:enrichedRevenue,paymentCount:4,cash:140,cashless:90,other:0,closedOrders:4,depositTopUps:{ total:0,cash:0,cashless:0,count:0 },reservationPrepayments:{ total:0,cash:0,cashless:0,count:0 } }); checks += 8;
  const enrichedReport = await request('/api/finance/report?date=' + forgedDate + '&type=z');
  assert.equal(enrichedReport.status, 200);
  assert.deepEqual(Object.keys(enrichedReport.data).sort(), ['type','date','generatedAt','reportNumber','checksCount','revenue','employeeView'].sort(), 'report excludes all manager-only financial fields');
  assert.equal(enrichedReport.data.type, 'x');
  assert.equal(enrichedReport.data.date, businessDate);
  assert.equal(enrichedReport.data.employeeView, true);
  assert.equal(enrichedReport.data.revenue, enrichedSummary.data.revenue, 'report, summary and dashboard agree on current-day received payments');
  assert.equal(enrichedReport.data.revenue, dashboard.data.totals.revenue);
  assert.equal(enrichedReport.data.checksCount, dashboard.data.totals.closedOrders, 'closed checks are separate from receipts and include zero-receipt checks'); checks += 8;

  // The additive employee detail endpoint leaves the strict summary/report
  // payloads above intact, while using exactly the same receipt scope.
  const ownZone = (await client.query('INSERT INTO zones(venue_id,name) VALUES($1,$2) RETURNING id', [venueId,'QA employee hall'])).rows[0].id;
  const ownTable = (await client.query('INSERT INTO tables(zone_id,name) VALUES($1,$2) RETURNING id', [ownZone,'QA Стол 7'])).rows[0].id;
  const foreignZone = (await client.query('INSERT INTO zones(venue_id,name) VALUES($1,$2) RETURNING id', [otherVenueId,'QA foreign hall'])).rows[0].id;
  const foreignTable = (await client.query('INSERT INTO tables(zone_id,name) VALUES($1,$2) RETURNING id', [foreignZone,'PRIVATE FOREIGN TABLE'])).rows[0].id;
  await client.query('UPDATE orders SET table_id=$2 WHERE id=$1', [ownToday,ownTable]);
  // Deliberately malformed legacy linkage must never leak a foreign table name.
  await client.query('UPDATE orders SET table_id=$2 WHERE id=$1', [stillOpen,foreignTable]);
  const detailPath = '/api/finance/employee-payments?date=' + forgedDate + '&employeeId=' + coworkerId + '&venueId=' + otherVenueId;
  const details = await request(detailPath);
  assert.equal(details.status, 200);
  assert.deepEqual(Object.keys(details.data).sort(), ['employeeView','scope','date','timezone','generatedAt','revenue','paymentCount','byMethod','items','hasMore'].sort());
  assert.equal(details.data.employeeView, true);
  assert.equal(details.data.scope, 'opened_orders');
  assert.equal(details.data.date, businessDate);
  assert.equal(details.data.timezone, timezone);
  assert.ok(Number.isFinite(Date.parse(details.data.generatedAt)));
  assert.equal(details.data.revenue, enrichedSummary.data.revenue);
  assert.equal(details.data.paymentCount, 4);
  assert.equal(details.data.hasMore, false);
  assert.deepEqual(details.data.byMethod, [{method:'card',total:30,count:1},{method:'cash',total:140,count:2},{method:'qr',total:60,count:1}]);
  assert.equal(details.data.items.length, 4);
  assert.ok(details.data.items.filter((entry) => entry.orderId === ownToday).every((entry) => entry.tableName === 'QA Стол 7'), 'own-venue table labels are returned');
  assert.ok(details.data.items.filter((entry) => entry.orderId === stillOpen).every((entry) => entry.tableName === null), 'foreign table labels are redacted even for malformed legacy linkage'); checks += 2;
  assert.ok(details.data.items.every((entry) => [ownToday,overnight,stillOpen].includes(entry.orderId)), 'forged actor/venue parameters cannot widen receipt ownership');
  assert.ok(details.data.items.every((entry) => Object.keys(entry).sort().join(',') === ['id','orderId','tableName','method','amount','createdAt','partial'].sort().join(',')), 'receipt detail has an explicit privacy allowlist');
  assert.equal(details.data.items.filter((entry) => entry.partial === true).length, 2, 'only persisted partially_paid receipts are marked partial');
  assert.ok(details.data.items.filter((entry) => entry.partial !== true).every((entry) => entry.partial === null), 'historical settlement is unknown for paid receipts, never inferred from present order status');
  assert.equal((await request(detailPath, {auth:''})).status, 401); checks += 17;

  await insertReceipt(stillOpen, 500, businessDate, 'pending');
  await insertReceipt(stillOpen, 600, businessDate, 'refunded');
  await insertReceipt(stillOpen, 700, businessDate, 'paid', 'reservation');
  await insertReceipt(ownToday, 10, businessDate, 'paid', 'reservation');
  await insertReceipt(ownToday, 3, businessDate, 'paid', 'bonus');
  await insertReceipt(ownToday, 4, businessDate, 'paid', 'deposit');
  const tenders = (await request(detailPath)).data;
  assert.equal(tenders.revenue, enrichedRevenue + 17, 'pending/refunded/open reservation excluded; closed reservation and bonus/deposit retained');
  assert.equal(tenders.revenue, (await request('/api/finance/summary')).data.revenue, 'all supported tenders reconcile with existing employee summary');
  assert.equal(tenders.paymentCount, 7);
  assert.deepEqual(tenders.byMethod.map((entry) => entry.method), ['bonus','card','cash','deposit','qr','reservation']); checks += 4;

  for (let index = 0; index < 21; index++) await insertReceipt(stillOpen, index % 2 ? 0.1 : 0.2, businessDate);
  const paged = (await request(detailPath)).data;
  assert.equal(paged.paymentCount, 28);
  assert.equal(paged.items.length, 20);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.revenue, enrichedRevenue + 17 + 3.2, 'numeric aggregation preserves cents');
  assert.equal(paged.byMethod.reduce((sum, entry) => sum + Math.round(entry.total * 100), 0), Math.round(paged.revenue * 100));
  assert.equal(paged.byMethod.reduce((sum, entry) => sum + entry.count, 0), paged.paymentCount);
  assert.ok(paged.items.every((entry,index,list) => !index || Date.parse(list[index-1].createdAt) >= Date.parse(entry.createdAt)), 'recent payments ordered newest first');
  assert.deepEqual((await request(detailPath)).data.items, paged.items, 'deterministic ID tie-breaker stabilizes repeated reads'); checks += 8;

  await client.query("UPDATE users SET role='manager' WHERE id=$1", [employeeId]);
  assert.equal((await request(detailPath)).status, 403, 'manager cannot use employee detail route');
  await client.query("UPDATE users SET role='bartender',permission_scopes='[\"orders\"]'::jsonb WHERE id=$1", [employeeId]);
  assert.equal((await request(detailPath)).status, 403, 'employee without finance permission cannot read payments');
  await client.query("UPDATE users SET permission_scopes='[]'::jsonb WHERE id=$1", [employeeId]); checks += 2;
  await client.query('UPDATE orders SET opened_by=$2 WHERE venue_id=$1', [venueId,coworkerId]);
  const emptyDetails = await request(detailPath);
  assert.equal(emptyDetails.status, 200);
  assert.equal(emptyDetails.data.revenue, 0);
  assert.equal(emptyDetails.data.paymentCount, 0);
  assert.deepEqual(emptyDetails.data.byMethod, []);
  assert.deepEqual(emptyDetails.data.items, []);
  assert.equal(emptyDetails.data.hasMore, false); checks += 6;

  console.log('FINANCE EMPLOYEE POSTGRES QA: PASS (' + checks + ' checks; persisted login/session; venue-local date; forged date ignored; employee-only revenue summary and X report)');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve)).catch(() => {});
  }
  // Fresh owned database launchers remove the whole disposable database.
  // Immutable financial policies cannot be deleted as row-level fixture cleanup.
  const disposableDatabase = process.env.FINANCE_EMPLOYEE_QA_OWNED_DATABASE;
  if (disposableDatabase) assert.equal(disposableDatabase, qaTarget.database, 'cleanup marker must identify the exact guarded disposable database');
  if (client._connected && !disposableDatabase) await deleteSyntheticRows();
  await client.end().catch(() => {});
}
