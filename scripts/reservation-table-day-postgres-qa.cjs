'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const guards = require('./local-full-pg-regression.cjs');
const root = path.resolve(__dirname, '..');
const config = guards.validateConfig(JSON.parse(fs.readFileSync(path.join(root, 'tmp/full-local-qa/runtime.json'), 'utf8')));
const database = 'audit_qa_' + randomBytes(8).toString('hex');
const clockFile = path.join(root, 'tmp/full-local-qa', database + '-clock.txt');
const baseline = process.argv.includes('--legacy-baseline');
const url = name => `postgresql://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@127.0.0.1:31931/${name}`;
let admin, pool, child, created = false, base, checks = 0;
const eq = (actual, expected, label) => { checks++; assert.deepEqual(actual, expected, label); };
const clock = value => fs.writeFileSync(clockFile, value);
async function inspect() {
  const result = spawnSync('docker', ['inspect', config.regressionContainer], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0); guards.validateContainer(JSON.parse(result.stdout)[0], config);
  const safety = await import('./postgres-qa-safety.mjs');
  process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER = config.regressionContainer;
  safety.validateQaDatabaseUrl(url(config.database));
  const check = new Pool({ connectionString: url(config.database), max: 1 });
  try { safety.assertQaDatabaseIdentity((await check.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0], config.database, 31931); }
  finally { await check.end(); }
}
async function api(route, token, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json(); eq(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`); return payload;
}
async function stop() {
  if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
  child = null;
}
async function start(venue, sessionTimezone) {
  await stop();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key)) delete env[key];
  child = spawn(process.execPath, ['--require', './scripts/reservation-table-day-clock-preload.cjs', 'server.js'], {
    cwd: root, windowsHide: true, env: { ...env, TZ: 'UTC', PGOPTIONS: '-c timezone=' + sessionTimezone, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', DATABASE_URL: url(database), VENUE_ID: venue, API_RATE_LIMIT: '10000', RESERVATION_QA_CLOCK_FILE: clockFile, RESERVATION_QA_LEGACY_BASELINE: baseline ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('QA startup timeout')), 20000);
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error('QA server exited: ' + output)); });
    child.stdout.on('data', data => { output += data; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); } });
    child.stderr.on('data', data => { output += data; });
  });
}
async function main() {
  await inspect(); admin = new Pool({ connectionString: url(config.database), max: 1 });
  eq((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0, 'fresh database');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  pool = new Pool({ connectionString: url(database), max: 3 });
  await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(name => name.endsWith('.sql')).sort()) await pool.query(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  const fixtures = [
    { label: 'venue override', timezone: 'Asia/Yekaterinburg', orgTimezone: 'UTC', before: '2026-10-10T18:58:00.000Z', after: '2026-10-10T19:02:00.000Z' },
    { label: 'organization fallback', timezone: '', orgTimezone: 'Europe/Moscow', before: '2026-10-10T20:58:00.000Z', after: '2026-10-10T21:02:00.000Z' },
    { label: 'default fallback', timezone: '', orgTimezone: '', before: '2026-10-10T18:58:00.000Z', after: '2026-10-10T19:02:00.000Z' },
    { label: 'negative UTC offset', timezone: 'America/Los_Angeles', orgTimezone: 'UTC', before: '2026-10-11T06:58:00.000Z', after: '2026-10-11T07:02:00.000Z' },
    { label: 'invalid venue fallback', timezone: 'Invalid/Zone', orgTimezone: 'Europe/Moscow', effectiveTimezone: 'Europe/Moscow', before: '2026-10-10T20:58:00.000Z', after: '2026-10-10T21:02:00.000Z' },
    { label: 'invalid both fallback', timezone: 'Invalid/Zone', orgTimezone: 'Invalid/Zone', effectiveTimezone: 'Asia/Yekaterinburg', before: '2026-10-10T18:58:00.000Z', after: '2026-10-10T19:02:00.000Z' },
  ];
  for (const f of fixtures) {
    Object.assign(f, { org: randomUUID(), venue: randomUUID(), owner: randomUUID(), zone: randomUUID() });
    await pool.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [f.org, 'Reservation day QA', 'qa-' + f.org, f.orgTimezone]);
    await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)", [f.org]);
    await pool.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [f.venue, f.org, f.label, f.timezone]);
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'QA owner',$4,$5,'owner')", [f.owner, f.venue, f.org, 'qa_' + f.owner, hash]);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [f.org, f.owner]);
    await pool.query("INSERT INTO zones(id,venue_id,name) VALUES($1,$2,'QA zone')", [f.zone, f.venue]);
  }
  for (const sessionTimezone of ['UTC', 'Pacific/Honolulu']) {
    clock(fixtures[0].before); await start(fixtures[0].venue, sessionTimezone);
    for (const f of fixtures) {
      clock(f.before);
      const token = (await api('/api/login', '', 'POST', { username: 'qa_' + f.owner, password })).token;
      if (sessionTimezone === 'UTC') await api('/api/shifts', token, 'POST', { openingCash: 0 }, 201);
      const table = async () => {
        const id = randomUUID(); await pool.query("INSERT INTO tables(id,zone_id,name,capacity,max_capacity) VALUES($1,$2,'QA table',4,4)", [id, f.zone]); return id;
      };
      const status = async id => (await pool.query('SELECT status FROM tables WHERE id=$1', [id])).rows[0].status;
      const reserve = (id, date, time = '12:00') => api('/api/reservations', token, 'POST', { guestName: 'Synthetic day QA', tableId: id, date, time, guests: 2, deposit: 0 }, 201);
      const order = id => api('/api/orders', token, 'POST', { tableId: id }, 201);
      for (const side of ['after', 'before']) {
        clock(f[side]); const date = side === 'before' ? '2026-10-10' : '2026-10-11', time = side === 'before' ? '23:59' : '12:00';
        for (const action of ['delete', 'cancel', 'transfer', 'payment', 'close']) {
          for (const relevant of [true, false]) {
            const id = await table(), bookingDate = relevant ? date : '2026-10-12';
            const reservation = await reserve(id, bookingDate, time);
            const stored = (await pool.query("SELECT to_char(starts_at AT TIME ZONE $2,'YYYY-MM-DD HH24:MI') AS local FROM reservations WHERE id=$1", [reservation.id, f.effectiveTimezone || f.timezone || f.orgTimezone || 'Asia/Yekaterinburg'])).rows[0];
            eq(stored.local, bookingDate + ' ' + time, 'stored instant uses effective venue timezone');
            const listed = (await api('/api/reservations?date=' + bookingDate, token)).items.find(row => row.id === reservation.id);
            eq([listed?.date, listed?.time], [bookingDate, time], f.label + ' calendar roundtrip');
            const o = await order(id);
            if (action === 'delete') await api('/api/orders/' + o.id, token, 'DELETE', { comment: 'Synthetic timezone QA', writeoff: false });
            if (action === 'cancel') await api(`/api/orders/${o.id}/status`, token, 'POST', { status: 'cancelled' });
            if (action === 'transfer') await api(`/api/orders/${o.id}/transfer`, token, 'POST', { tableId: await table() });
            if (action === 'close') await api(`/api/orders/${o.id}/close`, token, 'POST', { paymentMethod: 'cash' });
            if (action === 'payment') {
              const product = await api('/api/products', token, 'POST', { name: 'QA nonstock ' + randomUUID(), category: 'Бар', price: 1, inventoryMode: 'non_stock' }, 201);
              await api(`/api/orders/${o.id}/items`, token, 'POST', { productId: product.id, quantity: 1 }, 201);
              await api(`/api/orders/${o.id}/payments`, token, 'POST', { method: 'cash', amount: 1, idempotencyKey: randomUUID() }, 201);
            }
            eq(await status(id), relevant ? 'reserved' : 'free', `${sessionTimezone}/${f.label}/${side}/${action}/relevant=${relevant}`);
          }
        }
        const a = await table(), b = await table(), r = await reserve(a, date, time);
        await api('/api/reservations/' + r.id, token, 'PATCH', { guestName: 'Edited QA', tableId: b, date, time, guests: 2, deposit: 0 });
        eq(await status(a), 'free', 'reservation move releases original table');
        eq(await status(b), 'reserved', 'reservation move reserves current-day target table');
        await api('/api/reservations/' + r.id + '/cancel', token, 'POST', {});
        eq(await status(b), 'free', 'cancel releases target table');
        const guardTable = await table(); await reserve(guardTable, date, time); const first = await order(guardTable);
        const otherId = randomUUID(); await pool.query('INSERT INTO orders(id,venue_id,table_id,opened_by) VALUES($1,$2,$3,$4)', [otherId, f.venue, guardTable, f.owner]);
        await api(`/api/orders/${first.id}/status`, token, 'POST', { status: 'cancelled' });
        eq(await status(guardTable), 'occupied', 'other active order protects occupancy');
        await pool.query("UPDATE tables SET status='blocked' WHERE id=$1", [guardTable]);
        await api(`/api/orders/${otherId}/status`, token, 'POST', { status: 'cancelled' });
        eq(await status(guardTable), 'blocked', 'blocked table protected');
        const foreign = fixtures.find(entry => entry !== f);
        const foreignTable = randomUUID(); await pool.query("INSERT INTO tables(id,zone_id,name,capacity,max_capacity) VALUES($1,$2,'Foreign QA',4,4)", [foreignTable, foreign.zone]);
        await api('/api/reservations', token, 'POST', { guestName: 'Foreign QA', tableId: foreignTable, date, time, guests: 2 }, 400);
        eq(await status(foreignTable), 'free', 'foreign table unchanged');
        await api('/api/reservations', token, 'POST', { guestName: 'Past QA', tableId: await table(), date: '2026-10-10', time: '00:00', guests: 2 }, 400);
      }
      clock(f.before); const previousDayTable = await table(); await reserve(previousDayTable, '2026-10-10', '23:59');
      const previousDayOrder = await order(previousDayTable); clock(f.after);
      await api(`/api/orders/${previousDayOrder.id}/status`, token, 'POST', { status: 'cancelled' });
      eq(await status(previousDayTable), 'free', 'yesterday reservation does not reserve table after venue midnight');
    }
  }
  console.log(`RESERVATION TABLE DAY POSTGRES QA: PASS (${checks} assertions; real HTTP + PostgreSQL, ${fixtures.length} timezone configurations, 2 session timezones, before/after midnight, 5 order release paths, edit/cancel and guards)`);
}
main().catch(error => { console.error(guards.safeText(error.stack, config)); process.exitCode = 1; }).finally(async () => {
  try {
    await stop(); if (pool) await pool.end();
    if (created) { await inspect(); assert.match(database, /^audit_qa_[a-f0-9]{16}$/); await admin.query(`DROP DATABASE "${database}"`); console.log('CLEANUP PASS owned reservation-day QA database removed'); }
    if (fs.existsSync(clockFile)) fs.unlinkSync(clockFile);
  } catch (error) { console.error('QA cleanup failed: ' + guards.safeText(error.message, config)); process.exitCode = 1; }
  finally { if (admin) await admin.end(); }
});
