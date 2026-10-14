'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { docker, exclusive } = require('./staff-schedule-local-docker.cjs');
const { fixed, validate } = require('./staff-schedule-local-setup.cjs');
const folder = path.join(__dirname, '..', 'qa-artifacts', 'staff-schedule');
function config() {
  const c = JSON.parse(fs.readFileSync(path.join(folder, 'runtime.json'), 'utf8'));
  for (const [key, value] of Object.entries(fixed)) assert.equal(c[key], value);
  const item = JSON.parse(docker(['inspect', fixed.container]))[0];
  validate(item);
  exclusive(item, JSON.parse(fs.readFileSync(path.join(folder, 'identity.json'), 'utf8')));
  assert.equal(item.State.Running, true, 'Dedicated schedule container stopped');
  assert.deepEqual(item.NetworkSettings.Ports['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(fixed.dbPort) }]);
  return c;
}
const options = c => ({ host: '127.0.0.1', port: c.dbPort, database: c.database, user: c.dbUser, password: c.dbPassword });
module.exports = { config, folder, options };
