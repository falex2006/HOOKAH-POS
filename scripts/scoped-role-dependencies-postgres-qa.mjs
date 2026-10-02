import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const pool = new pg.Pool({ connectionString: target.url.href });
const identity = await pool.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
assertQaDatabaseIdentity(identity.rows[0], target.database, Number(target.url.port || 5432));
const org = randomUUID(), otherOrg = randomUUID(), venue = randomUUID(), otherVenue = randomUUID();
const password = randomBytes(12).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const fixtureUsers = new Map();
let child, base;
let checks = 0;
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const hasLegacyLookupRoutes = serverSource.includes("pathname === '/api/payroll/employees'") && serverSource.includes("pathname === '/api/reservations/guests'");
const api = async (path, token, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const status = (result, expected, label) => { checks++; assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`); return result.data; };

try {
  for (const [id, suffix] of [[org, 'main'], [otherOrg, 'other']]) {
    await pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)', [id, 'Synthetic scoped roles QA', `qa-scoped-${id}-${suffix}`]);
    await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)", [id]);
  }
  for (const [id, organizationId] of [[venue, org], [otherVenue, otherOrg]]) await pool.query('INSERT INTO venues(id,organization_id,name) VALUES($1,$2,$3)', [id, organizationId, 'Synthetic QA venue']);
  for (const [key, role, scopes] of [
    ['owner', 'owner', []], ['inventory', 'admin', ['inventory']], ['reservations', 'admin', ['reservations']],
    ['settings', 'admin', ['settings']], ['finance', 'admin', ['finance']], ['orders', 'admin', ['orders']],
    ['senior_bartender', 'senior_bartender', []], ['senior_hookah_master', 'senior_hookah_master', []],
    ['manager', 'manager', []], ['other', 'owner', []]
  ]) {
    const id = randomUUID(), login = `qa_${key}_${id.slice(0, 8)}`;
    const organizationId = key === 'other' ? otherOrg : org;
    const venueId = key === 'other' ? otherVenue : venue;
    await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [id, venueId, organizationId, `QA ${key}`, login, hash, role, JSON.stringify(scopes)]);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')", [organizationId, id]);
    fixtureUsers.set(key, { id, login });
  }
  const zone = (await pool.query("INSERT INTO zones(venue_id,name) VALUES($1,'QA zone') RETURNING id", [venue])).rows[0].id;
  await pool.query("INSERT INTO tables(zone_id,name) VALUES($1,'QA table')", [zone]);
  const product = (await pool.query("INSERT INTO products(venue_id,name,category,sale_price) VALUES($1,'Scoped QA product','QA',100) RETURNING id", [venue])).rows[0].id;
  const guest = (await pool.query("INSERT INTO guests(venue_id,full_name,nickname,phone,loyalty_points,notes) VALUES($1,'QA visible guest','QA','+70000000111',500,'must not leak') RETURNING id", [venue])).rows[0].id;
  const foreignGuest = (await pool.query("INSERT INTO guests(venue_id,full_name) VALUES($1,'QA foreign guest') RETURNING id", [otherVenue])).rows[0].id;
  await pool.query("INSERT INTO guests(venue_id,full_name,archived_at) VALUES($1,'QA archived guest',now())", [venue]);
  const deletedUser = (await pool.query("INSERT INTO users(venue_id,organization_id,full_name,login,role,deleted_at) VALUES($1,$2,'QA deleted employee',$3,'bartender',now()) RETURNING id", [venue, org, `qa_deleted_${randomUUID()}`])).rows[0].id;

  child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: target.url.href, VENUE_ID: venue, API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Scoped QA server startup timeout')), 15000);
    child.once('error', reject);
    child.stdout.on('data', chunk => { output += chunk; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); } });
  });
  for (const [key, user] of fixtureUsers) {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.login, password }) });
    const data = await response.json(); assert.equal(response.status, 200, `login ${key}: ${data.error || ''}`); user.token = data.token;
  }
  for (const [key, user] of fixtureUsers) {
    const canFloor = ['owner','orders','senior_bartender','senior_hookah_master','manager','other'].includes(key);
    const canProducts = ['owner','inventory','orders','senior_bartender','senior_hookah_master','manager','other'].includes(key);
    const canPayroll = ['owner','finance','other'].includes(key);
    const canGuests = ['owner','reservations','manager','other'].includes(key);
    status(await api('/api/floor', user.token), canFloor ? 200 : 403, `${key} floor read`);
    status(await api('/api/products', user.token), canProducts ? 200 : 403, `${key} product read`);
    const employees = hasLegacyLookupRoutes ? status(await api('/api/payroll/employees', user.token), canPayroll ? 200 : 403, `${key} payroll lookup`) : null;
    if (canPayroll && employees) {
      assert.ok(employees.items.every(item => Object.keys(item).sort().join(',') === 'active,id,name'), 'lookup never exposes staff credentials, phones or personnel data');
      assert.ok(!employees.items.some(item => item.id === deletedUser), 'deleted staff excluded');
      assert.ok(employees.items.every(item => key === 'other' ? item.id === fixtureUsers.get('other').id : item.id !== fixtureUsers.get('other').id), 'payroll lookup tenant isolated');
    }
    const guests = hasLegacyLookupRoutes ? status(await api('/api/reservations/guests', user.token), canGuests ? 200 : 403, `${key} reservation lookup`) : null;
    if (canGuests && guests) {
      assert.ok(guests.items.every(item => Object.keys(item).sort().join(',') === 'id,name,nickname,phoneNumbers'), 'booking lookup excludes balances, preferences and notes');
      assert.deepEqual(guests.items.map(item => item.id), [key === 'other' ? foreignGuest : guest], 'booking lookup tenant isolated and archived guests excluded');
    }
  }
  for (const key of ['inventory','reservations','finance']) status(await api('/api/floor/zones', fixtureUsers.get(key).token, 'POST', { expectedVenueId: venue, name: 'must be denied' }), 403, `${key} cannot mutate floor`);
  for (const key of ['reservations','settings','finance']) status(await api('/api/products', fixtureUsers.get(key).token, 'POST', { name: 'must be denied', price: 100 }), 403, `${key} cannot mutate products`);
  status(await api('/api/staff', fixtureUsers.get('finance').token), 403, 'finance lookup does not unlock personnel directory');
  status(await api('/api/clients', fixtureUsers.get('reservations').token), 403, 'booking lookup does not unlock full guest directory');
  const saved = status(await api('/api/products', fixtureUsers.get('inventory').token, 'POST', { name: 'Inventory scoped service', category: 'QA', price: 100, inventoryMode: 'non_stock' }), 201, 'inventory scope still creates products');
  assert.ok((await api('/api/products', fixtureUsers.get('inventory').token)).data.items.some(item => item.id === saved.id), 'scoped product persists');

  const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
  const prefix = portal.slice(0, portal.indexOf('const compressUploadedImage'));
  for (const role of ['bartender','hookah_master','senior_bartender','senior_hookah_master']) {
    const redirects = [];
    vm.runInNewContext(prefix, { URLSearchParams, localStorage: { getItem: key => key === 'crm_session_token' ? 'synthetic' : JSON.stringify({ role }) }, window: { location: { replace: url => redirects.push(url) } } });
    assert.deepEqual(redirects, [], `${role} actual portal bootstrap permits session refresh`);
  }
  assert.throws(() => vm.runInNewContext(prefix, { URLSearchParams, localStorage: { getItem: key => key === 'crm_session_token' ? 'synthetic' : JSON.stringify({ role: 'platform_owner' }) }, window: { location: { replace() {} } } }), /portal_permission_required/, 'SaaS role does not enter tenant portal');
  assert.ok(portal.includes("api('/api/staff')") && portal.includes("api('/api/payroll/rules')") && portal.includes("api('/api/clients')"), 'UI consumes current POS lookups');
  console.log(`SCOPED ROLE DEPENDENCIES POSTGRES QA: PASS (${checks} real HTTP checks; senior bootstrap; minimal DTO; denied writes; tenant isolation; persisted product)`);
} finally {
  child?.kill();
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  // These UUIDs were allocated by this test in the already verified local QA database.
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[org,otherOrg]]).catch(() => {});
  await pool.end();
}
