import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const { database, url } = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(database, /^(?:orders_qa|tobacco_auth_qa)_[a-f0-9]{16}$/i,
  'tobacco catalog fixtures require a freshly created, runner-owned disposable QA database');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
const orgA = randomUUID(), orgB = randomUUID();
const venueA1 = randomUUID(), venueA2 = randomUUID(), venueB = randomUUID();
const ownerA = randomUUID(), managerWriteA = randomUUID(), managerReadA = randomUUID(), bartenderA = randomUUID(), ownerB = randomUUID();
const password = `qa-${randomUUID()}`;
const loginPrefix = `tobacco-${randomUUID()}`;
const users = [
  { id: ownerA, venue: venueA1, org: orgA, role: 'owner', scopes: [], suffix: 'owner-a' },
  { id: managerWriteA, venue: venueA1, org: orgA, role: 'manager', scopes: ['inventory'], suffix: 'manager-write-a' },
  { id: managerReadA, venue: venueA2, org: orgA, role: 'manager', scopes: ['inventory_read'], suffix: 'manager-read-a' },
  { id: bartenderA, venue: venueA1, org: orgA, role: 'bartender', scopes: ['orders'], suffix: 'bartender-a' },
  { id: ownerB, venue: venueB, org: orgB, role: 'owner', scopes: [], suffix: 'owner-b' },
];
const logins = Object.fromEntries(users.map((user) => [user.suffix, `${loginPrefix}-${user.suffix}`]));
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${(await promisify(scryptCallback)(password, salt, 64)).toString('hex')}`;
let server, exitWait, output = '', base = '';
let checks = 0;
const api = async (route, method = 'GET', body, token = '', expected = 200) => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`); checks++;
  return payload;
};
const login = async (suffix) => (await api('/api/login', 'POST', { username: logins[suffix], password }, '', 200)).token;
const contains = async (token, id) => (await api('/api/tobacco-catalog?status=all', 'GET', undefined, token)).items.some((item) => item.id === id);
const itemInput = (brand, flavor, scope) => ({ scope, brand, productLine: 'QA line', flavor, productType: 'tobacco', packageGrams: 100, strength: 'medium' });

try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, database, Number(url.port || 5432), 'Tobacco catalog auth boundary QA');

  await client.query('BEGIN');
  await client.query(`INSERT INTO organizations(id,name,slug,plan) VALUES ($1,'Tobacco QA A',$3,'network'),($2,'Tobacco QA B',$4,'network')`, [orgA, orgB, `tobacco-qa-${orgA}`, `tobacco-qa-${orgB}`]);
  await client.query(`INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'network','active',20,5),($2,'network','active',20,5)`, [orgA, orgB]);
  await client.query(`INSERT INTO venues(id,organization_id,name,timezone) VALUES
    ($1,$4,'Tobacco QA A1','Asia/Yekaterinburg'),($2,$4,'Tobacco QA A2','Asia/Yekaterinburg'),($3,$5,'Tobacco QA B','Asia/Yekaterinburg')`, [venueA1, venueA2, venueB, orgA, orgB]);
  for (const user of users) {
    await client.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [user.id, user.venue, user.org, `Tobacco QA ${user.suffix}`, logins[user.suffix], passwordHash, user.role, JSON.stringify(user.scopes)]);
    await client.query('INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,\'active\')',
      [user.org, user.id, user.role === 'owner' ? 'owner' : 'member']);
  }
  await client.query('COMMIT');

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: url.href, VENUE_ID: venueA1, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  exitWait = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`);
    else await delay(50);
  }
  assert.ok(base, 'authenticated QA server started');
  assert.equal((await api('/api/health')).database, 'postgres'); checks++;

  const ownerToken = await login('owner-a');
  const writeToken = await login('manager-write-a');
  const readToken = await login('manager-read-a');
  const bartenderToken = await login('bartender-a');
  const foreignToken = await login('owner-b');

  const organizationItem = await api('/api/tobacco-catalog', 'POST', itemInput('QA Shared Brand', 'Shared Mint', 'organization'), ownerToken, 201);
  assert.equal(organizationItem.organizationId, orgA); assert.equal(organizationItem.venueId, null); checks += 2;
  assert.equal(await contains(readToken, organizationItem.id), true, 'inventory_read can read organization catalog from another venue in the same organization'); checks++;
  assert.equal((await api(`/api/tobacco-catalog/${organizationItem.id}`, 'GET', undefined, readToken)).id, organizationItem.id);
  assert.equal(await contains(foreignToken, organizationItem.id), false, 'organization catalog is hidden from a different tenant'); checks++;
  assert.equal((await api(`/api/tobacco-catalog/${organizationItem.id}`, 'GET', undefined, foreignToken, 404)).error, 'tobacco_catalog_item_not_found');
  assert.equal((await api(`/api/tobacco-catalog/${organizationItem.id}`, 'PATCH', { description: 'foreign edit' }, foreignToken, 404)).error, 'tobacco_catalog_item_not_found');

  const venueItem = await api('/api/tobacco-catalog', 'POST', itemInput('QA Local Brand', 'Local Grape', 'venue'), ownerToken, 201);
  assert.equal(venueItem.organizationId, orgA); assert.equal(venueItem.venueId, venueA1); checks += 2;
  assert.equal(await contains(readToken, venueItem.id), false, 'venue catalog is hidden from another venue in the same organization'); checks++;
  assert.equal((await api(`/api/tobacco-catalog/${venueItem.id}`, 'GET', undefined, readToken, 404)).error, 'tobacco_catalog_item_not_found');
  assert.equal(await contains(ownerToken, venueItem.id), true); checks++;

  assert.equal((await api('/api/tobacco-catalog', 'POST', itemInput('QA Denied Read Scope', 'Write Denied', 'venue'), readToken, 403)).error, 'forbidden');
  assert.equal((await api('/api/tobacco-catalog', 'POST', itemInput('QA Bartender', 'Denied', 'venue'), bartenderToken, 403)).error, 'forbidden');
  assert.equal((await api(`/api/tobacco-catalog/${organizationItem.id}`, 'PATCH', { description: 'read-only edit' }, readToken, 403)).error, 'forbidden');
  assert.equal((await api(`/api/tobacco-catalog/${venueItem.id}`, 'PATCH', { description: 'bartender edit' }, bartenderToken, 403)).error, 'forbidden');
  assert.equal((await api('/api/tobacco-catalog', 'POST', itemInput('QA Network Denied', 'Denied', 'organization'), writeToken, 403)).error, 'tobacco_catalog_network_admin_required');
  assert.equal((await api(`/api/tobacco-catalog/${organizationItem.id}`, 'PATCH', { description: 'network denied' }, writeToken, 403)).error, 'tobacco_catalog_network_admin_required');

  const managerCreated = await api('/api/tobacco-catalog', 'POST', itemInput('QA Manager Brand', 'Manager Mint', 'venue'), writeToken, 201);
  assert.equal(managerCreated.organizationId, orgA); assert.equal(managerCreated.venueId, venueA1); checks += 2;
  const edited = await api(`/api/tobacco-catalog/${venueItem.id}`, 'PATCH', { description: 'same-tenant manager edit' }, writeToken, 200);
  assert.equal(edited.description, 'same-tenant manager edit'); checks++;
  const rows = await client.query(`SELECT id,organization_id AS "organizationId",venue_id AS "venueId",description
    FROM tobacco_catalog_items WHERE id = ANY($1::uuid[]) ORDER BY id`, [[organizationItem.id, venueItem.id, managerCreated.id]]);
  assert.equal(rows.rowCount, 3); checks++;
  assert.deepEqual(rows.rows.map((row) => [row.organizationId, row.venueId, row.description]).sort((a, b) => String(a[1] || '').localeCompare(String(b[1] || '')) || String(a[2]).localeCompare(String(b[2]))),
    [[orgA, null, ''], [orgA, venueA1, ''], [orgA, venueA1, 'same-tenant manager edit']]); checks++;

  console.log(`TOBACCO CATALOG AUTH BOUNDARIES QA: PASS (${checks} assertions; authenticated tenant/venue visibility, inventory_read, inventory write, network-owner restrictions, foreign-tenant canonical 404, PostgreSQL non-effects)`);
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const close = new Promise((resolve) => server.once('close', resolve));
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await close;
  }
  await exitWait?.catch(() => {});
  // Fixture records remain confined to the newly created disposable database;
  // the allowlisted QA runner drops that database after this suite completes.
  await client.end().catch(() => {});
}
