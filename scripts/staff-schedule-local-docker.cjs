'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
// Explicit Windows-local named pipe: never inherit a remote Docker context.
const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
function docker(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  const result = spawnSync('docker', ['--host', endpoint, ...args], { encoding: 'utf8', windowsHide: true, env });
  if (result.status !== 0) throw new Error(`Local Docker ${args[0]} failed; no fallback or recreation attempted`);
  return result.stdout.trim();
}
function exclusive(item, identity) {
  assert.equal(item.Id, identity.containerId, 'Container identity changed');
  assert.equal(item.Mounts[0].Name, identity.volume, 'Volume identity changed');
  const owners = docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${identity.volume}`]).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(owners, [identity.containerId], 'Volume is shared or detached');
}
module.exports = { docker, exclusive, endpoint };
