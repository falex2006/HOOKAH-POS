'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const env = isolatedEnvironment({ appPort: 31944, dbPort: 31943, dbUser: 'qa', dbPassword: 'test', database: 'qa', appKey: 'test' }, { venues: ['test'] },
  { Path: 'safe', SYSTEMROOT: 'Windows', DATABASE_URL: 'remote', NODE_OPTIONS: '--require malicious', SMTP_HOST: 'remote', HTTP_PROXY: 'remote', AUTH_REQUIRED: 'false' });
assert.equal(env.Path, 'safe');
for (const key of ['NODE_OPTIONS', 'SMTP_HOST', 'HTTP_PROXY']) assert.equal(env[key], undefined);
assert.equal(env.AUTH_REQUIRED, 'true');
assert.equal(env.SKIP_LOCAL_ENV, 'true');
assert.match(env.DATABASE_URL, /@127\.0\.0\.1:31943/);
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const loader = source.slice(source.indexOf('// Local development convenience:'), source.indexOf('const repositories = createRepositories();'));
let reads = 0;
vm.runInNewContext(loader, { root: '.', path, process: { env }, fs: { existsSync: () => true, readFileSync: () => { reads++; return 'SMTP_HOST=remote'; } } });
assert.equal(reads, 0);
console.log('SCHEDULE ENV: PASS (allowlist, enforced auth/loopback, no inherited hooks/proxies, .env bypass)');
