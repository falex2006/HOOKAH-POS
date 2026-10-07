import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid);
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);

const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID() };
const marker = randomBytes(4).toString('hex');
const ownerLogin = `qa22-owner-${marker}`;
const ownerPassword = `qa22-${randomUUID()}`;
const hashPassword = () => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(ownerPassword, salt, 64).toString('hex')}`;
};
let server;
let serverExit;
let serverOutput = '';
let connected = false;
let base = '';
let token = '';
let checks = 0;

const check = (condition, message) => { assert.ok(condition, message); checks++; };
const venueDate = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const api = async (route, method = 'GET', body, expected = 200) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': ids.organization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  checks++;
  return payload;
};

try {
  await db.connect();
  connected = true;
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #22 disposable PostgreSQL');

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA22 purchase fields', `qa22-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, `QA22 Venue ${marker}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA22 synthetic owner',$4,$5,'owner','[]'::jsonb)", [ids.owner, ids.organization, ids.venue, ownerLogin, hashPassword()]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href,
      VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise(resolve => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${serverOutput}`);
    else await delay(50);
  }
  check(Boolean(base), `authenticated API server starts on a free local port: ${serverOutput}`);
  const health = await api('/api/health');
  check(health.database === 'postgres', 'acceptance #22 uses PostgreSQL');
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization },
    body: JSON.stringify({ username: ownerLogin, password: ownerPassword }),
  });
  assert.equal(loginResponse.status, 200, 'synthetic owner signs in through the authenticated login endpoint'); checks++;
  token = (await loginResponse.json()).token;
  check(Boolean(token), 'login returns an authenticated token');

  const units = [
    { unit: 'г', quantity: 1, unitCost: 1.005, lineTotal: 1.01 },
    { unit: 'кг', quantity: 2, unitCost: 0.3333, lineTotal: 0.67 },
    { unit: 'мл', quantity: 0.5, unitCost: 0.335, lineTotal: 0.17 },
    { unit: 'л', quantity: 1.25, unitCost: 8.012, lineTotal: 10.02 },
    { unit: 'шт', quantity: 3, unitCost: 0.01, lineTotal: 0.03 },
    { unit: 'порция', quantity: 1, unitCost: 0, lineTotal: 0 },
    { unit: 'уп', quantity: 2, unitCost: 0.005, lineTotal: 0.01 },
    { unit: 'упаковка', quantity: 0.125, unitCost: 2.4, lineTotal: 0.3 },
  ];
  const items = [];
  for (const entry of units) {
    items.push(await api('/api/inventory/items', 'POST', {
      name: `QA22 ${entry.unit} ${marker}`, department: 'bar', itemType: 'ingredient', unit: entry.unit, cost: 7.25,
    }, 201));
  }
  const inventoryBefore = (await api('/api/inventory')).items;
  const payablesBefore = await api('/api/finance/purchase-payables');
  const draftInput = {
    supplierName: `Синтетический поставщик ${marker}`,
    documentNumber: `QA22-${marker}`,
    documentDate: '2026-10-04',
    note: `QA22 draft snapshot ${marker}`,
    lines: units.map((entry, index) => ({ ingredientId: items[index].id, quantity: entry.quantity, unit: entry.unit, unitCost: entry.unitCost })),
  };
  const draft = await api('/api/inventory/purchase-documents', 'POST', draftInput, 201);
  check(draft.status === 'draft' && draft.supplierName === draftInput.supplierName && draft.documentNumber === draftInput.documentNumber
    && venueDate(draft.documentDate) === draftInput.documentDate && draft.note === draftInput.note,
  `draft preserves supplier, invoice number/date, note and lifecycle status: ${JSON.stringify({ status: draft.status, supplierName: draft.supplierName, documentNumber: draft.documentNumber, documentDate: draft.documentDate, note: draft.note })}`);
  check(draft.lines.length === units.length, 'draft accepts every supported inventory purchase unit');
  check(Math.round(Number(draft.totalCost) * 100) === 1221, 'document total sums cent-rounded line amounts to 12.21');

  const lineByItem = new Map(draft.lines.map(line => [line.ingredientId, line]));
  for (const [index, expected] of units.entries()) {
    const line = lineByItem.get(items[index].id);
    assert.ok(line, `draft contains line for ${expected.unit}`); checks++;
    assert.equal(Number(line.quantity), expected.quantity, `${expected.unit} quantity survives API mapping`); checks++;
    assert.equal(line.unit, expected.unit, `${expected.unit} purchase unit survives API mapping`); checks++;
    assert.equal(Number(line.unitCost), expected.unitCost, `${expected.unit} unit price survives API mapping`); checks++;
    assert.equal(Number(line.stockQuantity), expected.quantity, `${expected.unit} quantity maps to the base stock unit`); checks++;
    assert.equal(Number(line.packMultiplier), 1, `${expected.unit} direct purchase retains its unit factor`); checks++;
    assert.equal(Number(line.receiptUnitCost), expected.unitCost, `${expected.unit} normalized cost snapshot survives API mapping`); checks++;
    assert.equal(Number(line.lineTotal), expected.lineTotal, `${expected.unit} line total uses decimal HALF_UP rounding`); checks++;
  }
  check(Number(lineByItem.get(items[0].id).lineTotal) === 1.01, 'binary-float half-cent boundary 1.005 rounds up to 1.01');

  const readBack = await api(`/api/inventory/purchase-documents/${draft.id}`);
  check(readBack.supplierName === draftInput.supplierName && readBack.documentNumber === draftInput.documentNumber
    && venueDate(readBack.documentDate) === draftInput.documentDate && readBack.note === draftInput.note
    && Number(readBack.totalCost) === 12.21, 'fresh detail read returns persisted header and total');
  const listed = await api('/api/inventory/purchase-documents?status=draft');
  const listedDraft = listed.items.find(document => document.id === draft.id);
  check(Boolean(listedDraft) && listedDraft.documentNumber === draftInput.documentNumber && Number(listedDraft.totalCost) === 12.21,
    'fresh list read returns the saved draft and total');
  check(Boolean(listedDraft) && venueDate(listedDraft.documentDate) === draftInput.documentDate,
    'fresh list read returns the venue-local document date');
  for (const expected of units) {
    const itemId = items[units.indexOf(expected)].id;
    const line = readBack.lines.find(candidate => candidate.ingredientId === itemId);
    check(Boolean(line) && Number(line.lineTotal) === expected.lineTotal, `fresh detail read retains ${expected.unit} line amount`);
  }

  const pgRows = await db.query(`SELECT d.supplier_name,d.document_number,d.document_date::text,d.note,d.status,
      l.quantity::text AS quantity,l.unit,l.pack_multiplier::text AS pack_multiplier,l.unit_cost::text AS unit_cost,l.receipt_unit_cost::text AS receipt_unit_cost,
      l.line_total::text AS line_total,l.stock_quantity::text AS stock_quantity,l.source_movement_id,
      (SELECT count(*)::int FROM stock_movements m WHERE m.venue_id=l.venue_id AND m.ingredient_id=l.ingredient_id) AS movement_count
    FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
    WHERE d.id=$1 AND d.venue_id=$2`, [draft.id, ids.venue]);
  check(pgRows.rowCount === units.length, 'all supported unit lines persist in the venue-scoped database');
  check(pgRows.rows.every(row => row.status === 'draft' && row.supplier_name === draftInput.supplierName
    && row.document_number === draftInput.documentNumber && row.document_date === draftInput.documentDate && row.note === draftInput.note),
  'database header snapshot matches the submitted draft');
  for (const [index, expected] of units.entries()) {
    const row = pgRows.rows.find(candidate => candidate.unit === expected.unit && Number(candidate.quantity) === expected.quantity);
    check(Boolean(row) && Number(row.unit_cost) === expected.unitCost && Number(row.receipt_unit_cost) === expected.unitCost
      && Number(row.pack_multiplier) === 1 && Number(row.line_total) === expected.lineTotal,
      `${expected.unit} quantity, unit/factor snapshots, and rounded total match PostgreSQL numeric values`);
    check(Boolean(row) && row.source_movement_id === null && row.movement_count === 0,
      `${expected.unit} draft has no linked or actual stock movement`);
  }
  check(Math.round(pgRows.rows.reduce((sum, row) => sum + Number(row.line_total), 0) * 100) === 1221,
    'PostgreSQL line totals independently sum to 12.21');

  const inventoryAfter = (await api('/api/inventory')).items;
  for (const created of items) {
    const before = inventoryBefore.find(entry => entry.id === created.id);
    const after = inventoryAfter.find(entry => entry.id === created.id);
    check(Number(before?.onHand || 0) === Number(after?.onHand || 0) && Number(before?.cost || 0) === Number(after?.cost || 0),
      'saving a draft leaves inventory balance and valuation unchanged');
  }
  const payablesAfter = await api('/api/finance/purchase-payables');
  check(JSON.stringify(payablesAfter.items || payablesAfter) === JSON.stringify(payablesBefore.items || payablesBefore),
    'saving a draft leaves supplier liabilities unchanged');

  const documentCountBeforeInvalid = (await db.query('SELECT count(*)::int AS count FROM inventory_purchase_documents WHERE venue_id=$1', [ids.venue])).rows[0].count;
  const overPrecision = await api('/api/inventory/purchase-documents', 'POST', {
    supplierName: `QA22 invalid precision ${marker}`, lines: [{ ingredientId: items[0].id, quantity: 1, unit: 'г', unitCost: 1.00001 }],
  }, 400);
  check(overPrecision.error === 'invalid_purchase_line', 'price precision beyond the stored four decimal places is rejected');
  const documentCountAfterInvalid = (await db.query('SELECT count(*)::int AS count FROM inventory_purchase_documents WHERE venue_id=$1', [ids.venue])).rows[0].count;
  check(documentCountAfterInvalid === documentCountBeforeInvalid, 'invalid precision leaves no partial purchase document');
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    if (serverExit) await Promise.race([serverExit, delay(5000)]);
  }
  if (connected) await db.end();
}

console.log(`ACCEPTANCE #22 PURCHASE FIELDS POSTGRES QA: PASS (${checks} checks; authenticated API→PostgreSQL→fresh detail/list, all supported units, exact decimal totals, draft stock/payable isolation; disposable DB owned by runner)`);
