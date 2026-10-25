// Reuses the dedicated local QA database; never connects to production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pg = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const c = JSON.parse(fs.readFileSync('tmp/full-local-qa/runtime.json', 'utf8'));
assert.equal(c.database, 'hookah_local_qa'); assert.equal(c.dbPort, 31930);
assert.equal(c.container, 'hookah-full-local-qa-20261001');
const container = JSON.parse(require('node:child_process').execFileSync('docker', ['inspect', c.container], { encoding: 'utf8' }))[0];
c.dbPassword = container.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD=')).slice('POSTGRES_PASSWORD='.length);
const db = new pg.Client({ host: '127.0.0.1', port: c.dbPort, database: c.database, user: c.dbUser, password: c.dbPassword });
const base = 'http://127.0.0.1:31939';
async function removeSyntheticOrganization(organizationId, { removeOrganization = false } = {}) {
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM tobacco_catalog_items WHERE organization_id=$1', [organizationId]);
    if (removeOrganization) {
      await db.query('DELETE FROM organization_subscriptions WHERE organization_id=$1', [organizationId]);
      await db.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
(async () => {
  let browser, id, functionalError;
  const cleanupErrors = [];
  try {
    await db.connect();
    const slug = `delete-qa-${Date.now()}`;
    id = (await db.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id', ['Delete QA', slug])).rows[0].id;
    await db.query('INSERT INTO organization_subscriptions(organization_id,plan,seats_limit,venues_limit) VALUES($1,\'starter\',5,1)', [id]);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.platformLogin, password: c.password }) });
    assert.equal(login.status, 200); const auth = await login.json();
    const remove = (payload, token = auth.token) => fetch(`${base}/api/platform/organizations/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    assert.equal((await remove({}, 'invalid')).status, 401);
    assert.equal((await remove({})).status, 400);
    assert.equal((await remove({ confirmation: 'Удалить', slug: 'wrong', acknowledged: true })).status, 400);
    const guardItem = (await db.query(`INSERT INTO tobacco_catalog_items(organization_id,scope,brand,flavor)
      VALUES($1,'organization','QA delete guard','Synthetic non-empty organization') RETURNING id`, [id])).rows[0].id;
    assert.equal((await remove({ confirmation: 'Удалить', slug, acknowledged: true })).status, 409);
    assert.ok(guardItem);
    await removeSyntheticOrganization(id);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(base + '/login');
    await page.locator('#login-username').fill(c.platformLogin);
    await page.locator('#login-password').fill(c.password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForURL('**/platform');
    await page.goto(base + '/platform');
    await page.locator(`[data-org-id="${id}"]`).click();
    await page.locator('#delete-company').click();
    assert.equal(await page.locator('#confirm-company-delete').isEnabled(), false);
    await page.locator('#company-delete-form [name="confirmation"]').fill('Удалить');
    await page.locator('#company-delete-form [name="slug"]').fill(slug);
    await page.locator('#company-delete-form [name="acknowledged"]').check();
    assert.equal(await page.locator('#confirm-company-delete').isEnabled(), true);
    await page.screenshot({ path: 'tmp/platform-delete-confirmation.png' });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#confirm-company-delete').click();
    await page.locator('#company-delete-modal').waitFor({ state: 'hidden', timeout: 5000 }).catch(async error => { throw new Error(await page.locator('#company-delete-error').innerText() || error.message); });
    await page.reload();
    await page.locator('#platform-updated').filter({ hasText: 'Обновлено' }).waitFor();
    assert.equal(await page.locator(`[data-org-id="${id}"]`).count(), 0);
    assert.equal((await db.query('SELECT id FROM organizations WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='platform.organization_deleted'", [id])).rowCount, 1);
    await page.locator('#settings-refresh').click();
    await page.locator('#settings-result').filter({ hasText: 'обновлены' }).waitFor();
    console.log('PASS: auth, confirmation, inactive-data guard, UI deletion, reload, DB audit, settings refresh');
  } catch (error) { functionalError = error; }
  finally {
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    if (id) { try { await removeSyntheticOrganization(id, { removeOrganization: true }); } catch (error) { cleanupErrors.push(error); } }
    try { await db.end(); } catch (error) { cleanupErrors.push(error); }
  }
  if (functionalError && cleanupErrors.length) throw new AggregateError([functionalError, ...cleanupErrors], 'Platform QA failed and cleanup was incomplete');
  if (functionalError) throw functionalError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Platform QA cleanup failed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
