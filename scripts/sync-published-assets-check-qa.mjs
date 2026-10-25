import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const before = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
execFileSync(process.execPath, ['scripts/sync-published-assets.mjs', '--check'], { cwd: root, stdio: 'pipe' });
const after = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
assert.equal(after, before, '--check must not change tracked workspace state');

const unknown = spawnSync(process.execPath, ['scripts/sync-published-assets.mjs', '--unknown-option'], { cwd: root, encoding: 'utf8' });
assert.notEqual(unknown.status, 0, 'unknown options must fail');
assert.match(`${unknown.stdout}${unknown.stderr}`, /Unknown sync option/);

const fixture = mkdtempSync(resolve(tmpdir(), 'hookah-sync-check-qa-'));
try {
  const excludedRoots = new Set(['.git', 'node_modules', 'tmp', 'docs']);
  cpSync(root, fixture, {
    recursive: true,
    filter(source) {
      const rel = relative(root, source);
      if (!rel) return true;
      const first = rel.split(/[\\/]/, 1)[0];
      return !excludedRoots.has(first) && !first.startsWith('.env');
    },
  });
  const staleAsset = resolve(fixture, 'dist', 'app.js');
  writeFileSync(staleAsset, `${readFileSync(staleAsset, 'utf8')}\n// intentional QA drift\n`);
  const mismatch = spawnSync(process.execPath, ['scripts/sync-published-assets.mjs', '--check'], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0, 'a stale published asset must fail --check');
  assert.match(`${mismatch.stdout}${mismatch.stderr}`, /Published assets are not synchronized/);
  assert.match(`${mismatch.stdout}${mismatch.stderr}`, /dist\/app\.js/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('SYNC PUBLISHED ASSETS CHECK QA: PASS (read-only, unknown option rejection, mismatch detection).');
