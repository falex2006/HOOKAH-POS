'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
function validateContainer(item, name, port, persistent, volume) {
  const expectedName = persistent ? 'hookah-full-local-qa-20261001' : 'hookah-full-regression-qa-20261001';
  const expectedPort = persistent ? 31930 : 31931;
  if (name !== expectedName || port !== expectedPort || volume !== 'hookah-full-local-qa-data-20261001') throw new Error('Refusing undeclared QA target');
  if (item?.Name !== `/${name}` || item.Config?.Labels?.['hookah.local-qa'] !== '20261001') throw new Error('Refusing unrelated container');
  if (item.Config.Image !== 'postgres:16-alpine') throw new Error('Refusing unrelated image');
  const ports = item.HostConfig?.PortBindings || {};
  const bindings = ports['5432/tcp'] || [];
  if (Object.keys(ports).length !== 1 || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || Number(bindings[0].HostPort) !== port) throw new Error('Refusing non-loopback QA PostgreSQL');
  if (item.State?.Running) {
    const livePorts = item.NetworkSettings?.Ports || {};
    const live = livePorts['5432/tcp'] || [];
    if (Object.keys(livePorts).some(key => key !== '5432/tcp') || live.length !== 1 || live[0].HostIp !== '127.0.0.1' || Number(live[0].HostPort) !== port) throw new Error('Refusing unexpected live QA PostgreSQL binding');
  }
  const mounts = item.Mounts || [];
  if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Destination !== '/var/lib/postgresql/data' || mounts[0].RW !== true) throw new Error('Refusing non-dedicated PostgreSQL data mount');
  if (persistent) {
    if (item.HostConfig.AutoRemove !== false || mounts[0].Name !== volume) throw new Error('Persistent QA requires its exact named volume and must not auto-remove');
  } else if (item.HostConfig.AutoRemove !== true || !/^[a-f0-9]{64}$/i.test(String(mounts[0].Name || '')) || (item.HostConfig.Binds || []).length) throw new Error('Regression QA requires auto-remove with one anonymous data volume');
}
function checkGuards() {
  const volume = 'hookah-full-local-qa-data-20261001';
  const fixture = persistent => ({ Name: persistent ? '/hookah-full-local-qa-20261001' : '/hookah-full-regression-qa-20261001', Config: { Image: 'postgres:16-alpine', Labels: { 'hookah.local-qa': '20261001' } }, State: { Running: true }, HostConfig: { AutoRemove: !persistent, Binds: [], PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: persistent ? '31930' : '31931' }] } }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: persistent ? '31930' : '31931' }] } }, Mounts: [{ Type: 'volume', Name: persistent ? volume : 'a'.repeat(64), Destination: '/var/lib/postgresql/data', RW: true }] });
  let checks = 0;
  for (const persistent of [true,false]) {
    const item = fixture(persistent); const args = [item.Name.slice(1),persistent ? 31930 : 31931,persistent,volume];
    validateContainer(item,...args); checks++;
    for(const change of [copy=>copy.Name='/unrelated',copy=>copy.Config.Labels['hookah.local-qa']='other',copy=>copy.Config.Image='postgres:other',copy=>copy.HostConfig.PortBindings['5432/tcp'][0].HostIp='0.0.0.0',copy=>copy.NetworkSettings.Ports['5432/tcp'][0].HostIp='::',copy=>copy.HostConfig.PortBindings['5432/tcp'][0].HostPort='5432',copy=>copy.Mounts[0].Type='bind',copy=>copy.Mounts[0].Name='production-data',copy=>copy.Mounts[0].Destination='/other',copy=>copy.Mounts[0].RW=false,copy=>copy.Mounts.push({...copy.Mounts[0]}),copy=>copy.HostConfig.AutoRemove=persistent]) {
      const invalid=structuredClone(item); change(invalid); assert.throws(()=>validateContainer(invalid,...args)); checks++;
    }
    assert.throws(()=>validateContainer(item,'localhost',args[1],persistent,volume)); checks++;
    assert.throws(()=>validateContainer(item,args[0],args[1],persistent,'production-volume')); checks++;
  }
  console.log(`LOCAL FULL QA CONTAINER GUARDS: PASS (${checks} positive/negative cases; no Docker or database mutations)`);
}
if (process.argv.includes('--check-guards')) { checkGuards(); process.exit(0); }
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'tmp', 'full-local-qa');
fs.mkdirSync(folder, { recursive: true });
const file = path.join(folder, 'runtime.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  container: 'hookah-full-local-qa-20261001', volume: 'hookah-full-local-qa-data-20261001',
  regressionContainer: 'hookah-full-regression-qa-20261001', dbPort: 31930, regressionPort: 31931, appPort: 31932,
  database: 'hookah_local_qa', dbUser: 'hookah_qa', dbPassword: crypto.randomBytes(24).toString('hex'),
  password: crypto.randomBytes(18).toString('base64url'), pin: '2468', platformLogin: 'qa-platform@example.test',
  appKey: crypto.randomBytes(32).toString('hex')
};
if (config.database !== 'hookah_local_qa' || config.dbPort !== 31930 || config.regressionPort !== 31931 || config.appPort !== 31932 || config.container !== 'hookah-full-local-qa-20261001' || config.regressionContainer !== 'hookah-full-regression-qa-20261001' || config.volume !== 'hookah-full-local-qa-data-20261001') throw new Error('Only the dedicated local QA targets are accepted');
if (process.argv.includes('--inspect-guards')) {
  for (const [name, port, persistent] of [[config.container,config.dbPort,true],[config.regressionContainer,config.regressionPort,false]]) {
    const inspected = spawnSync('docker',['inspect',name],{encoding:'utf8',windowsHide:true});
    if(inspected.status!==0) throw new Error('Declared local QA container unavailable');
    validateContainer(JSON.parse(inspected.stdout)[0],name,port,persistent,config.volume);
  }
  console.log('LOCAL FULL QA LIVE CONTAINER GUARDS: PASS (read-only inspect; exact persistent/anonymous volume ownership)');
  process.exit(0);
}
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function ensureContainer(name, port, persistent) {
  const existing = spawnSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true });
  if (existing.status === 0) {
    const item = JSON.parse(existing.stdout)[0];
    validateContainer(item, name, port, persistent, config.volume);
    if (!item.State.Running) { docker(['start', name]); validateContainer(JSON.parse(docker(['inspect', name]))[0], name, port, persistent, config.volume); }
    return;
  }
  docker(['run', '-d', ...(persistent ? [] : ['--rm']), '--name', name, '--label', 'hookah.local-qa=20261001',
    '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_USER', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB',
    ...(persistent ? ['-v', `${config.volume}:/var/lib/postgresql/data`] : []), 'postgres:16-alpine'], {
      env: { ...process.env, POSTGRES_USER: config.dbUser, POSTGRES_PASSWORD: config.dbPassword, POSTGRES_DB: config.database }
    });
  validateContainer(JSON.parse(docker(['inspect', name]))[0], name, port, persistent, config.volume);
}
const url = (port) => {
  const target = new URL(`postgresql://127.0.0.1:${port}/${config.database}`);
  target.username = config.dbUser; target.password = config.dbPassword;
  return target.href;
};
async function init(port) {
  let ready = false;
  for (let n = 0; n < 40 && !ready; n++) {
    const probe = new Client({ connectionString: url(port) });
    try { await probe.connect(); ready = true; } catch { await new Promise(r => setTimeout(r, 250)); }
    finally { await probe.end().catch(() => {}); }
  }
  if (!ready) throw new Error('Local QA PostgreSQL not ready');
  const client = new Client({ connectionString: url(port) });
  await client.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query("SELECT to_regclass('public.venues') AS table_name");
    if (!exists.rows[0].table_name) await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
    }
    await client.query('COMMIT');
    console.log(`Initialized isolated local QA PostgreSQL on loopback:${port}`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { await client.end(); }
}
(async () => {
  const regressionOnly = process.argv.includes('--regression-only');
  if (!regressionOnly) ensureContainer(config.container, config.dbPort, true);
  ensureContainer(config.regressionContainer, config.regressionPort, false);
  if (!regressionOnly) await init(config.dbPort);
  await init(config.regressionPort);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
