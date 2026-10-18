import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceDir = path.join(root, 'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-06.2');
const tmpDir = path.join(root, 'tmp/ui062');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {
  'portal.js': sha(fs.readFileSync(path.join(root, 'portal.js'))),
  'style.css': sha(fs.readFileSync(path.join(root, 'style.css'))),
};

function jpegDimensions(bytes) {
  assert.equal(bytes[0], 0xff, 'image must be JPEG');
  assert.equal(bytes[1], 0xd8, 'image must be JPEG');
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    const size = bytes.readUInt16BE(offset);
    assert(size >= 2 && offset + size <= bytes.length, 'valid JPEG segment bounds');
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += size;
  }
  throw new Error('JPEG dimensions not found');
}

const files = fs.readdirSync(evidenceDir);
const jsonFiles = files.filter((f) => f.endsWith('.json'));
const jpgFiles = new Set(files.filter((f) => f.endsWith('.jpg')));
assert(jsonFiles.length > 0, 'evidence JSON files must exist');
const artifacts = [];
for (const name of jsonFiles) {
  const meta = JSON.parse(fs.readFileSync(path.join(evidenceDir, name), 'utf8'));
  const jpgName = name.replace(/\.json$/, '.jpg');
  assert(jpgFiles.has(jpgName), `${name}: matching JPEG is required`);
  const image = fs.readFileSync(path.join(evidenceDir, jpgName));
  assert.equal(meta.imageSHA, sha(image), `${name}: image hash must match`);
  const dimensions = jpegDimensions(image);
  assert.equal(meta.before.viewport.width, dimensions.width, `${name}: before viewport width must match pixels`);
  assert.equal(meta.before.viewport.height, dimensions.height, `${name}: before viewport height must match pixels`);
  assert.deepEqual(meta.sources, sourceHashes, `${name}: source hashes must match reviewed source`);
  assert.deepEqual(meta.after, meta.before, `${name}: before/after state must be stable`);
  assert.equal(meta.key, name.replace(/\.json$/, ''), `${name}: metadata key must match filename`);
  assert(meta.capturedAt && Number.isFinite(Date.parse(meta.capturedAt)), `${name}: capture timestamp required`);
  assert.equal(meta.before.session?.status, 200, `${name}: authenticated session required`);
  assert(meta.before.session.userId && meta.before.session.venueId, `${name}: user and tenant venue required`);
  assert.equal(meta.after.session?.userId, meta.before.session.userId, `${name}: session user stable`);
  assert.equal(meta.after.session?.venueId, meta.before.session.venueId, `${name}: tenant venue stable`);
  assert.equal(meta.before.role, meta.after.role, `${name}: role stable`);
  assert.equal(meta.before.theme, meta.after.theme, `${name}: theme stable`);
  assert.equal(meta.before.viewport.width, meta.after.viewport.width, `${name}: width stable`);
  assert.equal(meta.before.viewport.height, meta.after.viewport.height, `${name}: height stable`);
  artifacts.push({ name, key: meta.key, meta, width: dimensions.width, height: dimensions.height });
}
assert.equal(jsonFiles.length, jpgFiles.size, 'every top-level JPEG must have one JSON pair');

const byKey = new Map(artifacts.map((a) => [a.key, a]));
const browserOf = ({ key, meta }) => String(meta.browser || meta.before.browser || meta.before.browserName || key.split('-')[0]).toLowerCase();
const requiredOwnerMatrix = [];
for (const view of ['stock', 'auto-orders', 'premixes']) {
  for (const [width, height] of [[390,844],[1366,768],[1920,1080]]) {
    for (const theme of ['dark','light']) requiredOwnerMatrix.push(`iab-owner-${view}-${width}-${theme}-ready`);
  }
}
for (const key of requiredOwnerMatrix) {
  const artifact = byKey.get(key);
  assert(artifact, `missing required owner IAB ready evidence: ${key}`);
  assert.equal(artifact.meta.before.role, 'owner', `${key}: owner role required`);
  assert.equal(artifact.meta.before.theme, key.includes('-dark-') ? 'dark' : 'light', `${key}: theme mismatch`);
  assert.equal(browserOf(artifact), 'iab', `${key}: browser provenance must identify IAB`);
  assert.equal(artifact.width, Number(key.match(/-(390|1366|1920)-/)[1]), `${key}: width mismatch`);
  assert.equal(artifact.meta.before.view, key.match(/owner-(stock|auto-orders|premixes)-/)[1], `${key}: view mismatch`);
  assert.match(key, /-ready$/, 'ready state must be explicit in artifact key');
  const list = artifact.meta.before.list;
  assert(list && typeof list.text === 'string' && list.text.trim().length > 0, `${key}: ready view must contain rendered list content`);
  assert.notEqual(list.busy, 'true', `${key}: ready view cannot be aria-busy`);
  assert(!/(?:Загрузка|Не удалось загрузить|Ошибка загрузки)/i.test(list.text), `${key}: loading/error state cannot be labeled ready`);
}

// Browser provenance is captured either on metadata or in the URL origin field.
const edgeReady = artifacts.filter((a) => browserOf(a) === 'edge' && a.meta.before.role === 'owner' && /-ready$/.test(a.key));
for (const theme of ['dark','light']) assert(edgeReady.some((a) => a.meta.before.theme === theme), `actual Edge owner ready capture required for ${theme} theme`);

for (const view of ['stock','auto-orders','premixes']) {
  const candidates = artifacts.filter((a) => a.meta.before.role === 'manager' && a.meta.before.view === view && a.meta.before.session?.status === 200);
  assert(candidates.length > 0, `manager readonly ${view} evidence required`);
  for (const a of candidates) {
    const permissions = a.meta.before.permissions || [];
    assert(permissions.includes('inventory_read'), `${a.key}: manager must have inventory_read`);
    assert(!permissions.includes('inventory'), `${a.key}: manager must not have inventory write permission`);
    assert.equal(a.meta.before.denied, false, `${a.key}: manager read surface must be available`);
  }
}
for (const role of ['bartender','hookah_master','other_staff']) {
  const candidates = artifacts.filter((a) => a.meta.before.role === role);
  assert(candidates.length > 0, `denied worker evidence required for role ${role}`);
  assert(candidates.some((a) => a.meta.before.denied === true), `${role}: restricted UI must show denied state`);
}

const fixtures = ['loading-search','error-search','retry','empty-fixture','filter-empty'];
for (const fixture of fixtures) assert(artifacts.some((a) => a.key.includes(fixture)), `missing UI state fixture evidence: ${fixture}`);
const fixture = (part) => artifacts.find((a) => a.key.includes(part));
assert.match(fixture('owner-stock-1366-light-loading-search').meta.before.list.text, /Загрузка/i, 'loading-search fixture must show a loading state');
const errorFixture = fixture('owner-stock-1366-light-error-search').meta.before.list.text;
assert.match(errorFixture, /Не удалось загрузить/i, 'error-search fixture must show a read error');
assert.match(errorFixture, /Повторить загрузку/i, 'error-search fixture must expose retry');
const retryText = fixture('owner-stock-1366-light-retry').meta.before.list.text;
assert(retryText.trim() && !/(?:Загрузка|Не удалось загрузить|Ошибка загрузки)/i.test(retryText), 'retry fixture must show recovered content');
assert.match(fixture('owner-stock-1366-light-empty-fixture').meta.before.list.text, /Позиций пока нет/i, 'empty fixture must show the stock empty state');
assert.match(fixture('owner-stock-1366-light-filter-empty').meta.before.list.text, /По выбранным условиям позиций нет/i, 'filter-empty fixture must show no matching results');

const apiProof = JSON.parse(fs.readFileSync(path.join(tmpDir, 'api-proof.json'), 'utf8'));
assert.equal(apiProof.result, 'PASS', 'API proof must pass');
assert.equal(apiProof.acceptedGuiWrites, 3, 'API proof requires stock, auto-order and premix writes');
assert.equal(apiProof.realGetPairs.length, 3, 'API proof requires real readback after each write');
assert.equal(apiProof.venueId, artifacts.find((a) => a.meta.before.role === 'owner')?.meta.before.session.venueId, 'API/evidence venue must match');
const roleProof = JSON.parse(fs.readFileSync(path.join(tmpDir, 'role-api-proof.json'), 'utf8'));
assert(Array.isArray(roleProof) && roleProof.length >= 5, 'role API proof must include owner, manager and three denied worker roles');
for (const role of ['owner','manager','bartender','hookah_master','other_staff']) assert(roleProof.some((r) => r.role === role), `role API proof missing ${role}`);
const owner = roleProof.find((r) => r.role === 'owner');
const manager = roleProof.find((r) => r.role === 'manager');
assert.equal(owner.venueId, apiProof.venueId, 'role/API proofs must use same tenant');
assert(manager.permissions.includes('inventory_read') && !manager.permissions.includes('inventory'), 'manager role proof must be read-only');
for (const role of ['bartender','hookah_master','other_staff']) {
  const row = roleProof.find((r) => r.role === role);
  assert(row.reads.every((r) => r.status === 403), `${role}: API reads must be denied`);
  assert(row.denied.length >= 3 && row.denied.every((r) => r.status === 403), `${role}: API writes must be denied`);
}

const report = {
  status: 'PASS', generatedAt: new Date().toISOString(), currentSourceHashes: sourceHashes,
  evidencePairs: artifacts.length, ownerIabReadyMatrix: requiredOwnerMatrix,
  edgeReadyThemes: ['dark','light'], managerReadonlyViews: ['stock','auto-orders','premixes'],
  deniedWorkerRoles: ['bartender','hookah_master','other_staff'], stateFixtures: fixtures,
  apiProofVenueId: apiProof.venueId, roleProofCount: roleProof.length,
};
fs.writeFileSync(path.join(tmpDir, 'evidence-contract-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, evidencePairs: report.evidencePairs, ownerMatrix: requiredOwnerMatrix.length, edgeThemes: 2, managerViews: 3, deniedRoles: 3 }));
