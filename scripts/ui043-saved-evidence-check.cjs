'use strict';
// Saved pairs only. No browser control, requests, mutation or automatic rebinding.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-04.3');
const failures = [], records = [], hashes = new Map(); let bindings = 0, locked = 0, unlocked = 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (label, run) => { try { run(); } catch (error) { failures.push(`${label}: ${error.message}`); } };
function sourceHash(file) {
  const full = path.resolve(root, file);
  assert.ok(full.startsWith(root + path.sep), 'source path remains inside workspace');
  if (!hashes.has(full)) hashes.set(full, sha(fs.readFileSync(full)));
  return hashes.get(full);
}
function jpegSize(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'JPEG signature'); let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p++] !== 0xff) continue;
    let marker = bytes[p++]; while (marker === 0xff) marker = bytes[p++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const n = bytes.readUInt16BE(p); assert.ok(n >= 2 && p + n <= bytes.length, 'complete JPEG segment');
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { width: bytes.readUInt16BE(p + 5), height: bytes.readUInt16BE(p + 3) };
    p += n;
  }
  throw Error('JPEG dimensions unavailable');
}
const near = (a,b,t=1) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= t;
const bounded = (r,v) => r && r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.x+r.width <= v.width+1 && r.y+r.height <= v.height+1;
const files = fs.readdirSync(dir); // Only direct final records; diagnostic directory never traversed.
for (const file of files.filter(file => file.endsWith('.json')).sort()) check(file, () => {
  assert.ok(!/^(?:baseline|candidate|diagnostic)-/.test(file), 'move explicitly nonfinal evidence into diagnostic directory before final verification');
  const e = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(file, `${e.key}.json`, 'matching key and filename'); assert.ok(!records.some(record => record.key === e.key), 'unique key');
  assert.ok(Number.isFinite(Date.parse(e.time)), 'capture timestamp'); assert.deepEqual(e.before, e.after, 'stable before/after state and geometry');
  for (const file of ['lock.js', 'ui-dialog.js', 'style.css']) assert.ok(e.sources?.[file], `mandatory binding ${file}`);
  for (const [file, hash] of Object.entries(e.sources)) { assert.match(hash, /^[a-f0-9]{64}$/, 'source SHA256'); assert.equal(sourceHash(file), hash, `current source ${file}`); bindings++; }
  const jpg = fs.readFileSync(path.join(dir, `${e.key}.jpg`)), raster = jpegSize(jpg);
  assert.match(e.imageSHA || '', /^[a-f0-9]{64}$/, 'image SHA256'); assert.equal(sha(jpg), e.imageSHA, 'unchanged image bytes');
  const m = e.before, v = m.viewport;
  assert.ok(v && v.width > 0 && v.height > 0 && Number.isFinite(v.dpr) && v.dpr > 0, 'actual viewport and DPR');
  assert.ok(near(raster.width, v.width) && near(raster.height, v.height), 'JPEG matches measured viewport');
  assert.ok(['dark', 'light'].includes(m.theme), 'actual theme'); const namedTheme = /-(dark|light)-/.exec(e.key)?.[1]; if (namedTheme) assert.equal(m.theme, namedTheme, 'named and actual theme');
  assert.equal(typeof m.locked, 'boolean', 'lock state measured'); assert.ok(Array.isArray(m.dialogs) && Array.isArray(m.shared), 'modal states measured');
  const pinDialogs = m.dialogs.filter(dialog => /(?:^|\s)screen-lock-overlay(?:\s|$)/.test(dialog.class));
  if (m.locked) {
    locked++; assert.equal(m.overlay.tag, 'DIALOG'); assert.equal(m.overlay.open, true); assert.equal(m.overlay.modal, true); assert.equal(m.overlay.hidden, 'false');
    assert.equal(m.focus.inside, true, 'locked focus inside PIN'); assert.equal(m.pinHit, true, 'actual elementFromPoint reaches PIN layer'); assert.equal(pinDialogs.length, 1, 'one open native PIN'); assert.equal(pinDialogs[0].modal, true);
    assert.ok(bounded(m.overlay.box, v), 'PIN overlay bounded on screen'); assert.ok(near(m.overlay.box.width,v.width) && near(m.overlay.box.height,v.height), 'PIN native overlay covers viewport');
    const card = m.overlay.card;
    if (card) {
      assert.ok(card.width > 0 && card.x >= -1 && card.x + card.width <= v.width + 1, 'PIN card has no horizontal clipping');
      assert.ok(near(card.width, Math.min(430, v.width - 32), 1), 'existing PIN card width bounded by viewport');
      if (card.height <= v.height - 32) assert.ok(bounded(card,v), 'short PIN card fits viewport');
      else assert.ok(m.overlay.scrollHeight > m.overlay.clientHeight, 'tall PIN card remains in scrollable native overlay');
    }
    for (const shared of m.shared) {
      // The browser read-only DOM bridge may omit the inert property. Native
      // :modal + actual PIN hit/focus above already proves exclusion; require
      // the explicit attribute when captured, and always require aria-hidden.
      if (Object.hasOwn(shared, 'inert')) assert.equal(shared.inert, true, 'shared editor captured inert attribute is set');
      assert.equal(shared.hidden, 'true', 'suspended editor hidden to accessibility');
    }
    if (/autolock/.test(e.key)) assert.equal(m.reason, 'auto', 'actual natural timer reason');
  } else {
    unlocked++; assert.equal(pinDialogs.length, 0, 'no PIN dialog remains open after unlock'); assert.notEqual(m.overlay.open, true); assert.notEqual(m.overlay.modal, true); assert.equal(m.pinHit, false);
    if (m.overlay.tag) { assert.equal(m.overlay.hidden, 'true'); assert.ok(!m.overlay.box || (m.overlay.box.width === 0 && m.overlay.box.height === 0), 'closed PIN renders no hit area'); }
    if (/native-unlock-restore/.test(e.key)) { assert.ok(m.dialogs.some(dialog => /lock-settings-dialog/.test(dialog.class)), 'native settings remains open'); assert.equal(m.focus.nativeInside, true, 'focus restored within underlying native context'); }
    if (/pending-completed-unlock/.test(e.key)) assert.equal(m.focus.tag, 'H1', 'removed editor opener restores stable heading');
    if (/-login$/.test(e.key)) assert.equal(new URL(m.url).pathname, '/login', 'session expiry/logout reaches login');
  }
  if (/invalid-pin$/.test(e.key)) assert.ok(m.message.includes('Неверный PIN'), 'invalid PIN alert retained');
  if (/throttle$/.test(e.key)) assert.ok(m.message.includes('Слишком много'), 'throttle alert retained');
  if (/pending-under-pin$/.test(e.key)) { assert.ok(m.shared.some(editor => editor.busy === 'true'), 'actual pending shared editor measured'); for (const editor of m.shared.filter(editor => editor.busy === 'true')) { assert.ok(editor.values?.length, 'pending values measured'); assert.ok(editor.values.every(field => field.disabled), 'pending fields stay disabled'); } }
  records.push(e);
});
check('paired files', () => { assert.ok(records.length, 'current final records required'); for (const file of files.filter(file => file.endsWith('.jpg'))) assert.ok(files.includes(file.replace(/\.jpg$/, '.json')), `orphan JPEG ${file}`); });
check('source/dist byte parity', () => { for (const file of ['lock.js','ui-dialog.js','style.css']) assert.equal(sourceHash(file), sourceHash(`dist/${file}`), `mirror ${file}`); });
check('bounded final viewport/theme and scenario coverage', () => {
  for (const [name,width,height,dpr] of [['1366',1366,768,1],['1920',1920,1080,1],['actual',1280,720,1.25],['narrow',390,844,1]]) for (const theme of ['dark','light']) {
    const e = records.find(record => record.key === `owner-${name}-${theme}-pin`); assert.ok(e, `${name}/${theme} owner PIN frame`);
    assert.ok(near(e.before.viewport.width,width) && near(e.before.viewport.height,height), 'required measured viewport');
    assert.ok(near(e.before.viewport.dpr,dpr,0.01), 'required measured DPR'); assert.equal(e.before.theme,theme); assert.equal(e.before.locked,true);
  }
  for (const role of ['owner','manager','bartender','hookah_master']) assert.ok(records.some(record => record.key === `${role}-actual-dark-pin` && record.before.locked), `actual ${role} PIN`);
  for (const state of ['native-autolock','shared-autolock','legacy-autolock','native-keyboard','legacy-keyboard','native-unlock-restore','legacy-unlock-restore','shared-peer-unlock','pending-under-pin','pending-completed-locked','pending-completed-unlock','invalid-pin','session-expired-login']) assert.ok(records.some(record => record.key === `owner-actual-dark-${state}`), `required actual ${state}`);
  for (const state of ['late-native-lock','late-native-unlock','unexpected-close-lock']) assert.ok(records.some(record => record.key === `harness-actual-dark-${state}`), `explicitly labelled native harness ${state}`);
});
console.log(JSON.stringify({ phase: 'UI-04.3', pairs: records.length, sourceBindings: bindings, lockedFrames: locked, unlockedFrames: unlocked, result: failures.length ? 'FAIL' : 'PASS', failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
