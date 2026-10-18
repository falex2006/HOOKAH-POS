'use strict';
// Offline verification of actual CUA evidence; no browser/session/database writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-03.2/final');
const hashCache = new Map();
function hash(source) {
  const file = path.resolve(root, source);
  assert.ok(file.startsWith(root + path.sep), 'Source reference must stay in workspace: ' + source);
  if (!hashCache.has(file)) hashCache.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  return hashCache.get(file);
}
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'JPEG signature');
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p++] !== 0xff) continue;
    let marker = buf[p++];
    while (marker === 0xff) marker = buf[p++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const n = buf.readUInt16BE(p);
    assert.ok(n >= 2 && p + n <= buf.length, 'Complete JPEG segment');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buf.readUInt16BE(p + 5), height: buf.readUInt16BE(p + 3) };
    }
    p += n;
  }
  throw Error('JPEG dimensions unavailable');
}
const routeSignature = href => { const u = new URL(href, 'http://evidence.invalid'); return u.pathname + u.search + u.hash; };
const matchesTarget = (href, target) => {
  const actual = new URL(href, 'http://evidence.invalid'), expected = new URL(target, 'http://evidence.invalid');
  return actual.pathname === expected.pathname && actual.hash === expected.hash
    && [...expected.searchParams].every(([key, value]) => actual.searchParams.get(key) === value);
};
const entries = new Map();
const viewportCaptureMethod = 'documented viewport screenshot; fullPage unavailable during scroll-locked drawer';
const viewportFrameKeys = new Set(['hookah-narrow-light-drawer', 'owner-narrow-light-team', 'owner-narrow-light-search', 'owner-narrow-light-clear']);
let refs = 0, management = 0, flat = 0, denied = 0, nativeViewportFrames = 0, nativeViewportRounding = 0;
for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
  const e = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(e.key + '.json', file, file + ' unique named key');
  assert.ok(!entries.has(e.key), file + ' duplicate key');
  assert.equal(e.stable, true, file + ' stable flag');
  assert.deepEqual(e.before, e.after, file + ' stable DOM/geometry');
  assert.ok(e.sourceHashes && Object.keys(e.sourceHashes).length, file + ' source binding');
  assert.ok(e.sourceHashes['portal.js'], file + ' product source binding');
  for (const [source, sha] of Object.entries(e.sourceHashes)) { assert.equal(hash(source), sha, file + ' ' + source); refs++; }
  const raster = jpegSize(fs.readFileSync(path.join(dir, file.replace(/\.json$/, '.jpg'))));
  const m = e.before, meta = e.meta || {}, nav = m.navigation;
  if (meta.captureMethod === viewportCaptureMethod) {
    assert.ok(viewportFrameKeys.has(e.key), file + ' explicitly scoped native viewport fallback');
    assert.equal(m.viewport.width, 390, file + ' scoped narrow viewport');
    assert.equal(m.viewport.height, 844, file + ' scoped narrow viewport height');
    assert.ok(Math.abs(m.viewport.dpr - 1) < 0.00001, file + ' observed near-unit DPR');
    assert.ok(/(?:^|\s)sidebar-drawer-open(?:\s|$)/.test(m.body), file + ' scroll-locked drawer');
    assert.deepEqual(e.clip, { x: 0, y: 0, width: m.viewport.contentWidth, height: m.viewport.height }, file + ' actual CSS viewport clip retained');
    assert.ok(Math.abs(raster.width - e.clip.width) <= 1 && Math.abs(raster.height - e.clip.height) <= 1, file + ' bounded native viewport raster rounding (not exact geometry)');
    nativeViewportFrames++;
    if (raster.width !== e.clip.width || raster.height !== e.clip.height) nativeViewportRounding++;
  } else {
    assert.deepEqual(raster, { width: e.clip.width, height: e.clip.height }, file + ' exact fullPage JPEG CSS clip');
  }
  assert.ok(nav && Array.isArray(nav.groups), file + ' navigation DOM');
  const u = new URL(m.url);
  if (meta.expectedHash !== undefined) assert.equal(u.hash, meta.expectedHash, file + ' preserved hash');
  for (const [key, value] of Object.entries(meta.expectedQuery || {})) assert.equal(u.searchParams.get(key), value, file + ' preserved query ' + key);
  if (meta.expectedDenied !== undefined) assert.equal(m.denied, meta.expectedDenied, file + ' denial');
  if (meta.verifiedSession) {
    const s = meta.verifiedSession;
    assert.equal(s.status, 200, file + ' verified session status');
    assert.ok(s.userId && s.venueId && s.role, file + ' confirmed identity');
    if (meta.venue) assert.equal(s.venueId, meta.venue, file + ' confirmed venue');
  }
  const groupedLinks = nav.groups.flatMap(g => g.links.map(l => ({ ...l, group: g })));
  // The measurement's visible flag includes hidden ancestors, inert and closed details.
  const visibleGroupedLinks = groupedLinks.filter(l => l.visible === true && !l.hidden && !l.group.hidden && l.group.open);
  for (const l of groupedLinks) if (l.visible) assert.ok(!l.hidden && !l.group.hidden && l.group.open, file + ' visible link ancestor consistency');
  const visibleLinks = nav.groups.length ? visibleGroupedLinks : (m.nav || []);
  for (const href of meta.hiddenPaths || []) assert.ok(!visibleLinks.some(l => l.href && matchesTarget(l.href, href)), file + ' inaccessible path remains hidden ' + href);
  if (meta.expectedActive !== undefined) {
    const active = visibleLinks.filter(l => l.active).map(l => routeSignature(l.href));
    assert.equal(active.length, 1, file + ' unique visible active link');
    assert.ok(matchesTarget(active[0], meta.expectedActive), file + ' expected active route (extra preserved context allowed)');
    assert.deepEqual(visibleLinks.filter(l => l.current === 'page').map(l => routeSignature(l.href)), active, file + ' unique aria-current');
  }
  if (m.denied) {
    denied++;
    assert.equal(m.shell.sidebar, null, file + ' denied shell hidden');
    assert.equal(m.shell.header, null, file + ' denied header hidden');
    assert.equal((m.nav || []).length, 0, file + ' denied navigation inaccessible');
  } else if (meta.employeeFlat || /(?:^|\s)employee-portal(?:\s|$)/.test(m.body)) {
    flat++;
    assert.equal(nav.groups.length, 0, file + ' employee flat menu preserved');
    assert.equal(nav.search, '', file + ' no management search in flat menu');
  } else {
    management++;
    const visibleGroups = nav.groups.filter(g => !g.hidden);
    const open = visibleGroups.filter(g => g.open).map(g => g.key);
    nav.groups.forEach(g => assert.equal(g.expanded, String(g.open), file + ' summary aria-expanded ' + g.key));
    if (meta.expectedOpen !== undefined) assert.deepEqual(open, meta.expectedOpen, file + ' expected open groups');
    if (meta.visibleGroups !== undefined) assert.equal(visibleGroups.length, meta.visibleGroups, file + ' visible groups');
    if (!nav.search.trim()) assert.ok(open.length <= 1, file + ' normal single disclosure');
    if (meta.multipleAllowed) { assert.ok(nav.search.trim(), file + ' search exception requires query'); assert.ok(open.length > 1, file + ' actual multiple search groups'); }
  }
  entries.set(e.key, e);
}
const cells = ['arrival', 'two-groups', 'reload-team', 'keyboard-space', 'reload-null', 'search-multiple', 'search-title', 'search-empty', 'search-clear-null', 'keyboard-enter', 'search-clear-team', 'hash-tasks', 'route-from-search', 'history-back', 'history-forward'];
for (const width of [1366, 1920]) for (const theme of ['dark', 'light']) for (const cell of cells) {
  const key = `owner-${width}-${theme}-${cell}`, e = entries.get(key);
  assert.ok(e, key + ' mandatory desktop cell');
  assert.equal(e.before.viewport.width, width, key + ' viewport');
  assert.equal(e.before.viewport.height, width === 1366 ? 768 : 1080, key + ' viewport height');
  assert.equal(e.before.theme, theme, key + ' actual theme');
  assert.equal(e.before.denied, false, key + ' accessible owner route');
  assert.equal(e.meta.verifiedSession.role, 'owner', key + ' actual owner');
}
function requireFrame(key, group) {
  const e = entries.get(key); assert.ok(e, key + ' mandatory isolation frame');
  assert.deepEqual(e.before.navigation.groups.filter(g => !g.hidden && g.open).map(g => g.key), [group], key + ' isolated selection');
  assert.ok(e.meta.verifiedSession, key + ' verified session');
  return e;
}
const a = requireFrame('owner-venue-a-finance', 'finance');
const b = requireFrame('owner-venue-b-team', 'team');
const ar = requireFrame('owner-venue-a-restored-finance', 'finance');
const br = requireFrame('owner-venue-b-restored-team', 'team');
assert.equal(a.meta.verifiedSession.userId, b.meta.verifiedSession.userId, 'Same user across points');
assert.notEqual(a.meta.verifiedSession.venueId, b.meta.verifiedSession.venueId, 'Different confirmed venues');
for (const [original, restored] of [[a, ar], [b, br]]) {
  assert.equal(original.meta.verifiedSession.userId, restored.meta.verifiedSession.userId, 'Restore user');
  assert.equal(original.meta.verifiedSession.venueId, restored.meta.verifiedSession.venueId, 'Restore venue');
}
let userIsolation = 'not yet supplied';
if (entries.has('manager-user-isolation') || entries.has('owner-user-before-switch')) {
  const old = requireFrame('owner-user-before-switch', 'finance');
  const next = requireFrame('manager-user-isolation', 'operations');
  assert.notEqual(old.meta.verifiedSession.userId, next.meta.verifiedSession.userId, 'Different confirmed users');
  assert.equal(old.meta.verifiedSession.venueId, next.meta.verifiedSession.venueId, 'Same venue for user isolation');
  userIsolation = 'verified different users at same venue';
}
console.log(JSON.stringify({ status: 'PASS_SCOPED', frames: entries.size, sourceHashRefs: refs, desktopCells: 60, management, employeeFlat: flat, denied, tenantIsolation: 'same verified user, two venues and returns', userIsolation, nativeViewportFrames, nativeViewportRounding, raster: 'fullPage JPEG equals CSS clip exactly; four documented narrow drawer viewport frames allow at most 1px native raster rounding, not exact geometry' }, null, 2));
