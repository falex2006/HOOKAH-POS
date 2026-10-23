import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'Floor table archive QA database');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i, 'requires a runner-created random orders_qa database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local runner may own this disposable database');
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH, 'runner must provide its configured Playwright runtime');
assert.ok(process.env.CHROME_PATH, 'runner must provide the configured Chrome executable');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const marker = randomBytes(6).toString('hex');
const ids = {
  organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), manager: randomUUID(), bartender: randomUUID(),
  foreignOrganization: randomUUID(), foreignVenue: randomUUID(), foreignOwner: randomUUID(), zone: randomUUID(),
  historicTable: randomUUID(), activeOrderTable: randomUUID(), reservedTable: randomUUID(), managerTable: randomUUID(),
  order: randomUUID(), reservation: randomUUID(),
};
const logins = { owner: `qa15-owner-${marker}`, manager: `qa15-manager-${marker}`, bartender: `qa15-bartender-${marker}`, foreign: `qa15-foreign-${marker}` };
const password = randomBytes(24).toString('hex');
const passHash = (value) => { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`; };
const hash = passHash(password);
let connected = false, server, serverClosed, browser, output = '', base = '', passed = false, checks = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readCount = async (sql, values = []) => Number((await db.query(sql, values)).rows[0].count);
const stopServer = async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
  else server.kill('SIGTERM');
  assert.equal(await Promise.race([serverClosed.then(() => true), delay(5000).then(() => false)]), true, 'owned QA server closes');
};

try {
  await db.connect(); connected = true;
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'floor table archive browser QA');
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.organization, 'QA15 floor archive', `qa15-${ids.organization}`, 'Asia/Yekaterinburg', ids.foreignOrganization, 'QA15 foreign floor', `qa15-foreign-${ids.foreignOrganization}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [ids.organization, ids.foreignOrganization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.venue, ids.organization, 'QA15 synthetic venue', 'Asia/Yekaterinburg', ids.foreignVenue, ids.foreignOrganization, 'QA15 foreign venue']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES
      ($1,$2,$3,'QA15 owner',$4,$5,'owner','[]'::jsonb),($6,$2,$3,'QA15 manager',$7,$5,'manager','[]'::jsonb),
      ($8,$2,$3,'QA15 bartender',$9,$5,'bartender','["orders"]'::jsonb),($10,$11,$12,'QA15 foreign owner',$13,$5,'owner','[]'::jsonb)`,
    [ids.owner, ids.organization, ids.venue, logins.owner, hash, ids.manager, logins.manager, ids.bartender, logins.bartender, ids.foreignOwner, ids.foreignOrganization, ids.foreignVenue, logins.foreign]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($5,$6,'owner','active')", [ids.organization, ids.owner, ids.manager, ids.bartender, ids.foreignOrganization, ids.foreignOwner]);
    await db.query('INSERT INTO zones(id,venue_id,name) VALUES($1,$2,$3)', [ids.zone, ids.venue, `QA15 Hall ${marker}`]);
    await db.query(`INSERT INTO tables(id,zone_id,name,capacity,min_capacity,max_capacity,status) VALUES
      ($1,$2,'QA15 historical table',4,2,6,'free'),($3,$2,'QA15 active order table',4,2,6,'free'),($4,$2,'QA15 confirmed booking table',4,2,6,'free'),($5,$2,'QA15 manager table',4,2,6,'free')`,
    [ids.historicTable, ids.zone, ids.activeOrderTable, ids.reservedTable, ids.managerTable]);
    await db.query("INSERT INTO orders(id,venue_id,table_id,opened_by,status,created_at,closed_at) VALUES($1,$2,$3,$4,'closed',now()-interval '1 day',now()-interval '1 day')", [ids.order, ids.venue, ids.historicTable, ids.owner]);
    await db.query("INSERT INTO reservations(id,venue_id,table_id,starts_at,ends_at,guests_count,status) VALUES($1,$2,$3,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '20:00',(now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '21:00',2,'cancelled')", [randomUUID(), ids.venue, ids.historicTable]);
    await db.query("INSERT INTO orders(id,venue_id,table_id,opened_by,status) VALUES($1,$2,$3,$4,'open')", [randomUUID(), ids.venue, ids.activeOrderTable, ids.owner]);
    await db.query("INSERT INTO reservations(id,venue_id,table_id,starts_at,ends_at,guests_count,status) VALUES($1,$2,$3,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '12:00',(now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '13:00',2,'confirmed')", [ids.reservation, ids.venue, ids.reservedTable]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  serverClosed = new Promise((resolve) => server.once('close', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${output}`);
    else await delay(50);
  }
  assert.ok(base, `owned QA server starts: ${output}`);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres', 'browser uses authenticated PostgreSQL server'); checks++;

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ownerContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(logins.owner);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator('#venue-zone-list').waitFor();
  await page.locator(`[data-room-archive="${ids.historicTable}"]`).waitFor();

  const api = async (route, method = 'GET', body, context = ownerContext) => context.request.fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, data: body }) });
  const floor = async (query = '') => (await api(`/api/floor${query}`)).json();
  const preconditionBody = { expectedVenueId: ids.venue, expectedArchivedAt: null, expectedArchiveVersion: 0 };
  const initialHistory = await db.query('SELECT (SELECT count(*)::int FROM orders WHERE table_id=$1) AS orders,(SELECT count(*)::int FROM reservations WHERE table_id=$1) AS reservations', [ids.historicTable]);
  const initialTable = await db.query('SELECT id,zone_id,name,status::text AS status,archived_at FROM tables WHERE id=$1', [ids.historicTable]);
  const initialAudit = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, ids.historicTable]);
  assert.deepEqual((await floor()).zones.find((zone) => zone.id === ids.zone)?.tables.map((table) => table.id).sort(), [ids.activeOrderTable, ids.managerTable, ids.reservedTable, ids.historicTable].sort(), 'floor begins with all active synthetic tables'); checks++;
  const historyDelete = await api(`/api/floor/tables/${ids.historicTable}`, 'DELETE', { expectedVenueId: ids.venue });
  assert.equal(historyDelete.status(), 409, 'history-bearing table cannot be physically deleted'); checks++;
  assert.equal((await historyDelete.json()).error, 'table_has_history'); checks++;
  assert.deepEqual((await db.query('SELECT id,zone_id,name,status::text AS status,archived_at FROM tables WHERE id=$1', [ids.historicTable])).rows, initialTable.rows, 'history deletion rejection leaves table intact'); checks++;
  assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM orders WHERE table_id=$1) AS orders,(SELECT count(*)::int FROM reservations WHERE table_id=$1) AS reservations', [ids.historicTable])).rows, initialHistory.rows, 'history deletion rejection preserves order and reservation links'); checks++;

  const liveAuditBefore = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=ANY($2::uuid[]) AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, [ids.activeOrderTable, ids.reservedTable]]);
  for (const tableId of [ids.activeOrderTable, ids.reservedTable]) {
    const rejected = await api(`/api/floor/tables/${tableId}/archive`, 'POST', preconditionBody);
    assert.equal(rejected.status(), 409, 'archive refuses live order/current confirmed reservation'); checks++;
    assert.equal((await rejected.json()).error, 'table_has_live_activity'); checks++;
    assert.equal(await readCount('SELECT count(*)::int AS count FROM tables WHERE id=$1 AND archived_at IS NULL', [tableId]), 1, 'live table remains active after archive rejection'); checks++;
  }
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=ANY($2::uuid[]) AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, [ids.activeOrderTable, ids.reservedTable]]), liveAuditBefore, 'activity rejections add no archive audit event'); checks++;
  const blockedArchiveResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/floor/tables/${ids.activeOrderTable}/archive`));
  await page.locator(`[data-room-archive="${ids.activeOrderTable}"]`).click();
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  assert.equal((await blockedArchiveResponsePromise).status(), 409, 'settings UI cannot archive a table with an open order'); checks++;
  await page.getByText('Нельзя архивировать стол: есть открытый заказ или бронь на сегодня').waitFor();
  checks++;

  const foreign = await browser.newContext({ locale: 'ru-RU' });
  const foreignLogin = await foreign.request.post(`${base}/api/login`, { headers: { 'X-Organization-Id': ids.foreignOrganization }, data: { username: logins.foreign, password } });
  assert.equal(foreignLogin.status(), 200); checks++;
  const foreignToken = (await foreignLogin.json()).token;
  const beforeTenant = await db.query('SELECT archived_at FROM tables WHERE id=$1', [ids.historicTable]);
  const foreignAttempt = await fetch(`${base}/api/floor/tables/${ids.historicTable}/archive`, { method: 'POST', headers: { Authorization: `Bearer ${foreignToken}`, 'X-Organization-Id': ids.foreignOrganization, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...preconditionBody, expectedVenueId: ids.foreignVenue }) });
  assert.equal(foreignAttempt.status, 404, 'foreign owner cannot discover or mutate another tenant table'); checks++;
  assert.deepEqual((await db.query('SELECT archived_at FROM tables WHERE id=$1', [ids.historicTable])).rows, beforeTenant.rows, 'foreign denial leaves table unchanged'); checks++;
  await foreign.close();

  const staffContext = await browser.newContext({ locale: 'ru-RU' });
  const staffLogin = await staffContext.request.post(`${base}/api/login`, { headers: { 'X-Organization-Id': ids.organization }, data: { username: logins.bartender, password } });
  assert.equal(staffLogin.status(), 200); checks++;
  const staffToken = (await staffLogin.json()).token;
  const staffAuditBefore = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, ids.historicTable]);
  const staffAttempt = await fetch(`${base}/api/floor/tables/${ids.historicTable}/archive`, { method: 'POST', headers: { Authorization: `Bearer ${staffToken}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' }, body: JSON.stringify(preconditionBody) });
  assert.equal(staffAttempt.status, 403, 'bartender without settings cannot archive a table'); checks++;
  assert.deepEqual((await db.query('SELECT archived_at FROM tables WHERE id=$1', [ids.historicTable])).rows, beforeTenant.rows, 'RBAC denial leaves table unchanged'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, ids.historicTable]), staffAuditBefore, 'RBAC denial adds no archive audit event'); checks++;
  await staffContext.close();

  const staleVenue = await api(`/api/floor/tables/${ids.historicTable}/archive`, 'POST', { ...preconditionBody, expectedVenueId: ids.foreignVenue });
  assert.equal(staleVenue.status(), 409, 'stale venue selection is rejected'); checks++;
  assert.equal((await staleVenue.json()).error, 'venue_context_changed'); checks++;
  assert.deepEqual((await db.query('SELECT archived_at FROM tables WHERE id=$1', [ids.historicTable])).rows, beforeTenant.rows, 'stale venue rejection leaves table unchanged'); checks++;

  const archiveResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/floor/tables/${ids.historicTable}/archive`));
  await page.locator(`[data-room-archive="${ids.historicTable}"]`).click();
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  const archiveResponse = await archiveResponsePromise;
  assert.equal(archiveResponse.status(), 200, 'owner archives historical table through settings UI'); checks++;
  const archived = await archiveResponse.json();
  const archivedVersion = Number(archived.archiveVersion);
  assert.equal(archived.id, ids.historicTable); checks++;
  assert.equal(archived.zoneId, ids.zone); checks++;
  assert.ok(archived.archivedAt, 'archive transition supplies its concurrency timestamp'); checks++;
  await page.locator(`[data-room-archive="${ids.historicTable}"]`).waitFor({ state: 'detached' });
  assert.equal((await floor()).zones.find((zone) => zone.id === ids.zone)?.tables.some((table) => table.id === ids.historicTable), false, 'archived table leaves the active operational floor'); checks++;
  const archivedRow = await db.query('SELECT id,zone_id,name,status::text AS status,archived_at FROM tables WHERE id=$1', [ids.historicTable]);
  assert.equal(archivedRow.rowCount, 1, 'archive retains the table row and identity'); checks++;
  assert.equal(archivedRow.rows[0].id, ids.historicTable); checks++;
  assert.equal(archivedRow.rows[0].zone_id, ids.zone); checks++;
  assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM orders WHERE table_id=$1) AS orders,(SELECT count(*)::int FROM reservations WHERE table_id=$1) AS reservations', [ids.historicTable])).rows, initialHistory.rows, 'archive preserves all seeded order/reservation links'); checks++;
  const archiveAuditCount = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.archived\'', [ids.venue, ids.historicTable]);
  assert.equal(archiveAuditCount, initialAudit + 1, 'successful archive writes one audit event'); checks++;
  const settingsFloor = await floor('?includeArchived=true');
  const archivedReadback = settingsFloor.zones.find((zone) => zone.id === ids.zone)?.tables.find((table) => table.id === ids.historicTable);
  assert.equal(archivedReadback?.archiveVersion, archivedVersion, 'settings readback exposes the same archived identity/version'); checks++;
  assert.ok(archivedReadback?.archivedAt, 'settings readback includes archived table'); checks++;
  const repeatedArchive = await api(`/api/floor/tables/${ids.historicTable}/archive`, 'POST', preconditionBody);
  assert.equal(repeatedArchive.status(), 200, 'repeated archive is idempotent'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.archived\'', [ids.venue, ids.historicTable]), archiveAuditCount, 'repeated archive does not duplicate audit'); checks++;
  assert.equal(archivedVersion, 1, 'archive increments monotonic lifecycle version'); checks++;

  await page.locator('[data-floor-view="archived"]').click();
  await page.locator(`[data-room-restore="${ids.historicTable}"]`).waitFor();
  assert.ok(await page.locator(`[data-zone="${ids.zone}"]`).count(), 'archived list keeps the table grouped in its original hall'); checks++;
  const restoreResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/floor/tables/${ids.historicTable}/restore`));
  await page.locator(`[data-room-restore="${ids.historicTable}"]`).click();
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  const restoreResponse = await restoreResponsePromise;
  assert.equal(restoreResponse.status(), 200, 'owner restores through settings UI'); checks++;
  assert.equal((await restoreResponse.json()).id, ids.historicTable); checks++;
  await page.locator('[data-floor-view="active"]').click();
  await page.locator(`[data-room-archive="${ids.historicTable}"]`).waitFor();
  const restoredRow = await db.query('SELECT id,zone_id,archived_at FROM tables WHERE id=$1', [ids.historicTable]);
  assert.equal(restoredRow.rows[0].id, archived.id, 'restore returns the same persistent id'); checks++;
  assert.equal(restoredRow.rows[0].zone_id, ids.zone, 'restore returns to the same hall'); checks++;
  assert.equal(restoredRow.rows[0].archived_at, null, 'restored table is active'); checks++;
  assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM orders WHERE table_id=$1) AS orders,(SELECT count(*)::int FROM reservations WHERE table_id=$1) AS reservations', [ids.historicTable])).rows, initialHistory.rows, 'restore keeps historical references unchanged'); checks++;
  const restoreAuditCount = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.restored\'', [ids.venue, ids.historicTable]);
  assert.equal(restoreAuditCount, 1, 'successful restore writes one audit event'); checks++;
  const repeatedRestore = await api(`/api/floor/tables/${ids.historicTable}/restore`, 'POST', { expectedVenueId: ids.venue, expectedArchivedAt: archived.archivedAt, expectedArchiveVersion: archivedVersion + 1 });
  assert.equal(repeatedRestore.status(), 200, 'repeated restore is idempotent'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.restored\'', [ids.venue, ids.historicTable]), restoreAuditCount, 'repeated restore does not duplicate audit'); checks++;
  const staleRestore = await api(`/api/floor/tables/${ids.historicTable}/restore`, 'POST', { expectedVenueId: ids.venue, expectedArchivedAt: archived.archivedAt, expectedArchiveVersion: archivedVersion - 1 });
  assert.equal(staleRestore.status(), 409); checks++;
  assert.equal((await staleRestore.json()).error, 'table_archive_state_changed'); checks++;
  const restoreVersion = archivedVersion + 1;
  assert.equal(Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.historicTable])).rows[0].archive_version), restoreVersion, 'restore advances the lifecycle version'); checks++;
  const staleArchiveAfterRestore = await api(`/api/floor/tables/${ids.historicTable}/archive`, 'POST', preconditionBody);
  assert.equal(staleArchiveAfterRestore.status(), 409, 'old archive request cannot replay across archive/restore ABA'); checks++;
  assert.equal((await staleArchiveAfterRestore.json()).error, 'table_archive_state_changed'); checks++;
  assert.equal(Number((await db.query('SELECT archived_at,archive_version FROM tables WHERE id=$1', [ids.historicTable])).rows[0].archive_version), restoreVersion, 'stale replay leaves the restored state/version intact'); checks++;

  const managerLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization }, body: JSON.stringify({ username: logins.manager, password }) });
  assert.equal(managerLogin.status, 200); checks++;
  const managerToken = (await managerLogin.json()).token;
  const managerHeaders = { Authorization: `Bearer ${managerToken}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  const managerInitialVersion = Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version);
  const managerPrecondition = { expectedVenueId: ids.venue, expectedArchivedAt: null, expectedArchiveVersion: managerInitialVersion };
  const managerArchive = await fetch(`${base}/api/floor/tables/${ids.managerTable}/archive`, { method: 'POST', headers: managerHeaders, body: JSON.stringify(managerPrecondition) });
  assert.equal(managerArchive.status, 200, 'manager with settings permission can archive'); checks++;
  const managerArchived = await managerArchive.json();
  const managerRestore = await fetch(`${base}/api/floor/tables/${ids.managerTable}/restore`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ expectedVenueId: ids.venue, expectedArchivedAt: managerArchived.archivedAt, expectedArchiveVersion: managerArchived.archiveVersion }) });
  assert.equal(managerRestore.status, 200, 'manager with settings permission can restore'); checks++;
  const raceVersion = Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version);
  const racePrecondition = { expectedVenueId: ids.venue, expectedArchivedAt: null, expectedArchiveVersion: raceVersion };
  const raceAuditBefore = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.archived\'', [ids.venue, ids.managerTable]);
  const restoreAuditBefore = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.restored\'', [ids.venue, ids.managerTable]);
  const archiveRace = await Promise.all([1, 2].map(() => api(`/api/floor/tables/${ids.managerTable}/archive`, 'POST', racePrecondition)));
  assert.ok(archiveRace.every((response) => response.status() === 200), `concurrent archive retries converge: ${archiveRace.map((response) => response.status()).join(',')}`); checks++;
  const racedArchive = (await db.query('SELECT archived_at FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archived_at;
  assert.ok(racedArchive); checks++;
  const archiveAuditAfterRace = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.archived\'', [ids.venue, ids.managerTable]);
  assert.equal(archiveAuditAfterRace, raceAuditBefore + 1, 'concurrent archive writes exactly one audit event'); checks++;
  const versionAfterRaceArchive = Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version);
  const originalArchiveReplay = await api(`/api/floor/tables/${ids.managerTable}/archive`, 'POST', managerPrecondition);
  assert.equal(originalArchiveReplay.status(), 409, 'original archive request is stale while a later cycle is archived'); checks++;
  assert.equal((await originalArchiveReplay.json()).error, 'table_archive_state_changed'); checks++;
  const originalRestoreReplay = await api(`/api/floor/tables/${ids.managerTable}/restore`, 'POST', { expectedVenueId: ids.venue, expectedArchivedAt: managerArchived.archivedAt, expectedArchiveVersion: managerArchived.archiveVersion });
  assert.equal(originalRestoreReplay.status(), 409, 'old restore request is stale during a later archive cycle'); checks++;
  assert.equal((await originalRestoreReplay.json()).error, 'table_archive_state_changed'); checks++;
  assert.equal(Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version), versionAfterRaceArchive, 'stale archive/restore replays leave version unchanged'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.archived\'', [ids.venue, ids.managerTable]), archiveAuditAfterRace, 'stale archive replay adds no audit event'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action IN (\'floor_table.archived\',\'floor_table.restored\')', [ids.venue, ids.managerTable]), archiveAuditAfterRace + restoreAuditBefore, 'stale lifecycle replays add no archive or restore audit events'); checks++;
  const racedVersion = Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version);
  const racedRestore = await Promise.all([1, 2].map(() => api(`/api/floor/tables/${ids.managerTable}/restore`, 'POST', { expectedVenueId: ids.venue, expectedArchivedAt: racedArchive.toISOString(), expectedArchiveVersion: racedVersion })));
  assert.ok(racedRestore.every((response) => response.status() === 200), `concurrent restore retries converge: ${racedRestore.map((response) => response.status()).join(',')}`); checks++;
  const finalRaceState = (await db.query('SELECT archived_at,archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0];
  assert.equal(finalRaceState.archived_at, null); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_id=$2 AND action=\'floor_table.restored\'', [ids.venue, ids.managerTable]), restoreAuditBefore + 1, 'concurrent restore writes exactly one audit event'); checks++;
  assert.equal(Number((await db.query('SELECT archive_version FROM tables WHERE id=$1', [ids.managerTable])).rows[0].archive_version), Number(finalRaceState.archive_version), 'concurrent restore advances one lifecycle version'); checks++;

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-room-archive="${ids.historicTable}"]`).waitFor();
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`); checks++;
  // Empty halls must remain manageable even before their first table is added.
  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill('QA Empty Hall');
  const creatingHall = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/floor/zones'));
  await page.locator('#venue-zone-form button[type="submit"]').click();
  const createdHall = await creatingHall; assert.equal(createdHall.status(), 201); checks++;
  const emptyHall = await createdHall.json();
  await page.locator('#cancel-venue-room').click();
  await page.locator(`[data-zone-edit="${emptyHall.id}"]`).waitFor({ timeout: 5000 });
  assert.equal(await page.locator(`[data-zone="${emptyHall.id}"]`).isVisible(), true, 'new empty hall is visible'); checks++;
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator(`[data-zone="${emptyHall.id}"]`).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth }));
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1, `empty hall fits ${width}`); checks++;
    for (const selector of ['data-zone-add-table', 'data-zone-edit', 'data-zone-delete']) assert.equal(await page.locator(`[${selector}="${emptyHall.id}"]`).isVisible(), true);
  }
  await page.locator(`[data-zone-edit="${emptyHall.id}"]`).click();
  const hallEditor = page.locator('.venue-layout-editor');
  await hallEditor.locator('[name="name"]').fill('QA Renamed Empty Hall');
  const renamingHall = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/floor/zones/${emptyHall.id}`));
  await hallEditor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.equal((await renamingHall).status(), 200); checks++;
  assert.equal((await db.query('SELECT name FROM zones WHERE id=$1', [emptyHall.id])).rows[0].name, 'QA Renamed Empty Hall'); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-zone="${emptyHall.id}"]`).getByText('QA Renamed Empty Hall', { exact: true }).waitFor(); checks++;
  const reorderedHall = await api(`/api/floor/zones/${emptyHall.id}`, 'PATCH', { expectedVenueId: ids.venue, name: 'QA Renamed Empty Hall', sortOrder: -1 });
  assert.equal(reorderedHall.status(), 200); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-zone="${emptyHall.id}"]`).waitFor();
  assert.equal(await page.locator('#venue-zone-list [data-zone]').first().getAttribute('data-zone'), emptyHall.id, 'UI reflects persisted API hall order'); checks++;
  assert.equal(Number((await db.query('SELECT sort_order FROM zones WHERE id=$1', [emptyHall.id])).rows[0].sort_order), -1); checks++;
  await page.locator(`[data-zone-delete="${emptyHall.id}"]`).click();
  await page.locator('.action-modal[role="dialog"]').getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await readCount('SELECT count(*)::int AS count FROM zones WHERE id=$1', [emptyHall.id]), 1, 'cancel keeps empty hall'); checks++;
  const staleHall = await api(`/api/floor/zones/${emptyHall.id}`, 'DELETE', { expectedVenueId: ids.foreignVenue });
  assert.equal(staleHall.status(), 409); checks++;
  const foreignHallContext = await browser.newContext();
  const foreignHallLogin = await foreignHallContext.request.post(`${base}/api/login`, { data: { username: logins.foreign, password } });
  assert.equal(foreignHallLogin.status(), 200); checks++;
  const foreignHall = await api(`/api/floor/zones/${emptyHall.id}`, 'DELETE', { expectedVenueId: ids.foreignVenue }, foreignHallContext);
  assert.equal(foreignHall.status(), 404); checks++;
  await foreignHallContext.close();
  await page.locator(`[data-zone-delete="${ids.zone}"]`).click();
  const blockedHallDelete = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(`/api/floor/zones/${ids.zone}`));
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  assert.equal((await blockedHallDelete).status(), 409, 'populated hall cannot be deleted'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM zones WHERE id=$1', [ids.zone]), 1); checks++;
  await page.locator(`[data-zone-delete="${emptyHall.id}"]`).click();
  const deletingHall = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(`/api/floor/zones/${emptyHall.id}`));
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  assert.equal((await deletingHall).status(), 200); checks++;
  await page.locator(`[data-zone="${emptyHall.id}"]`).waitFor({ state: 'detached' });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator(`[data-zone="${emptyHall.id}"]`).count(), 0); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM zones WHERE id=$1', [emptyHall.id]), 0); checks++;
  assert.equal(await readCount("SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='floor_zone.deleted'", [emptyHall.id]), 1, 'one committed delete audit'); checks++;
  const restrictedRole = randomUUID();
  await db.query("INSERT INTO custom_staff_roles(id,organization_id,venue_id,name,permission_scopes) VALUES($1,$2,$3,'QA floor restricted','[\"orders\"]'::jsonb)", [restrictedRole, ids.organization, ids.venue]);
  await db.query('UPDATE users SET custom_role_id=$1 WHERE id=$2', [restrictedRole, ids.manager]);
  const restrictedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const restrictedLogin = await restrictedContext.request.post(`${base}/api/login`, { data: { username: logins.manager, password } });
  assert.equal(restrictedLogin.status(), 200); checks++;
  const restrictedPage = await restrictedContext.newPage();
  // Browser local auth is populated through the normal login page, not injected grants.
  await restrictedPage.goto(`${base}/login`);
  await restrictedPage.locator('#login-username').fill(logins.manager);
  await restrictedPage.locator('#login-password').fill(password);
  await restrictedPage.locator('#login-form button[type="submit"]').click();
  await restrictedPage.waitForURL(url => url.pathname !== '/login');
  await restrictedPage.goto(`${base}/admin#venue-layout-settings`);
  await restrictedPage.getByText('Доступ к этому разделу ограничен. Владелец может изменить права вашей роли.', { exact: true }).waitFor(); checks++;
  assert.equal(await restrictedPage.locator('#new-floor-zone').count(), 0, 'restricted role does not mount management controls'); checks++;
  const beforeRestricted = await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1', [ids.venue]);
  const restrictedEdit = await api(`/api/floor/zones/${ids.zone}`, 'PATCH', { expectedVenueId: ids.venue, name: 'Denied rename' }, restrictedContext);
  assert.equal(restrictedEdit.status(), 403, 'custom role removes inherited manager settings'); checks++;
  assert.equal(await readCount('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1', [ids.venue]), beforeRestricted); checks++;
  assert.notEqual((await db.query('SELECT name FROM zones WHERE id=$1', [ids.zone])).rows[0].name, 'Denied rename'); checks++;
  await restrictedContext.close();
  assert.deepEqual(pageErrors, []); checks++;
  await ownerContext.close(); passed = true;
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try { await stopServer(); }
    finally {
      // The guarded local runner owns and drops this entire random QA database.
      // Row cleanup conflicts with immutable payroll evidence and can mask test failures.
      if (connected) await db.end();
    }
  }
}

if (passed) console.log(`ACCEPTANCE #15 FLOOR TABLE ARCHIVE POSTGRES BROWSER QA: PASS (${checks} assertions; UI archive/restore with preserved history; live activity/concurrency/idempotency; empty hall create/edit/reload/delete/cancel3203907681440; populated/stale/foreign delete guards; API order reflected in UI; standard and restricted custom role; runner-owned disposable database)`);
