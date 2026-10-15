'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { config, folder } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function main() {
  const runtime = config();
  const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const root = path.join(__dirname, '..');
  let server = null;
  if (!(await listening(runtime.appPort))) {
    server = spawn(process.execPath, ['server.js'], {
      cwd: root, env: isolatedEnvironment(runtime, fixtures), stdio: 'ignore', windowsHide: true
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error('Isolated QA app exited before readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.appPort}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    if (!ready) throw new Error('Isolated QA app did not become ready');
  }
  try {
    const result = spawnSync(process.execPath, ['scripts/staff-schedule-acceptance-qa.cjs'], {
      cwd: root, env: process.env, encoding: 'utf8', windowsHide: true,
      timeout: 3600000, maxBuffer: 4 * 1024 * 1024
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
    if (result.status === 0) {
      const databaseUrl = `postgresql://${encodeURIComponent(runtime.dbUser)}:${encodeURIComponent(runtime.dbPassword)}@127.0.0.1:${runtime.dbPort}/${runtime.database}`;
      const env = { ...process.env, RECIPE_DEPLETION_PG_TEST_DATABASE_URL: databaseUrl };
      delete env.LOCAL_FULL_PG_OWNED_DATABASE;
      const premix = spawnSync(process.execPath, ['scripts/recipe-depletion-pg-runtime-qa.mjs'], {
        cwd: root, env, encoding: 'utf8', windowsHide: true,
        timeout: 240000, maxBuffer: 4 * 1024 * 1024
      });
      if (premix.stdout) process.stdout.write(premix.stdout);
      if (premix.stderr) process.stderr.write(premix.stderr);
      if (premix.error) throw premix.error;
      if (premix.status !== 0) process.exitCode = premix.status || 1;
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
