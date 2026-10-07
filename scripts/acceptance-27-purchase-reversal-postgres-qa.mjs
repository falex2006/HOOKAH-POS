import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), staff: randomUUID(), foreignOrganization: randomUUID(), foreignVenue: randomUUID(), foreignOwner: randomUUID() };
const label = randomUUID().slice(0, 8), ownerLogin = `qa27-owner-${label}`, staffLogin = `qa27-staff-${label}`, foreignLogin = `qa27-foreign-${label}`;
const ownerPassword = `qa27-${randomUUID()}`, staffPassword = `qa27-${randomUUID()}`, foreignPassword = `qa27-${randomUUID()}`;
const hash = (value) => { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`; };
let server, output = '', base = '', ownerToken = '', staffToken = '', foreignToken = '', assertions = 0, passed = false;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const api = async (route, method = 'GET', body, token = ownerToken, organization = ids.organization, expected = 200) => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(organization ? { 'X-Organization-Id': organization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`); assertions++;
  return payload;
};
const login = async (username, password, organization) => {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organization }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200); assertions++; return (await response.json()).token;
};
const waitForServer = async () => {
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) base = `http://127.0.0.1:${match[1]}`; else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`); else await delay(50); }
  assert.ok(base, `QA server starts: ${output}`);
};
const item = async (name) => api('/api/inventory/items', 'POST', { name: `QA27 ${name} ${label}`, department: 'bar', unit: 'мл', itemType: 'ingredient', cost: 0.5 }, ownerToken, ids.organization, 201);
const draft = async (ingredient, number, sourceAutoOrderId = null, quantity = 100) => api('/api/inventory/purchase-documents', 'POST', { supplierName: 'Synthetic supplier', documentNumber: `QA27-${label}-${number}`, sourceAutoOrderId, lines: [{ ingredientId: ingredient.id, quantity, unit: 'мл', unitCost: 0.8 }] }, ownerToken, ids.organization, 201);
const movements = async (ingredientId) => Number((await db.query('SELECT count(*)::int AS n FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2', [ids.venue, ingredientId])).rows[0].n);

try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #27 disposable PostgreSQL');
  await db.query(fs.readFileSync(path.join(root, 'migrations', '097_purchase_document_reversals.sql'), 'utf8'));
  assertions++;
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.organization, 'QA27 reversal', `qa27-${ids.organization}`, 'Asia/Yekaterinburg', ids.foreignOrganization, 'QA27 foreign', `qa27-foreign-${ids.foreignOrganization}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [ids.organization, ids.foreignOrganization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.venue, ids.organization, 'QA27 venue', 'Asia/Yekaterinburg', ids.foreignVenue, ids.foreignOrganization, 'QA27 foreign venue']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,pin_hash,pin_updated_at,role,permission_scopes) VALUES
      ($1,$2,$3,'QA27 owner',$4,$5,$6,now(),'owner','[]'::jsonb),($7,$2,$3,'QA27 inventory staff',$8,$9,$10,now(),'bartender','["inventory"]'::jsonb),($11,$12,$13,'QA27 foreign owner',$14,$15,NULL,NULL,'owner','[]'::jsonb)`,
    [ids.owner, ids.organization, ids.venue, ownerLogin, hash(ownerPassword), hash('2719'), ids.staff, staffLogin, hash(staffPassword), hash('2719'), ids.foreignOwner, ids.foreignOrganization, ids.foreignVenue, foreignLogin, hash(foreignPassword)]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active'),($4,$5,'owner','active')", [ids.organization, ids.owner, ids.staff, ids.foreignOrganization, ids.foreignOwner]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар'),($2,'bar','Бар') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue, ids.foreignVenue]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  await waitForServer();
  ownerToken = await login(ownerLogin, ownerPassword, ids.organization); staffToken = await login(staffLogin, staffPassword, ids.organization); foreignToken = await login(foreignLogin, foreignPassword, ids.foreignOrganization);
  await api('/api/session/unlock', 'POST', { pin: '2719' }, ownerToken);
  await api('/api/session/unlock', 'POST', { pin: '2719' }, staffToken);
  await api('/api/shifts', 'POST', { openingCash: 0 }, ownerToken, ids.organization, 201);

  const initialPolicy = await api('/api/venue/purchase-reversal-policy');
  check(initialPolicy.mode === 'safe_full_unpaid_unused' && initialPolicy.enabled === true && initialPolicy.version === 1, 'venue begins with explicit safe v1 policy');
  const successfulItem = await item('safe reversal'); const successfulDraft = await draft(successfulItem, 'safe');
  const posted = await api(`/api/inventory/purchase-documents/${successfulDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  check(posted.document.reversalPolicyVersion === 1 && posted.document.reversalPolicyEnabled === true, 'posting captures exact venue policy version');
  check(Number((await api('/api/inventory')).items.find(row => row.id === successfulItem.id).onHand) === 100, 'posted receipt increases stock');
  await api('/api/venue/purchase-reversal-policy', 'PATCH', { expectedVersion: 1, enabled: false });
  const staffDenied = await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'No dual permission', idempotencyKey: randomUUID() }, staffToken, ids.organization, 403);
  check(staffDenied.error === 'purchase_document_reversal_permission_required', 'inventory-only staff cannot reverse without finance permission');
  const absent = await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'Foreign tenant', idempotencyKey: randomUUID() }, foreignToken, ids.foreignOrganization, 404);
  check(absent.error === 'purchase_document_not_found', 'foreign tenant cannot discover or reverse source receipt');

  const reversalKey = randomUUID();
  const reversal = await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'Duplicate supplier receipt', idempotencyKey: reversalKey });
  check(reversal.idempotent === false && reversal.reversal.policyVersion === 1, 'historic receipt uses its posting-time policy despite later setting change');
  check((await api('/api/inventory')).items.find(row => row.id === successfulItem.id).onHand === 0, 'reversal returns stock to exact original balance');
  const replay = await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'Duplicate supplier receipt', idempotencyKey: reversalKey });
  check(replay.idempotent === true && replay.reversal.id === reversal.reversal.id, 'same idempotency key and payload replays original result');
  await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'Different reason', idempotencyKey: reversalKey }, ownerToken, ids.organization, 409);
  await api(`/api/inventory/purchase-documents/${successfulDraft.id}/reverse`, 'POST', { reason: 'Second reversal', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  const immutableFacts = await db.query(`SELECT d.status,l.source_movement_id,i.cost,(SELECT count(*)::int FROM stock_movements m WHERE m.venue_id=d.venue_id AND m.ingredient_id=i.id) AS movement_count,(SELECT count(*)::int FROM inventory_purchase_reversals r WHERE r.source_document_id=d.id) AS reversal_count,(SELECT count(*)::int FROM audit_events a WHERE a.entity_id=$2 AND a.action='inventory.purchase_document_reversed') AS audit_count FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id JOIN ingredients i ON i.id=l.ingredient_id WHERE d.id=$1 AND d.venue_id=$3`, [successfulDraft.id, reversal.reversal.id, ids.venue]);
  check(immutableFacts.rows[0].status === 'posted' && immutableFacts.rows[0].movement_count === 2 && immutableFacts.rows[0].reversal_count === 1 && immutableFacts.rows[0].audit_count === 1, 'reversal appends movement and audit while source remains posted and immutable');
  check(Number(immutableFacts.rows[0].cost) === 0.5, 'stock valuation returns exactly to its pre-receipt value');

  const disabledItem = await item('disabled policy'); const disabledDraft = await draft(disabledItem, 'disabled');
  const disabledPost = await api(`/api/inventory/purchase-documents/${disabledDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  check(disabledPost.document.reversalPolicyEnabled === false && disabledPost.document.reversalPolicyVersion === 2, 'changed policy applies prospectively to new receipts');
  const policyBlocked = await api(`/api/inventory/purchase-documents/${disabledDraft.id}/reverse`, 'POST', { reason: 'Policy disabled', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(policyBlocked.error === 'purchase_document_reversal_policy_unavailable', 'disabled posting-time policy blocks reversal');

  await api('/api/venue/purchase-reversal-policy', 'PATCH', { expectedVersion: 2, enabled: true });
  const usedItem = await item('used stock'); const usedDraft = await draft(usedItem, 'used');
  await api(`/api/inventory/purchase-documents/${usedDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  await api('/api/inventory/movements', 'POST', { itemId: usedItem.id, delta: -1, unit: 'мл', reason: 'synthetic usage' }, ownerToken, ids.organization, 201);
  const usedBefore = await movements(usedItem.id);
  const usedFailure = await api(`/api/inventory/purchase-documents/${usedDraft.id}/reverse`, 'POST', { reason: 'Used stock', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(usedFailure.error === 'purchase_document_reversal_stock_changed' && await movements(usedItem.id) === usedBefore, 'any later stock movement fails closed without partial writes');

  const paidItem = await item('paid receipt'); const paidDraft = await draft(paidItem, 'paid');
  await api(`/api/inventory/purchase-documents/${paidDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  await db.query("INSERT INTO expenses(venue_id,category,amount,expense_date,description,source,created_by,purchase_document_id,idempotency_key,payment_method) VALUES($1,'Закупка',1,CURRENT_DATE,'synthetic payment','purchase',$2,$3,$4,'cash')", [ids.venue, ids.owner, paidDraft.id, randomUUID()]);
  const paidFailure = await api(`/api/inventory/purchase-documents/${paidDraft.id}/reverse`, 'POST', { reason: 'Already paid', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(paidFailure.error === 'purchase_document_reversal_paid', 'partially paid receipt is rejected');

  const autoItem = await item('linked auto-order');
  const autoOrder = await api('/api/inventory/auto-orders', 'POST', { items: [{ itemId: autoItem.id, quantity: 200 }] }, ownerToken, ids.organization, 201);
  const linkedDraft = await draft(autoItem, 'linked-order', autoOrder.id, 100);
  await api(`/api/inventory/purchase-documents/${linkedDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  const linkedAfterPost = (await api('/api/inventory/auto-orders')).requests.find(row => row.id === autoOrder.id);
  check(linkedAfterPost.status === 'partially_received' && Number(linkedAfterPost.lines[0].receivedQuantity) === 100, 'linked receipt advances the auto-order snapshot');
  const remainingDraft = await draft(autoItem, 'linked-remainder', autoOrder.id, 100);
  const beforeLinkedReversalMovements = await movements(autoItem.id);
  const draftBlocks = await api(`/api/inventory/purchase-documents/${linkedDraft.id}/reverse`, 'POST', { reason: 'Open linked draft', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(draftBlocks.error === 'purchase_document_reversal_auto_order_changed' && await movements(autoItem.id) === beforeLinkedReversalMovements, 'another linked draft blocks reversal without changing stock');
  await api(`/api/inventory/purchase-documents/${remainingDraft.id}/void`, 'POST', undefined, ownerToken, ids.organization);
  await db.query("UPDATE inventory_auto_orders SET lines=jsonb_set(lines,'{0,testMarker}','\"changed\"'::jsonb) WHERE id=$1 AND venue_id=$2", [autoOrder.id, ids.venue]);
  const changedOrder = await api(`/api/inventory/purchase-documents/${linkedDraft.id}/reverse`, 'POST', { reason: 'Changed auto-order', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(changedOrder.error === 'purchase_document_reversal_auto_order_changed', 'changed linked auto-order snapshot blocks reversal');
  const orderSnapshots = await db.query('SELECT source_auto_order_status_before AS status,source_auto_order_lines_before AS lines FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [linkedDraft.id, ids.venue]);
  await db.query('UPDATE inventory_auto_orders SET status=$1,lines=$2::jsonb WHERE id=$3 AND venue_id=$4', [linkedAfterPost.status, JSON.stringify(linkedAfterPost.lines), autoOrder.id, ids.venue]);
  const linkedReversal = await api(`/api/inventory/purchase-documents/${linkedDraft.id}/reverse`, 'POST', { reason: 'Exact auto-order restore', idempotencyKey: randomUUID() }, ownerToken, ids.organization);
  check(linkedReversal.idempotent === false, 'linked receipt reverses when the after-snapshot matches exactly');
  const restoredOrder = (await api('/api/inventory/auto-orders')).requests.find(row => row.id === autoOrder.id);
  check(restoredOrder.status === orderSnapshots.rows[0].status && JSON.stringify(restoredOrder.lines) === JSON.stringify(orderSnapshots.rows[0].lines), 'reversal restores the exact auto-order status and lines from before posting');

  const rollbackItem = await item('audit rollback'); const rollbackDraft = await draft(rollbackItem, 'rollback');
  await api(`/api/inventory/purchase-documents/${rollbackDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  await db.query(`CREATE OR REPLACE FUNCTION qa27_fail_reversal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='inventory.purchase_document_reversed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER qa27_fail_reversal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa27_fail_reversal_audit()`);
  try {
    await api(`/api/inventory/purchase-documents/${rollbackDraft.id}/reverse`, 'POST', { reason: 'Audit failure rollback', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 503);
  } finally { await db.query('DROP TRIGGER IF EXISTS qa27_fail_reversal_audit ON audit_events'); await db.query('DROP FUNCTION IF EXISTS qa27_fail_reversal_audit()'); }
  check(await movements(rollbackItem.id) === 1 && Number((await api('/api/inventory')).items.find(row => row.id === rollbackItem.id).onHand) === 100, 'audit failure rolls back reversal ledger and stock movement atomically');

  const closedItem = await item('closed shift'); const closedDraft = await draft(closedItem, 'closed');
  await api(`/api/inventory/purchase-documents/${closedDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);

  const legacyItem = await item('legacy unlinked payment'); const legacyDraft = await draft(legacyItem, 'legacy-unlinked');
  await api(`/api/inventory/purchase-documents/${legacyDraft.id}/post`, 'POST', undefined, ownerToken, ids.organization);
  const unlinkedPaymentPost = await api('/api/expenses', 'POST', { category: 'Закупка', amount: 1, expenseDate: new Date().toISOString().slice(0, 10), description: 'Unlinked purchase must be refused', source: 'purchase' }, ownerToken, ids.organization, 400);
  check(unlinkedPaymentPost.error === 'purchase_payment_requires_receipt_link', 'new purchase expenses must use the receipt-linked payable route');
  let directUnlinkedPaymentRejected = false;
  try {
    await db.query("INSERT INTO expenses(venue_id,category,amount,expense_date,description,source,created_by) VALUES($1,'Закупка',1,CURRENT_DATE,'unlinked purchase must be refused','purchase',$2)", [ids.venue, ids.owner]);
  } catch (error) { directUnlinkedPaymentRejected = error.code === '23514' && error.message.includes('purchase_payment_requires_receipt_link'); }
  check(directUnlinkedPaymentRejected, 'database trigger rejects new unlinked purchase expenses');
  await db.query('ALTER TABLE expenses DISABLE TRIGGER expenses_purchase_payment_receipt_required');
  try {
    await db.query("INSERT INTO expenses(venue_id,category,amount,expense_date,description,source,created_by) VALUES($1,'Закупка',1,CURRENT_DATE,'synthetic legacy unlinked payment','purchase',$2)", [ids.venue, ids.owner]);
  } finally { await db.query('ALTER TABLE expenses ENABLE TRIGGER expenses_purchase_payment_receipt_required'); }
  const legacyMovements = await movements(legacyItem.id);
  const legacyFailure = await api(`/api/inventory/purchase-documents/${legacyDraft.id}/reverse`, 'POST', { reason: 'Legacy payment coverage', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(legacyFailure.error === 'purchase_document_reversal_payment_coverage_unavailable' && await movements(legacyItem.id) === legacyMovements, 'legacy unlinked purchase payment makes reversal fail closed without changing stock');

  await db.query('UPDATE shifts SET closed_at=now(),closing_cash=opening_cash WHERE venue_id=$1 AND closed_at IS NULL', [ids.venue]);
  const closedFailure = await api(`/api/inventory/purchase-documents/${closedDraft.id}/reverse`, 'POST', { reason: 'Closed shift', idempotencyKey: randomUUID() }, ownerToken, ids.organization, 409);
  check(closedFailure.error === 'purchase_document_reversal_open_shift_required' && await movements(closedItem.id) === 1, 'absence of an open shift rejects reversal without changing stock');

  const rollbackCount = await db.query('SELECT (SELECT count(*)::int FROM inventory_purchase_reversals WHERE venue_id=$1) AS reversals,(SELECT count(*)::int FROM audit_events WHERE venue_id=$1 AND action=\'inventory.purchase_document_reversed\') AS audits', [ids.venue]);
  check(rollbackCount.rows[0].reversals === 2 && rollbackCount.rows[0].audits === 2, 'all refused and rolled-back attempts leave no extra reversal or audit artifacts');
  passed = true;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) { const close = new Promise(resolve => server.once('close', resolve)); if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' }); else server.kill('SIGTERM'); await Promise.race([close, delay(5000)]); }
  if (db._connected) await db.end();
}
if (passed) console.log(`ACCEPTANCE #27 PURCHASE REVERSAL POSTGRES QA: PASS (${assertions} assertions; authenticated API boundary, dual permission, tenant isolation, policy versioning, exact stock/cost restore, replay, paid/used rejection; disposable DB owned by runner)`);
