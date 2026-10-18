import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

// Mutations are confined to synthetic UUID fixtures in an explicitly verified
// localhost QA database. Never derive the target from the production DATABASE_URL.
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'Staff identity QA');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i, 'Staff identity QA requires the runner-created fresh disposable database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'Staff identity QA must run through the guarded disposable PostgreSQL runner');
const pool = new pg.Pool({ connectionString: target.url.href, max: 3 });
const org = randomUUID(), otherOrg = randomUUID(), venue = randomUUID(), otherVenue = randomUUID();
const password = randomBytes(6).toString('hex').slice(0, 10);
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const reserved = 'qa_platform_' + randomUUID().slice(0, 8);
const users = new Map();
const triggerName = 'qa_identity_' + randomUUID().replaceAll('-', '');
let child, base, checks = 0;
let functionalFailure = null;
let shutdownFailures = [];
const check = (value, label) => { checks++; assert.ok(value, label); };
const equal = (actual, expected, label) => { checks++; assert.deepEqual(actual, expected, label); };
const api = async (path, token, method = 'GET', data) => {
  const response = await fetch(base + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(data === undefined ? {} : { 'Content-Type': 'application/json' })
  }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, data: await response.json() };
};
const expect = (result, status, label, error) => {
  equal(result.status, status, label + ' status ' + JSON.stringify(result.data));
  if (error) equal(result.data.error, error, label + ' error');
  return result.data;
};
const login = async (username, expected = 200) => {
  const result = await api('/api/login', null, 'POST', { username, password });
  const data = expect(result, expected, 'Synthetic login');
  return data.token;
};
const patch = (key, actor, data) => api(`/api/staff/${users.get(key).id}/profile`, users.get(actor).token, 'PATCH', data);
const row = async key => (await pool.query('SELECT id,full_name AS name,login,contact_email AS email,password_hash,pin_hash FROM users WHERE id=$1', [users.get(key).id])).rows[0];
const sessionsFor = async key => Number((await pool.query('SELECT count(*) AS count FROM auth_sessions WHERE user_id=$1', [users.get(key).id])).rows[0].count);
const auditsFor = async key => (await pool.query("SELECT action,before_data,after_data FROM audit_events WHERE entity_id=$1 AND action='staff.login_updated' ORDER BY created_at,id", [users.get(key).id])).rows;
const profile = (key, actor = 'owner') => api(`/api/staff/${users.get(key).id}/profile`, users.get(actor).token);

try {
  const identity = (await pool.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'Staff identity QA');
  const migration = readFileSync(new URL('../migrations/057_staff_contact_email.sql', import.meta.url), 'utf8');
  await pool.query(migration);
  await pool.query(migration);
  check((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='contact_email'")).rowCount === 1, 'Migration57 contact_email is applied');
  for (const id of [org, otherOrg]) {
    await pool.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Synthetic staff identity QA',$2,'enterprise')", [id, 'qa-identity-' + id]);
    await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)", [id]);
  }
  for (const [id, organizationId] of [[venue, org], [otherVenue, otherOrg]]) await pool.query("INSERT INTO venues(id,organization_id,name) VALUES($1,$2,'Synthetic identity QA')", [id, organizationId]);
  for (const [key, role] of [['owner','owner'],['admin','admin'],['manager','manager'],['worker','bartender'],['protected_admin','admin'],['developer','developer'],['deleted','bartender'],['other','owner']]) {
    const id = randomUUID(), username = `qa_${key}_${id.slice(0,8)}`;
    const organizationId = key === 'other' ? otherOrg : org, venueId = key === 'other' ? otherVenue : venue;
    await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,pin_hash,pin_updated_at,role,deleted_at,birth_date,employment_started_at) VALUES($1,$2,$3,$4,$5,$6,$6,now(),$7,$8,$9::date,$10::date)', [id, venueId, organizationId, 'Synthetic ' + key, username, hash, role, key === 'deleted' ? new Date() : null, '1990-02-12', '2026-06-03']);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [organizationId, id, role === 'owner' ? 'owner' : 'member']);
    users.set(key, { id, login: username });
  }
  child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test',
      DATABASE_URL: target.url.href, VENUE_ID: venue, API_RATE_LIMIT: '10000', SAAS_OWNER_EMAIL: reserved,
      SAAS_OWNER_PASSWORD: randomBytes(24).toString('hex'), DEMO_OWNER_PASSWORD: password, DEMO_ADMIN_PASSWORD: password, DEMO_STAFF_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Identity QA startup timeout')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Identity QA server stopped during startup')); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { output += chunk; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); } });
  });
  for (const [key, user] of users) if (key !== 'deleted') user.token = await login(user.login);

  const worker = users.get('worker'), original = await row('worker');
  const initialProfile = expect(await profile('worker'),200,'Existing employee profile');
  equal(initialProfile.birthDate,'1990-02-12','Profile birth date is an exact calendar string');
  equal(initialProfile.employmentStartedAt,'2026-06-03','Profile employment date is an exact calendar string');
  equal(initialProfile.pinConfigured,true,'Profile reflects configured PIN');
  check(Boolean(initialProfile.pinUpdatedAt),'Profile returns actual PIN update timestamp');
  const secondToken = await login(worker.login);
  equal(await sessionsFor('worker'), 2, 'Two synthetic worker sessions exist');
  for (const value of ['', 'ab', 'with space', 'user@example.invalid', 'x'.repeat(33), null, {}, 123])
    expect(await patch('worker','owner',{ login: value }), 400, 'Invalid login is rejected', 'invalid_staff_login');
  // null is the explicit clear value for an existing contact email.
  for (const value of ['bad', 'person@', 'person@invalid', 'a b@example.invalid', 'a@example.invalid\nBcc:x@y.invalid', {}, 42, 'x'.repeat(255) + '@example.invalid'])
    expect(await patch('worker','owner',{ email: value }), 400, 'Invalid email is rejected', 'invalid_staff_email');
  expect(await patch('worker','worker',{ login:'SelfDenied' }),403,'Worker cannot rename self','staff_management_required');
  expect(await patch('worker','manager',{ login:'ManagerDenied' }),403,'Manager cannot rename colleague','forbidden');
  expect(await patch('owner','admin',{ login:'Protected_owner' }),403,'Protected owner identity','owner_staff_protected');
  for (const key of ['protected_admin','developer'])
    expect(await patch(key,'admin',{ login:`Protected_${key}` }),403,'Protected identity needs owner','staff_role_assignment_required');
  expect(await patch('admin','admin',{ login:'AdminSelfDenied' }),403,'Administrator cannot rename own protected identity','staff_role_assignment_required');
  expect(await patch('other','owner',{ login:'CrossTenantDenied' }),404,'Cross tenant profile mutation');
  expect(await profile('other'),404,'Cross tenant profile read');
  expect(await patch('deleted','owner',{ login:'DeletedDenied' }),404,'Archived employee mutation');
  expect(await profile('deleted'),404,'Archived employee read');
  for (const value of ['admin','owner','staff',reserved])
    expect(await patch('worker','owner',{ login: value }),409,'Reserved login is rejected','reserved_staff_login');
  expect(await patch('worker','owner',{ login:users.get('other').login,email:'rollback@example.invalid',name:'Must roll back' }),409,'Cross tenant global collision','login_already_exists');
  equal(await row('worker'), original, 'Duplicate rollback preserves all profile and credential fields');
  equal(await sessionsFor('worker'),2,'Duplicate preserves sessions');
  equal((await auditsFor('worker')).length,0,'Duplicate does not create login audit');

  expect(await patch('worker','worker',{ email:'self@example.invalid' }),200,'Worker may update own contact email');
  equal((await row('worker')).email,'self@example.invalid','Contact email persists');
  equal(expect(await profile('worker'),200,'Contact readback').email,'self@example.invalid','Profile exposes contact email');
  const list = expect(await api('/api/staff',users.get('owner').token),200,'Staff list');
  equal(list.items.find(user=>user.id===worker.id)?.email,'self@example.invalid','List exposes saved email');
  expect(await patch('worker','owner',{ login:worker.login,email:'owner-set@example.invalid' }),200,'Unchanged login plus email');
  equal(await sessionsFor('worker'),2,'Unchanged login does not revoke sessions');
  expect(await api('/api/session',worker.token),200,'First worker session retained');
  expect(await api('/api/session',secondToken),200,'Second worker session retained');
  expect(await patch('worker','owner',{ email:'' }),200,'Blank contact email clears');
  equal((await row('worker')).email,null,'Cleared email is NULL');
  expect(await patch('worker','owner',{ email:null }),200,'Null contact email clears');
  expect(await patch('worker','owner',{}),200,'Omitted identity fields preserve existing values');
  equal((await auditsFor('worker')).length,0,'Email and no-op do not create login audit');

  const createInput = { name:'Synthetic new worker',role:'bartender',login:'qa_new_'+randomUUID().slice(0,8),password,birthDate:'1990-01-01',email:'new.worker@example.invalid' };
  expect(await api('/api/staff',users.get('owner').token,'POST',{ ...createInput,email:'invalid' }),400,'Creation email validation','invalid_staff_email');
  expect(await api('/api/staff',users.get('owner').token,'POST',{ ...createInput,login:reserved }),409,'Creation reserved login','reserved_staff_login');
  expect(await api('/api/staff',users.get('owner').token,'POST',{ ...createInput,login:users.get('other').login }),409,'Creation global login collision','login_already_exists');
  const created = expect(await api('/api/staff',users.get('owner').token,'POST',createInput),201,'Creation accepts email');
  equal(created.email,createInput.email,'Creation returns contact email');
  equal((await pool.query('SELECT contact_email FROM users WHERE id=$1',[created.id])).rows[0].contact_email,createInput.email,'Creation persists email');
  expect(await patch('worker','owner',{ email:'  CaseSensitive@EXAMPLE.INVALID  ' }),200,'Contact normalization');
  equal((await row('worker')).email,'CaseSensitive@example.invalid','Email domain normalizes without altering local part');

  // A fixture-scoped failure proves the login audit must participate in the
  // same transaction as profile writes and session revocation.
  await pool.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${worker.id}'::uuid AND NEW.action='staff.login_updated' THEN RAISE EXCEPTION 'synthetic identity audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
  const beforeFailure = await row('worker');
  expect(await patch('worker','owner',{ login:'AuditRollback_'+randomUUID().slice(0,8),name:'Audit must roll back',email:'atomic@example.invalid' }),503,'Failed audit rejects rename','staff_profile_save_failed');
  equal(await row('worker'),beforeFailure,'Audit failure rolls back profile/login/email');
  equal(await sessionsFor('worker'),2,'Audit failure rolls back session revocation');
  expect(await api('/api/session',worker.token),200,'Audit failure preserves cached token access');
  await pool.query(`DROP TRIGGER ${triggerName} ON audit_events`);
  await pool.query(`DROP FUNCTION ${triggerName}()`);

  const renamed = 'QaRoman_'+randomUUID().slice(0,8);
  const cardProfile = expect(await profile('worker'),200,'Card reads before identity update');
  const saved = expect(await patch('worker','admin',{ login:'  '+renamed+'  ',email:'roman@example.invalid',employmentStartedAt:cardProfile.employmentStartedAt }),200,'Administrator renames ordinary worker with card date payload');
  equal(saved.login,renamed,'Trimmed login returns exact letter case');
  equal((await row('worker')).login,renamed,'Rename persists exact case');
  equal((await row('worker')).password_hash,original.password_hash,'Password hash unchanged');
  equal((await row('worker')).pin_hash,original.pin_hash,'PIN hash unchanged');
  const afterCard = expect(await profile('worker'),200,'Card reads after identity update');
  equal(afterCard.birthDate,'1990-02-12','Identity edit preserves birth calendar date');
  equal(afterCard.employmentStartedAt,'2026-06-03','Identity edit preserves employment calendar date');
  const storedDates=(await pool.query("SELECT to_char(birth_date,'YYYY-MM-DD') AS birth,to_char(employment_started_at,'YYYY-MM-DD') AS employment FROM users WHERE id=$1",[worker.id])).rows[0];
  equal(storedDates,{birth:'1990-02-12',employment:'2026-06-03'},'Stored dates survive card-style identity save');
  equal(await sessionsFor('worker'),0,'All persisted worker sessions revoked');
  expect(await api('/api/session',worker.token),401,'First cached worker token cannot authenticate');
  expect(await api('/api/session',secondToken),401,'Second cached worker token cannot authenticate');
  await login(worker.login,401);
  await login(renamed.toLowerCase(),401);
  const newToken = await login(renamed);
  equal(expect(await api('/api/session',newToken),200,'New login works').user.id,worker.id,'New login keeps employee identity');
  const audits = await auditsFor('worker');
  equal(audits.length,1,'Successful rename has one committed login audit');
  check(JSON.stringify(audits[0]).includes(worker.login) && JSON.stringify(audits[0]).includes(renamed),'Audit records old and new login');
  check(!JSON.stringify(audits[0]).includes(original.password_hash),'Audit does not contain password hash');
  expect(await api('/api/session',users.get('admin').token),200,'Acting administrator session retained');
  for (const key of ['protected_admin','developer']) {
    expect(await patch(key,'owner',{ login:'QaProtected_'+randomUUID().slice(0,8) }),200,'Owner may rename protected identity');
    expect(await api('/api/session',users.get(key).token),401,'Protected renamed session revoked');
  }
  const caseLogin = renamed.toLowerCase();
  expect(await api('/api/staff',users.get('owner').token,'POST',{ ...createInput,login:caseLogin,email:'' }),201,'Exact-case uniqueness permits distinct lower-case login');
  console.log(`STAFF IDENTITY POSTGRES QA: PASS (${checks} assertions; email create/edit/clear; exact login; reserved and global collisions; RBAC/tenant/archive; transactional audit+revocation; original credentials preserved)`);
} catch (error) {
  functionalFailure = error;
} finally {
  shutdownFailures = [];
  if (child && child.exitCode === null && child.signalCode === null) {
    try { const stopped = new Promise(resolve=>child.once('close',resolve)); child.kill(); await stopped; } catch (error) { shutdownFailures.push(error); }
  }
  try { await pool.end(); } catch (error) { shutdownFailures.push(error); }
  console.log('FIXTURE CLEANUP DEFERRED: guarded runner will drop its owned disposable database after this child exits');
}
if (functionalFailure && shutdownFailures.length) throw new AggregateError([functionalFailure, ...shutdownFailures], 'Functional QA and process cleanup both failed');
if (functionalFailure) throw functionalFailure;
if (shutdownFailures.length) throw new AggregateError(shutdownFailures, 'QA process cleanup failed');
