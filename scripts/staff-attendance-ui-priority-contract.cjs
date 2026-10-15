'use strict';
// Execute the actual self-view decision block, without a browser, DOM or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'staff-attendance-ui.js'), 'utf8');
assert.equal(source, fs.readFileSync(path.join(root, 'dist/staff-attendance-ui.js'), 'utf8'), 'Published UI must match source');
const uiAssets = ['staff-attendance-ui.js', 'staff-attendance-ui.css'];
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
function assertUiAssetsCopied(dockerSource) {
  const copied = new Set(dockerSource.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    .flatMap(line => {
      const copy = line.trim().match(/^COPY\s+(.+?)\s+(?:\.\/|\/app\/)$/i);
      return copy ? copy[1].split(/\s+/) : [];
    }));
  for (const asset of uiAssets) assert(copied.has(asset), `Docker COPY must include ${asset} at /app`);
}
assertUiAssetsCopied(dockerfile);
for (const asset of uiAssets) {
  assert.equal(fs.readFileSync(path.join(root, asset), 'utf8'),
    fs.readFileSync(path.join(root, 'dist', asset), 'utf8'), `${asset}: source/dist parity`);
  // Negative controls change only an in-memory string, never the Dockerfile.
  assert.throws(() => assertUiAssetsCopied(dockerfile.split(asset).join('omitted-ui-asset')),
    { code: 'ERR_ASSERTION' }, `Removing ${asset} must fail the contract`);
}
const start = source.indexOf('      const current = snapshot.session');
const end = source.indexOf('      const requestRows =', start);
assert(start >= 0 && end > start, 'Actual self-view decision block must be located');
const script = new vm.Script(`(() => { ${source.slice(start, end)}; return { action, activeSession, status, pending: !!pending, approvedId: approved?.id }; })()`);
const now = '2035-01-01T10:30:00Z';
const approved = { id: 'approved', status: 'approved', windowStart: '2035-01-01T10:00:00Z', windowEnd: '2035-01-01T12:00:00Z' };
const pending = { ...approved, id: 'pending', status: 'pending' };
function render(decision, requests, session = null) {
  return script.runInNewContext({ snapshot: { admission: { decision }, requests, session, serverNow: now },
    escapeHtml: value => String(value), dateTime: value => String(value) }, { timeout: 1000 });
}
let checks = 0;
for (const requests of [[pending, approved], [approved, pending]]) {
  const result = render('approval_required', requests);
  assert.match(result.action, /data-attendance-approved-start/);
  assert.equal(result.approvedId, approved.id);
  assert.equal(result.pending, false);
  assert.doesNotMatch(result.status, /ожидает решения/);
  checks++;
}
assert.equal(render('approval_required', [pending]).action, ''); checks++;
assert.match(render('approval_required', []).action, /data-attendance-request-form/); checks++;
// A stale pending request cannot obstruct admission under the newly published plan.
assert.match(render('allow', [pending]).action, /data-attendance-start>/); checks++;
assert.match(render('reason_required', [pending]).action, /data-attendance-start-form/); checks++;
for (const invalid of [
  { ...approved, windowEnd: now },
  { ...approved, windowStart: '2035-01-01T11:00:00Z' },
  { ...approved, consumedAt: now },
  { ...approved, status: 'used' },
  { ...approved, status: 'expired' }
]) {
  const result = render('approval_required', [pending, invalid]);
  assert.equal(result.pending, true); assert.equal(result.action, ''); checks++;
}
for (const decision of ['allow', 'reason_required', 'approval_required']) {
  const result = render(decision, [pending, approved], { id: 'running', startedAt: now, endedAt: null });
  assert.equal(result.action, ''); assert.match(result.activeSession, /data-attendance-end/); checks++;
}
console.log(`ATTENDANCE UI PRIORITY CONTRACT: PASS (${checks} cases; JS/CSS parity; Docker COPY and 2 omission controls)`);
