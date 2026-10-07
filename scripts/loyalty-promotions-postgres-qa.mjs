import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
process.env.AUTH_REQUIRED = 'true';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i, 'refusing test writes unless the database name identifies a QA database');
const require = createRequire(import.meta.url); const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl }); const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const qaAuditSuffix = crypto.randomUUID().replaceAll('-', '');
const qaAuditTrigger = `qa_fail_promotion_audit_${qaAuditSuffix}`;
const qaAuditFunction = `${qaAuditTrigger}_fn`;
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routeStart = server.indexOf("if (pathname === '/api/loyalty/promotions' && req.method === 'GET')");
const routeEnd = server.indexOf("if (pathname === '/api/loyalty/reconciliation' && req.method === 'GET')", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'promotion routes are present');
const route = server.slice(routeStart, routeEnd); const helper = server.match(/const normalizePromotionInput = \(input, base = \{\}\) => \{[\s\S]*?\n\};/)?.[0];
assert.ok(helper, 'campaign input normalizer exists');
const normalizePromotionInput = new Function(`${helper}; return normalizePromotionInput;`)();
const termsHelper = server.match(/const promotionTermsEqual = \(left, right\) => [\s\S]*?\n\}\);/)?.[0];
assert.ok(termsHelper, 'campaign archive terms comparator exists');
const promotionTermsEqual = new Function(`${termsHelper}; return promotionTermsEqual;`)();
let venueId; let otherVenueId; let productId; let inactiveProductId; let foreignProductId;
const callApi = async ({ path, method = 'GET', body = {}, venue = venueId, role = 'owner', permissions = ['orders'] }) => {
  const url = new URL(`http://localhost${path}`); const pathname = url.pathname; let response;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const hasPermission = (req, permission) => req.user?.permissions?.includes(permission) === true;
  const handler = new Function('pathname','url','req','res','repositories','venueDbId','currentVenueId','body','json','hasPermission','normalizePromotionInput','promotionTermsEqual','crypto', `return (async()=>{${route}})();`);
  await handler(pathname,url,{method,headers:{},user:{id:null,role,permissions}}, {}, {pool}, venue, venue, async()=>body, json, hasPermission, normalizePromotionInput, promotionTermsEqual, crypto);
  return response;
};
const expect = (result, status, error) => { assert.equal(result.status, status, JSON.stringify(result)); if(error) assert.equal(result.data.error,error); return result.data; };
try {
  await setup.connect();
  venueId = (await setup.query("INSERT INTO venues (name) VALUES ('Promotion QA Venue') RETURNING id")).rows[0].id;
  otherVenueId = (await setup.query("INSERT INTO venues (name) VALUES ('Promotion QA Other Venue') RETURNING id")).rows[0].id;
  productId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Promotion QA Product','QA Бар',250) RETURNING id", [venueId])).rows[0].id;
  inactiveProductId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Promotion QA Inactive Product','QA Inactive Bar',250) RETURNING id", [venueId])).rows[0].id;
  foreignProductId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Promotion QA Foreign Product','QA Бар',250) RETURNING id", [otherVenueId])).rows[0].id;
  assert.equal((await callApi({ path:'/api/loyalty/promotions', permissions:[] })).status,403,'list requires read permission');
  assert.equal((await callApi({ path:'/api/loyalty/promotions', method:'POST', role:'manager', body:{} })).status,403,'only owner/admin may create');
  const base = { expectedVenueId:venueId,name:'QA Promotion',description:'Draft only',startsAt:'2030-10-01T10:00:00.000Z',endsAt:'2030-10-01T12:00:00.000Z',timezone:'Asia/Yekaterinburg',benefitKind:'percent',benefitValue:15,priority:2,includeProductIds:[productId],excludeProductIds:[],includeCategories:[],excludeCategories:[] };
  expect(await callApi({path:'/api/loyalty/promotions',method:'POST',body:{...base,includeProductIds:[foreignProductId]}}),400,'loyalty_promotion_scope_invalid');
  expect(await callApi({path:'/api/loyalty/promotions',method:'POST',body:{...base,includeProductIds:[crypto.randomUUID()]}}),400,'loyalty_promotion_scope_invalid');
  await setup.query(`CREATE OR REPLACE FUNCTION ${qaAuditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='loyalty_promotion' THEN RAISE EXCEPTION 'QA audit failure'; END IF; RETURN NEW; END; $$`);
  await setup.query(`CREATE TRIGGER ${qaAuditTrigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${qaAuditFunction}()`);
  expect(await callApi({path:'/api/loyalty/promotions',method:'POST',body:base}),503,'loyalty_promotion_save_failed');
  assert.equal((await setup.query('SELECT count(*)::int AS count FROM loyalty_promotions WHERE venue_id=$1',[venueId])).rows[0].count,0,'audit failure rolls back campaign and scopes');
  await setup.query(`DROP TRIGGER ${qaAuditTrigger} ON audit_events`); await setup.query(`DROP FUNCTION ${qaAuditFunction}()`);
  const created = expect(await callApi({path:'/api/loyalty/promotions',method:'POST',body:base}),201);
  assert.equal(created.status,'draft'); assert.equal(created.version,1);
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:1,expectedVenueId:otherVenueId}}),409,'venue_context_changed');
  await setup.query('UPDATE products SET is_active=false WHERE venue_id=$1 AND id=$2',[venueId,inactiveProductId]);
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:1,includeProductIds:[productId,inactiveProductId]}}),400,'loyalty_promotion_scope_invalid');
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:1,includeProductIds:[productId],excludeProductIds:[inactiveProductId]}}),400,'loyalty_promotion_scope_invalid');
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:1,includeProductIds:[productId],excludeCategories:['QA Inactive Bar']}}),400,'loyalty_promotion_scope_invalid');
  await setup.query('UPDATE products SET is_active=false WHERE venue_id=$1 AND id=$2',[venueId,productId]);
  assert.equal((await setup.query('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND entity_type=$2 AND entity_id=$3',[venueId,'loyalty_promotion',created.promotionId])).rows[0].count,1,'create audit commits with campaign');
  const stale = await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:0}}); expect(stale,409,'loyalty_promotion_version_conflict');
  const updated = expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:1,name:'QA Promotion v2'}}),200);
  assert.equal(updated.version,2); assert.equal(updated.name,'QA Promotion v2');
  const activated=expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:2,status:'active'}}),200); assert.equal(activated.version,3); assert.equal(activated.status,'active');
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{...base,expectedVersion:3,status:'archived',name:'archive with edits'}}),400,'loyalty_promotion_archive_terms_immutable');
  expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',venue:otherVenueId,body:{...base,expectedVenueId:otherVenueId,expectedVersion:2}}),404,'loyalty_promotion_not_found');
  assert.equal(expect(await callApi({path:'/api/loyalty/promotions',venue:otherVenueId}),200).items.length,0,'sibling venue list is isolated');
  const listed = expect(await callApi({path:'/api/loyalty/promotions'}),200).items; assert.equal(listed.length,1); assert.equal(listed[0].version,3); assert.deepEqual(listed[0].includeProductIds,[productId]);
  await assert.rejects(setup.query('UPDATE loyalty_promotions SET name=$1 WHERE venue_id=$2 AND promotion_id=$3 AND version=1',['mutate',venueId,created.promotionId]), (error) => error.code === '55000');
  await assert.rejects(setup.query('DELETE FROM loyalty_promotions WHERE venue_id=$1 AND promotion_id=$2 AND version=1',[venueId,created.promotionId]), (error) => error.code === '55000');
  const createdScope = (await setup.query('SELECT id FROM loyalty_promotion_scopes WHERE venue_id=$1 AND promotion_id=$2 AND version=1', [venueId, created.promotionId])).rows[0].id;
  await assert.rejects(setup.query('UPDATE loyalty_promotion_scopes SET scope_kind=scope_kind WHERE id=$1', [createdScope]),
    (error) => error.code === '55000', 'promotion scopes reject even no-op updates');
  await assert.rejects(setup.query('DELETE FROM loyalty_promotion_scopes WHERE id=$1', [createdScope]),
    (error) => error.code === '55000', 'promotion scopes reject direct deletes');
  await assert.rejects(setup.query('DELETE FROM products WHERE id=$1', [productId]),
    (error) => error.code === '23503', 'historical product scope prevents standalone product deletion');
  const archived = expect(await callApi({path:`/api/loyalty/promotions/${created.promotionId}`,method:'PATCH',body:{expectedVenueId:venueId,expectedVersion:3,status:'archived'}}),200);
  assert.equal(archived.version,4); assert.equal(expect(await callApi({path:'/api/loyalty/promotions'}),200).items.length,0);
  assert.equal(expect(await callApi({path:'/api/loyalty/promotions?includeArchived=true'}),200).items[0].status,'archived');
  console.log('LOYALTY PROMOTIONS POSTGRES QA: PASS (venue scope, RBAC, immutable version/audit, product scope, archive, optimistic concurrency)');
} finally {
  const cleanupErrors = [];
  if (setup._connected) {
    await setup.query(`DROP TRIGGER IF EXISTS ${qaAuditTrigger} ON audit_events`).catch((error) => cleanupErrors.push(error));
    await setup.query(`DROP FUNCTION IF EXISTS ${qaAuditFunction}()`).catch((error) => cleanupErrors.push(error));
    const fixtureVenueIds = [venueId, otherVenueId].filter(Boolean);
    if (fixtureVenueIds.length) {
      await setup.query('DELETE FROM audit_events WHERE venue_id=ANY($1::uuid[])', [fixtureVenueIds])
        .catch((error) => cleanupErrors.push(error));
      try {
        await setup.query('BEGIN');
        await setup.query('DELETE FROM products WHERE venue_id=ANY($1::uuid[])', [fixtureVenueIds]);
        await setup.query('DELETE FROM venues WHERE id=ANY($1::uuid[])', [fixtureVenueIds]);
        await setup.query('COMMIT');
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => {});
        cleanupErrors.push(error);
      }
      const residue = await setup.query('SELECT count(*)::int AS count FROM venues WHERE id=ANY($1::uuid[])', [fixtureVenueIds])
        .catch((error) => { cleanupErrors.push(error); return null; });
      if (residue) {
        try { assert.equal(residue.rows[0].count, 0, 'promotion QA fixtures are removed through venue cascades'); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    await setup.end().catch((error) => cleanupErrors.push(error));
  }
  await pool.end().catch((error) => cleanupErrors.push(error));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Promotion PostgreSQL QA cleanup failed');
}
