'use strict';
// Dedicated synthetic-data runtime. Never reads .env or accepts an external database URL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { docker, exclusive } = require('./staff-schedule-local-docker.cjs');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'qa-artifacts', 'staff-schedule');
const file = path.join(folder, 'runtime.json');
const fixed = {
  container: 'hookah-staff-schedule-local-20261013', database: 'staff_schedule_qa',
  dbUser: 'schedule_qa', dbPort: 31943, appPort: 31944,
  label: 'staff-schedule-20261013', image: 'postgres:16-alpine'
};
function validate(item) {
  assert.equal(item.Name, `/${fixed.container}`);
  assert.equal(item.Config.Image, fixed.image);
  assert.equal(item.Config.Labels['hookah.local-qa'], fixed.label);
  assert.deepEqual(item.HostConfig.PortBindings, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(fixed.dbPort) }] });
  assert.equal(item.HostConfig.AutoRemove, false);
  assert.equal(item.Mounts.length, 1);
  assert.equal(item.Mounts[0].Type, 'volume');
  assert.equal(item.Mounts[0].Destination, '/var/lib/postgresql/data');
  assert.match(item.Mounts[0].Name, /^[a-f0-9]{64}$/);
  assert.equal((item.HostConfig.Binds || []).length, 0);
}
async function main() {
  fs.mkdirSync(folder, { recursive: true });
  const ids = docker(['ps', '-aq', '--filter', `name=^/${fixed.container}$`]);
  const exists = Boolean(ids);
  if (exists && !fs.existsSync(file)) throw new Error('Existing container without matching local config: refusing to adopt');
  if (!exists && fs.existsSync(file)) throw new Error('Runtime container missing: preserve the previous volume and restore explicitly; refusing empty replacement');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
    ...fixed, dbPassword: crypto.randomBytes(24).toString('hex'), appKey: crypto.randomBytes(32).toString('hex')
  };
  for (const [key, value] of Object.entries(fixed)) assert.equal(config[key], value, `Unexpected local target ${key}`);
  const identityFile = path.join(folder, 'identity.json');
  if (exists) {
    const item = JSON.parse(docker(['inspect', fixed.container]))[0];
    validate(item);
    exclusive(item, JSON.parse(fs.readFileSync(identityFile, 'utf8')));
    if (!item.State.Running) docker(['start', fixed.container]);
  } else {
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600, flag: fs.existsSync(file) ? 'w' : 'wx' });
    docker(['run', '-d', '--name', fixed.container, '--label', `hookah.local-qa=${fixed.label}`,
      '-p', `127.0.0.1:${fixed.dbPort}:5432`, '-e', 'POSTGRES_USER', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB', fixed.image],
    { POSTGRES_USER: fixed.dbUser, POSTGRES_PASSWORD: config.dbPassword, POSTGRES_DB: fixed.database });
    const created = JSON.parse(docker(['inspect', fixed.container]))[0];
    validate(created);
    const identity = { containerId: created.Id, volume: created.Mounts[0].Name };
    exclusive(created, identity);
    fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), { flag: 'wx' });
  }
  validate(JSON.parse(docker(['inspect', fixed.container]))[0]);
  const { Client } = require('pg');
  const options = { host: '127.0.0.1', port: fixed.dbPort, database: fixed.database, user: fixed.dbUser, password: config.dbPassword };
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const probe = new Client(options);
    try { await probe.connect(); ready = true; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    finally { await probe.end().catch(() => {}); }
  }
  assert.ok(ready, 'Dedicated PostgreSQL unavailable');
  const client = new Client(options);
  await client.connect();
  try {
    await client.query('BEGIN');
    if (!(await client.query("SELECT to_regclass('public.venues') AS name")).rows[0].name) {
      await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    }
    await client.query('CREATE TABLE IF NOT EXISTS schedule_qa_migrations (name text PRIMARY KEY, digest text NOT NULL)');
    let applied = 0;
    for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(root, 'migrations', name), 'utf8');
      const digest = crypto.createHash('sha256').update(sql).digest('hex');
      const previous = (await client.query('SELECT digest FROM schedule_qa_migrations WHERE name=$1', [name])).rows[0];
      if (previous) { assert.equal(previous.digest, digest, `Applied migration modified: ${name}`); continue; }
      await client.query(sql);
      await client.query('INSERT INTO schedule_qa_migrations VALUES ($1,$2)', [name, digest]);
      applied++;
    }
    await client.query('COMMIT');
    console.log(`Schedule isolated PostgreSQL ready: loopback:${fixed.dbPort}; applied ${applied} migrations; no shared database used.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
module.exports = { validate, fixed };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
