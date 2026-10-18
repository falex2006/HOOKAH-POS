import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const saasOwned = [
  /^platform\.html$/,
  /^platform\.js$/,
  /^platform\.css$/,
  /^dist\/platform(?:\.html|\.js|\.css)$/,
  /^dist\/platform\//,
  /^scripts\/(?:platform-saas-contract|local-platform-organization-contract|local-saas-[^/]+|saas-[^/]+)\.mjs$/,
  /^migrations\/011_platform_owner\.sql$/,
];

const posOwned = [
  /^(?:index|orders|clients|reservations|delivery|inventory|finance|finance-categories|finance-report|integrations)\.html$/,
  /^dist\/(?:index|orders|clients|reservations|delivery|inventory|finance|finance-categories|finance-report|integrations)(?:\.html|\/)/,
];

const sharedExamples = [
  'server.js', 'db.js', 'schema.sql', 'style.css', 'login.html', 'login.js',
  'portal.js', 'app.js', 'admin.html', 'admin.js', 'network.html',
  'migrations/009_saas_foundation.sql', 'migrations/046_organization_updated_at.sql',
];

const matches = (patterns, path) => patterns.some((pattern) => pattern.test(path));
const normalize = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '');
const classify = (path) => {
  const normalized = normalize(path);
  if (normalized === 'scripts/saas-pos-boundary-contract.mjs') return 'shared';
  if (matches(saasOwned, normalized)) return 'saas';
  if (matches(posOwned, normalized)) return 'pos';
  return 'shared';
};

function checkPaths(paths) {
  const categories = new Set(paths.map(classify));
  const overlap = categories.has('saas') && categories.has('pos');
  return { overlap, categories };
}

function isPortalCacheRevisionOnly(before, after) {
  if (!/portal\.js\?rev=\d+/.test(before) || !/portal\.js\?rev=\d+/.test(after) || before === after) return false;
  const normalizePortalRevision = (value) => value.replace(/portal\.js\?rev=\d+/g, 'portal.js?rev=<revision>');
  return normalizePortalRevision(before) === normalizePortalRevision(after);
}

function isSaasSharedCssRevisionOnly(path, before, after) {
  if (!['platform.html', 'dist/platform.html', 'dist/platform/index.html'].includes(path)) return false;
  // Compare Git text, independent of Windows checkout line endings.
  before = before.replace(/\r\n/g, '\n');
  after = after.replace(/\r\n/g, '\n');
  const url = /\/style\.css\?rev=\d+(?=["'])/g;
  if (!before.match(url)?.length || !after.match(url)?.length || before === after) return false;
  return before.replace(url, '/style.css?rev=<revision>') === after.replace(url, '/style.css?rev=<revision>');
}

function selfTest() {
  assert.equal(classify('scripts/saas-pos-boundary-contract.mjs'), 'shared');
  assert.equal(isSaasSharedCssRevisionOnly('platform.html', '<link href="/style.css?rev=403">\n', '<link href="/style.css?rev=405">\r\n'), true);
  const oldCss = '<link href="/style.css?rev=403"><main></main>';
  const newCss = '<link href="/style.css?rev=405"><main></main>';
  for (const path of ['platform.html', 'dist/platform.html', 'dist/platform/index.html']) {
    assert.equal(isSaasSharedCssRevisionOnly(path, oldCss, newCss), true);
    for (const changed of [oldCss, newCss + ' ', newCss.replace('<main>', '<main hidden>'), newCss.replace('/style.css', '/platform.css'), newCss.replace('405', '405evil')]) {
      assert.equal(isSaasSharedCssRevisionOnly(path, oldCss, changed), false);
    }
  }
  assert.equal(isSaasSharedCssRevisionOnly('dist/platform/other.html', oldCss, newCss), false);
  assert.equal(isSaasSharedCssRevisionOnly('platform.js', oldCss, newCss), false);
  assert.equal(isSaasSharedCssRevisionOnly('platform.html', oldCss + '<script src="/platform.js?rev=8"></script>', newCss + '<script src="/platform.js?rev=9"></script>'), false);
  for (const file of sharedExamples) assert.equal(classify(file), 'shared', `${file} must remain explicitly shared`);
  assert.equal(classify('platform.html'), 'saas');
  assert.equal(classify('dist/platform/index.html'), 'saas');
  assert.equal(classify('platform.css'), 'saas');
  assert.equal(classify('dist/platform.css'), 'saas');
  assert.equal(classify('orders.html'), 'pos');
  assert.equal(classify('dist/inventory/index.html'), 'pos');
  assert.equal(checkPaths(['platform.js', 'docs/SAAS_POS_BOUNDARIES.md']).overlap, false,
    'a SaaS change with documentation is allowed');
  assert.equal(checkPaths(['platform.js', 'server.js', 'schema.sql']).overlap, false,
    'shared API/auth/models can be changed with SaaS when shared contracts are run');
  assert.equal(checkPaths(['platform.js', 'orders.html']).overlap, true,
    'a SaaS patch must not edit a POS page in the same change');
  assert.equal(checkPaths(['dist/platform.js', 'dist/inventory/index.html']).overlap, true,
    'published SaaS and POS pages are still separate ownership zones');
  assert.equal(checkPaths(['platform.html', 'style.css', 'admin.html']).overlap, false,
    'shared style and admin surfaces require shared contracts but are not POS-only paths');
  assert.equal(isPortalCacheRevisionOnly('<script src="/portal.js?rev=425"></script>', '<script src="/portal.js?rev=426"></script>'), true,
    'cache-busting revision changes do not alter POS markup or behavior');
  assert.equal(isPortalCacheRevisionOnly('<script src="/portal.js?rev=425"></script><main></main>', '<script src="/portal.js?rev=426"></script><main><button>New</button></main>'), false,
    'POS markup changes remain forbidden alongside SaaS work');
  console.log('SAAS/POS BOUNDARY SELF-TEST: PASS (ownership map, shared paths, mixed-diff rejection)');
}

selfTest();

const args = process.argv.slice(2);
const workingTree = args[0] === '--working-tree';
const [base, head] = workingTree ? ['HEAD', 'WORKTREE'] : args;
if (!base && !head) process.exit(0);
assert.ok(base && head, 'Provide both base and head Git revisions, --working-tree, or neither for self-test only');

const diffArgs = workingTree
  ? ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD', '--']
  : ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${base}...${head}`, '--'];
const diff = spawnSync('git', diffArgs, {
  encoding: 'utf8',
  windowsHide: true,
});
if (diff.error) throw diff.error;
assert.equal(diff.status, 0, `Unable to inspect change range ${base}...${head}: ${diff.stderr || ''}`);
const paths = diff.stdout.split(/\r?\n/).filter(Boolean).map(normalize);
if (workingTree) {
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true });
  if (untracked.error) throw untracked.error;
  assert.equal(untracked.status, 0, `Unable to list untracked files: ${untracked.stderr || ''}`);
  paths.push(...untracked.stdout.split(/\r?\n/).filter(Boolean).map(normalize));
}
const saasPaths = paths.filter((path) => classify(path) === 'saas');
const posPaths = paths.filter((path) => classify(path) === 'pos');
const sharedPaths = paths.filter((path) => classify(path) === 'shared');
const readAtRevision = (revision, path) => workingTree && revision === 'WORKTREE'
  ? { status: 0, stdout: readFileSync(path, 'utf8') }
  : spawnSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const cacheOnlyPosPaths = posPaths.filter((path) => {
  const before = readAtRevision(base, path);
  const after = readAtRevision(head, path);
  return before.status === 0 && after.status === 0 && isPortalCacheRevisionOnly(before.stdout, after.stdout);
});
const behaviorPosPaths = posPaths.filter((path) => !cacheOnlyPosPaths.includes(path));
const cacheOnlySaasPaths = saasPaths.filter((path) => {
  const before = readAtRevision(base, path);
  const after = readAtRevision(head, path);
  return before.status === 0 && after.status === 0 && isSaasSharedCssRevisionOnly(path, before.stdout, after.stdout);
});
const behaviorSaasPaths = saasPaths.filter((path) => !cacheOnlySaasPaths.includes(path));

if (behaviorSaasPaths.length && behaviorPosPaths.length) {
  console.error('SAAS/POS BOUNDARY: FAIL — one change touches SaaS-owned and POS-owned UI files.');
  console.error(`SaaS-owned content changes: ${behaviorSaasPaths.join(', ')}`);
  console.error(`POS-owned with content changes: ${behaviorPosPaths.join(', ')}`);
  console.error('Split the change or explicitly redesign the ownership contract before combining these zones.');
  process.exit(1);
}

console.log(`SAAS/POS BOUNDARY: PASS (${saasPaths.length} SaaS-owned, ${behaviorPosPaths.length} POS-owned content changes, ${cacheOnlyPosPaths.length} POS cache-only, ${sharedPaths.length} shared/other paths)`);
console.log(`SaaS shared CSS cache-only: ${cacheOnlySaasPaths.length}`);
if (saasPaths.length && sharedPaths.length) {
  console.log('Shared paths are allowed, but must retain SaaS and POS API/auth/model regression coverage.');
}
