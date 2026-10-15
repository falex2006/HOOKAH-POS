'use strict';
// Foreground local preview. No adoption/reset of an existing database or server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createRuntime, freePort, startServer, stopServer, root } = require('./staff-attendance-http-qa.cjs');
async function main() {
  assert(process.argv.includes('--run'), 'Explicit --run --tag=<unique-tag> required');
  const tag = process.argv.find(arg => arg.startsWith('--tag='))?.slice(6);
  assert.match(tag || '', /^[a-z0-9_]{1,32}$/, 'Use a unique lowercase tag');
  const directory = path.join(root, 'qa-artifacts', 'staffattendance');
  const manifest = path.join(directory, `${tag}.json`);
  execFileSync('git', ['check-ignore', '--quiet', '--', manifest], { cwd: root, stdio: 'ignore' });
  assert(!fs.existsSync(manifest), 'Existing manifest preserved; choose a new tag');
  await freePort(31946); // Fail closed if occupied; never stop any existing process.
  const runtime = await createRuntime(`attendance_preview_${tag}`, 'Attendance-QA-only-2026!');
  let child, retained = false;
  try {
    child = await startServer(runtime, 31946);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identityPath = path.join(root, 'qa-artifacts', 'staff-schedule', 'identity.json');
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ purpose: 'isolated-attendance-preview', database: runtime.cfg.database,
      identity, port: 31946, host: '127.0.0.1', pid: child.pid, root, createdAt: new Date().toISOString(),
      fixtures: runtime.fixtures }, null, 2), { flag: 'wx', mode: 0o600 });
    await runtime.retain(); retained = true;
    console.log(JSON.stringify({ preview: 'READY', url: 'http://127.0.0.1:31946/admin#staff-schedule', manifest,
      database: runtime.cfg.database, note: 'Credentials only in ignored private manifest. Ctrl+C stops owned server; database is retained.' }));
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; stopServer(child).catch(() => { process.exitCode = 1; }); } };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await once(child, 'exit'); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally {
    await stopServer(child);
    if (!retained) await runtime.dispose();
  }
}
main().catch(error => { console.error(JSON.stringify({ preview: 'FAIL', code: error.code || error.name, message: error.message })); process.exitCode = 1; });
