import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const server = read('server.js'); const portal = read('portal.js'); const distPortal = read('dist/portal.js'); const migration = read('migrations/073_loyalty_promotions.sql');
for (const source of [server, portal, distPortal]) {
  assert.match(source, /\/api\/loyalty\/promotions/);
  assert.match(source, /promotionId/);
}
assert.match(server, /loyalty_promotion_owner_admin_required/);
assert.match(server, /loyalty_promotion_version_conflict/);
assert.doesNotMatch(server, /loyalty_promotion_pricing_unavailable/);
assert.match(server, /loyalty_promotions_venue/);
assert.match(server, /normalizePromotionInput/);
assert.match(portal, /promotion-products/);
assert.match(portal, /promotion-timezone/);
assert.match(portal, /Новая версия акции/);
assert.match(portal, /Черновик можно активировать из списка акций/);
assert.match(portal, /Активировать/);
assert.match(migration, /PRIMARY KEY \(venue_id,promotion_id,version\)/);
assert.match(migration, /FOREIGN KEY \(venue_id,product_id\)/);
assert.match(migration, /NULLS NOT DISTINCT/);
assert.match(migration, /BEFORE UPDATE OR DELETE/);
assert.match(migration, /ends_at > starts_at/);
assert.match(migration, /status text NOT NULL DEFAULT 'draft'/);
assert.equal(portal, distPortal, 'published portal bundle must match its source');
console.log('LOYALTY PROMOTIONS CONTRACT: PASS');
