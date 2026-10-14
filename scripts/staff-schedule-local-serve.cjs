'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { config, folder } = require('./staff-schedule-local-config.cjs');
const c = config();
const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
assert.equal(fixtures.database, c.database);
const { spawn } = require('node:child_process');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: isolatedEnvironment(c, fixtures), cwd: path.join(__dirname, '..'), stdio: 'inherit', windowsHide: true
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Local schedule server failed to start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
