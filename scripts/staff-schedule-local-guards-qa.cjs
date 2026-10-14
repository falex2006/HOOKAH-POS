'use strict';
const assert = require('node:assert/strict');
const { validate, fixed } = require('./staff-schedule-local-setup.cjs');
const good = {
  Name: `/${fixed.container}`, Config: { Image: fixed.image, Labels: { 'hookah.local-qa': fixed.label } },
  HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(fixed.dbPort) }] }, AutoRemove: false },
  Mounts: [{ Type: 'volume', Destination: '/var/lib/postgresql/data', Name: 'a'.repeat(64) }]
};
validate(good);
const changes = [
  x => x.Name = '/production', x => x.Config.Image = 'postgres:latest',
  x => x.Config.Labels['hookah.local-qa'] = 'other',
  x => x.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0',
  x => x.HostConfig.PortBindings['5432/tcp'][0].HostPort = '5432',
  x => x.HostConfig.PortBindings['5433/tcp'] = [],
  x => x.HostConfig.AutoRemove = true, x => x.Mounts.push({}),
  x => x.Mounts[0].Type = 'bind', x => x.Mounts[0].Name = 'shared-volume',
  x => x.Mounts[0].Destination = '/other', x => x.HostConfig.Binds = ['/shared:/data']
];
for (const change of changes) { const bad = structuredClone(good); change(bad); assert.throws(() => validate(bad)); }
console.log(`SCHEDULE LOCAL GUARDS: PASS (${changes.length + 1} cases; no database writes)`);
