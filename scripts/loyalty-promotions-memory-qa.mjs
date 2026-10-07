import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_ADMIN_PASSWORD: 'admin' }, stdio: ['ignore', 'pipe', 'pipe'] });
const baseUrl = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('isolated memory server did not start')), 15000); child.once('error', reject); child.once('exit', () => reject(new Error('isolated memory server exited early'))); child.stdout.on('data', (chunk) => { const match = String(chunk).match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } }); });
let token = '';
const call = async (path, method = 'GET', body) => { const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
const expect = (result, status, error) => { assert.equal(result.status, status, JSON.stringify(result)); if (error) assert.equal(result.data.error, error); return result.data; };
try {
  expect(await call('/api/loyalty/promotions', 'POST', {}), 401);
  token = expect(await call('/api/login', 'POST', { username: 'admin', password: 'admin' }), 200).token;
  const venue = expect(await call('/api/network/venues'), 200).items.find((item) => item.isCurrent);
  assert.ok(venue?.id);
  const product = expect(await call('/api/products', 'POST', { name: 'QA Campaign Product', category: 'Бар', price: 250 }), 201);
  const base = { expectedVenueId: venue.id, name: 'QA акция', description: 'черновик', startsAt: '2030-10-01T10:00:00.000Z', endsAt: '2030-10-01T12:00:00.000Z', timezone: 'Asia/Yekaterinburg', benefitKind: 'percent', benefitValue: 15, priority: 3, includeProductIds: [product.id], excludeProductIds: [], includeCategories: [], excludeCategories: [] };
  const invalid = expect(await call('/api/loyalty/promotions', 'POST', { ...base, timezone: 'Moon/Sea' }), 400, 'invalid_loyalty_promotion');
  assert.ok(invalid);
  const created = expect(await call('/api/loyalty/promotions', 'POST', base), 201);
  assert.equal(created.version, 1); assert.equal(created.status, 'draft'); assert.deepEqual(created.includeProductIds, [product.id]);
  assert.equal(expect(await call('/api/loyalty/promotions'), 200).items.length, 1);
  expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { ...base, expectedVersion: 1, expectedVenueId: 'venue-stale' }), 409, 'venue_context_changed');
  expect(await call(`/api/products/${product.id}`, 'DELETE'), 200);
  expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { expectedVenueId: venue.id, expectedVersion: 0, name: 'Старая версия' }), 409, 'loyalty_promotion_version_conflict');
  const updated = expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { ...base, expectedVersion: 1, name: 'QA акция v2', description: 'новая версия' }), 200);
  assert.equal(updated.version, 2); assert.equal(updated.status, 'draft');
  const active = expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { ...base, expectedVersion: 2, status: 'active' }), 200);
  assert.equal(active.version, 3); assert.equal(active.status, 'active');
  expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { ...base, expectedVersion: 3, status: 'archived', name: 'archive with edits' }), 400, 'loyalty_promotion_archive_terms_immutable');
  const archived = expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { expectedVenueId: venue.id, expectedVersion: 3, status: 'archived' }), 200);
  assert.equal(archived.version, 4); assert.equal(archived.status, 'archived');
  assert.equal(expect(await call('/api/loyalty/promotions'), 200).items.length, 0);
  const all = expect(await call('/api/loyalty/promotions?includeArchived=true'), 200).items;
  assert.equal(all.length, 1); assert.equal(all[0].version, 4); assert.equal(all[0].status, 'archived');
  const other = expect(await call('/api/network/venues', 'POST', { name: 'QA Campaign Other', city: 'Тюмень', address: 'Тестовая, 1' }), 201);
  expect(await call(`/api/network/venues/${other.id}/select`, 'POST'), 200);
  assert.equal(expect(await call('/api/loyalty/promotions?includeArchived=true'), 200).items.length, 0);
  expect(await call(`/api/loyalty/promotions/${created.promotionId}`, 'PATCH', { ...base, expectedVersion: 4, expectedVenueId: other.id, status: 'draft' }), 404, 'loyalty_promotion_not_found');
  console.log('LOYALTY PROMOTIONS MEMORY QA: PASS (owner CRUD, immutable versions, validation, inactive default, archive, stale version, venue isolation)');
} finally { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
