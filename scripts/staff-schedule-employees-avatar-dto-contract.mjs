import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Pool } = require('pg');
const { MAX_OUTPUT_BYTES } = require('../staff-avatar-image.js');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = () => randomUUID();

async function main() {
  const c = config();
  const fixtures = require('node:fs').readFileSync(path.join(folder, 'fixtures.json'), 'utf8');
  const seeded = JSON.parse(fixtures);
  assert.equal(seeded.database, c.database, 'fixture database matches the guarded schedule QA database');
  const pool = new Pool(options(c));
  let child;
  const fixtureUserIds = [];
  const payloadFixtureIds = [];
  try {
    const ownerId = seeded.users[0].id;
    const employeeLogin = `avatar-dto-${key()}@example.test`;
    const employeeId = key();
    const foreignEmployeeId = key();
    fixtureUserIds.push(employeeId, foreignEmployeeId);
    const source = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 38, g: 92, b: 156 } } }).webp().toBuffer();
    const validAvatar = `data:image/webp;base64,${source.toString('base64')}`;
    assert.ok(source.length <= MAX_OUTPUT_BYTES, 'valid stored avatar respects normalized storage limit');
    const maxPayloadAvatar = `data:image/webp;base64,${Buffer.alloc(MAX_OUTPUT_BYTES).toString('base64')}`;

    const identity = (await pool.query('SELECT current_database() AS database,current_user AS username')).rows[0];
    assert.deepEqual(identity, { database: c.database, username: c.dbUser }, 'fixture writes target the dedicated QA database');
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,avatar_url,photo_url)
      SELECT $1,$2,$3,'Avatar DTO QA',$4,password_hash,'bartender',$5,'private-photo-sentinel'
      FROM users WHERE id=$6`, [employeeId, seeded.venues[0], seeded.organizations[0], employeeLogin, validAvatar, ownerId]);
    await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
      VALUES($1,$2,'member','active',false)`, [seeded.organizations[0], employeeId]);
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,avatar_url)
      SELECT $1,$2,$3,'Foreign Avatar DTO QA',$4,password_hash,'bartender',$5
      FROM users WHERE id=$6`, [foreignEmployeeId, seeded.venues[1], seeded.organizations[1], `avatar-foreign-${key()}@example.test`, validAvatar, ownerId]);
    await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
      VALUES($1,$2,'member','active',false)`, [seeded.organizations[1], foreignEmployeeId]);
    for (let index = 0; index < 12; index++) {
      const id = key();
      payloadFixtureIds.push(id);
      fixtureUserIds.push(id);
      await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,avatar_url)
        SELECT $1,$2,$3,$4,$5,password_hash,'bartender',$6 FROM users WHERE id=$7`,
      [id, seeded.venues[0], seeded.organizations[0], `!Avatar Payload ${String(index).padStart(2, '0')}`,
        `avatar-cap-${index}-${key()}@example.test`, maxPayloadAvatar, ownerId]);
      await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
        VALUES($1,$2,'member','active',false)`, [seeded.organizations[0], id]);
    }

    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...isolatedEnvironment(c, seeded), PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Fresh isolated HTTP child exited before readiness');
      try {
        if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
      } catch { /* child is still starting */ }
      await delay(100);
    }
    assert.ok(ready, 'fresh isolated HTTP child is listening');

    const loginResponse = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: seeded.users[0].login, password: seeded.password }),
    });
    assert.equal(loginResponse.status, 200, 'fixture owner can authenticate against fresh child');
    const { token } = await loginResponse.json();
    const endpoint = `${base}/api/staff/schedule/employees`;
    const readEmployees = async () => {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() };
    };

    const anonymous = await fetch(endpoint);
    assert.equal(anonymous.status, 401, 'employee DTO remains authenticated');
    const allowed = await readEmployees();
    assert.equal(allowed.status, 200);
    const employee = allowed.body.items.find(item => item.id === employeeId);
    assert.ok(employee, 'tenant employee appears in the schedule selector');
    assert.deepEqual(Object.keys(employee).sort(), ['active', 'avatarUrl', 'id', 'name', 'role']);
    assert.equal(employee.avatarUrl, validAvatar, 'valid normalized raster data URL is returned without image re-encoding');
    assert.equal('photoUrl' in employee, false, 'private photo_url is absent from HTTP DTO');
    assert.equal(JSON.stringify(employee).includes('private-photo-sentinel'), false);
    assert.equal(JSON.stringify(employee).includes(employeeLogin), false, 'login/contact identity is not exposed');
    assert.equal(allowed.body.items.some(item => item.id === foreignEmployeeId), false, 'another venue employee remains invisible');
    const payloadRows = allowed.body.items.filter(item => payloadFixtureIds.includes(item.id));
    assert.ok(payloadRows.every(Boolean), 'large-avatar fixture employees remain visible');
    const acceptedPayloadCount = payloadRows.filter(row => row.avatarUrl === maxPayloadAvatar).length;
    const firstOmittedIndex = payloadRows.findIndex(row => row.avatarUrl === null);
    assert.ok(acceptedPayloadCount > 0 && acceptedPayloadCount < payloadRows.length, 'fixture crosses the one-MiB aggregate cap');
    assert.ok(firstOmittedIndex >= 0 && payloadRows.slice(firstOmittedIndex).every(row => row.avatarUrl === null),
      'the SQL name/id order deterministically keeps the fitting prefix and omits remaining avatars');
    const aggregateAvatarChars = allowed.body.items.reduce((total, row) => total + (row.avatarUrl?.length || 0), 0);
    assert.ok(aggregateAvatarChars <= 1024 * 1024, 'combined employee avatar payload stays within one MiB');
    await pool.query('UPDATE users SET avatar_url=NULL WHERE id=ANY($1::uuid[])', [payloadFixtureIds]);

    // Stored bytes are not decoded/re-encoded on this hot read path. The existing UI
    // checks image signatures and retains initials when an image decode raises error.
    const undecodableRaster = 'data:image/webp;base64,AA==';
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2 AND venue_id=$3', [undecodableRaster, employeeId, seeded.venues[0]]);
    const undecodable = await readEmployees();
    assert.equal(undecodable.status, 200);
    assert.equal(undecodable.body.items.find(item => item.id === employeeId).avatarUrl, undecodableRaster,
      'canonical bounded raster URL is returned without CPU-heavy decode; UI fallback handles bad image bytes');

    const rejected = [
      'https://example.invalid/avatar.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      `data:image/webp;base64,${Buffer.alloc(MAX_OUTPUT_BYTES + 1).toString('base64')}`,
      'data:image/webp;base64,not-base64!',
    ];
    for (const candidate of rejected) {
      await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2 AND venue_id=$3', [candidate, employeeId, seeded.venues[0]]);
      const result = await readEmployees();
      assert.equal(result.status, 200, 'bad stored avatar does not break the employee selector');
      const row = result.body.items.find(item => item.id === employeeId);
      assert.ok(row, 'employee remains visible when avatar is rejected');
      assert.equal(row.avatarUrl, null, `rejected avatar omitted: ${candidate.slice(0, 50)}`);
      assert.deepEqual(Object.keys(row).sort(), ['active', 'avatarUrl', 'id', 'name', 'role']);
      assert.equal('photoUrl' in row, false);
    }

    console.log('STAFF SCHEDULE EMPLOYEE AVATAR HTTP CONTRACT: PASS (fresh child, real guarded QA PostgreSQL, avatar allow/reject, minimal DTO, unauthenticated denial)');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const close = new Promise(resolve => child.once('close', resolve));
      if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${child.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await Promise.race([close, delay(5000)]);
    }
    for (const id of fixtureUserIds) await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
}

await main();
