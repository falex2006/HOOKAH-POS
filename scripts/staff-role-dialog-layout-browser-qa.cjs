const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const { validateQaDatabaseUrl, assertQaDatabaseIdentity } = await import('./postgres-qa-safety.mjs');
  const target = validateQaDatabaseUrl(process.env.STAFF_ROLE_DIALOG_TEST_DATABASE_URL, 'STAFF_ROLE_DIALOG_TEST_DATABASE_URL');
  assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
  assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the guarded runner may own this disposable database');
  const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
  const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), employee: randomUUID(), role: randomUUID() };
  const login = 'staff-role-owner-' + ids.owner;
  const password = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  const useDist = process.env.STAFF_ROLE_DIALOG_USE_DIST === '1';
  const folder = path.resolve('tmp/staff-role-dialog-layout-browser-qa', useDist ? 'dist' : 'source');
  fs.mkdirSync(folder, { recursive: true });
  let server, browser;
  try {
    await client.connect();
    const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
    assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'staff role dialog layout QA');
    await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'Staff role dialog QA', 'staff-role-dialog-' + ids.organization, 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, 'Staff role dialog QA venue', 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA владелец',$4,$5,'owner','[]'::jsonb)", [ids.owner, ids.organization, ids.venue, login, hash]);
    await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await client.query("INSERT INTO custom_staff_roles(id,organization_id,venue_id,name,description,permission_scopes,created_by,updated_by) VALUES($1,$2,$3,'QA профиль зала','Синтетический профиль для визуальной проверки','[\"orders\",\"reservations\"]'::jsonb,$4,$4)", [ids.role, ids.organization, ids.venue, ids.owner]);
    await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes,custom_role_id,is_active) VALUES($1,$2,$3,'QA сотрудник зала','qa_staff_role_employee',$4,'manager','[\"orders\"]'::jsonb,$5,true)", [ids.employee, ids.organization, ids.venue, hash, ids.role]);
    const baseline = (await client.query('SELECT custom_role_id,permission_scopes,role FROM users WHERE id=$1', [ids.employee])).rows[0];

    server = spawn(process.execPath, ['server.js'], { windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Staff role dialog QA startup timeout')), 15000);
      server.stdout.on('data', chunk => { output += chunk; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); } });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Staff role dialog QA server exited ' + code)); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const errors = [];
    const writes = [];
    const screenshots = [];
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, locale: 'ru-RU' });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { const pathname = new URL(request.url()).pathname; if (request.method() === 'PATCH' && pathname === `/api/staff/${ids.employee}/profile`) writes.push(pathname); });
      if (useDist) {
        await page.route(/\/portal\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/portal.js'), contentType: 'text/javascript' }));
        await page.route(/\/style\.css(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/style.css'), contentType: 'text/css' }));
        await page.route(/\/staff-admin-card\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/staff-admin-card.js'), contentType: 'text/javascript' }));
      }
      await page.goto(base + '/login');
      await page.locator('#login-username').fill(login);
      await page.locator('#login-password').fill(password);
      await page.locator('#login-form button[type="submit"]').click();
      await page.waitForURL(url => !url.pathname.includes('/login'));

      await page.goto(base + '/admin#permissions', { waitUntil: 'networkidle' });
      const assignOpener = page.locator(`[data-custom-role-assign="${ids.role}"]`);
      await assignOpener.waitFor({ state: 'visible' });
      await assignOpener.click();
      const assignment = page.getByRole('dialog', { name: 'Назначить сотрудника' });
      await assignment.waitFor({ state: 'visible' });
      const staff = assignment.locator('select[name="staffId"]');
      assert.equal(await staff.locator(`option[value="${ids.employee}"]`).count(), 1, 'employee is available for assignment');
      assert.equal(await assignment.locator('button[type="submit"]').innerText(), 'Назначить');
      const assignGeometry = await assignment.evaluate(element => { const box = element.querySelector('.ui-modal-card').getBoundingClientRect(); return { left: box.left, right: box.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; });
      assert.equal(assignGeometry.left >= 0 && assignGeometry.right <= width && assignGeometry.scrollWidth <= width, true, 'assignment dialog fits viewport');
      const assignActions = await assignment.locator('.ui-modal-footer').evaluate(footer => {
        const [cancel, submit] = [...footer.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        return { cancel: { left: cancel.left, right: cancel.right, top: cancel.top, bottom: cancel.bottom, width: cancel.width, height: cancel.height }, submit: { left: submit.left, right: submit.right, top: submit.top, bottom: submit.bottom, width: submit.width, height: submit.height } };
      });
      assert.equal(Math.abs(assignActions.cancel.width - assignActions.submit.width) <= 1, true, 'assignment footer buttons have equal widths');
      assert.equal(assignActions.cancel.height >= 44 && assignActions.submit.height >= 44, true, 'assignment footer buttons have usable height');
      const actionGap = width <= 600 ? assignActions.submit.top - assignActions.cancel.bottom : assignActions.submit.left - assignActions.cancel.right;
      assert.equal(Math.abs(actionGap - 12) <= 1, true, 'assignment footer has a consistent 12px gap');
      const compactImage = path.join(folder, `assignment-${width}.png`);
      await page.screenshot({ path: compactImage }); screenshots.push(compactImage);
      await assignment.locator('[data-ui-cancel]').click();
      await assignment.waitFor({ state: 'hidden' });
      assert.equal(await assignOpener.evaluate(element => document.activeElement === element), true, 'assignment cancel restores opener focus');

      await page.goto(base + '/admin#staff', { waitUntil: 'networkidle' });
      const cardOpener = page.locator(`.staff-edit[data-staff="${ids.employee}"]:visible`).first();
      await cardOpener.waitFor({ state: 'visible' });
      await cardOpener.click();
      const card = page.locator('.staff-admin-modal');
      await card.waitFor({ state: 'visible' });
      const profile = card.locator('select[name="customRoleId"]');
      await page.waitForFunction(() => { const select = document.querySelector('.staff-admin-modal select[name="customRoleId"]'); return select && !select.disabled && select.options.length > 1; });
      assert.equal(await profile.inputValue(), ids.role, 'card shows the assigned custom role');
      assert.equal(await card.locator('input[name="permissionScopes"]').count() > 0, true, 'card shows the access toggles');
      const cardGeometry = await card.evaluate(element => { const box = element.querySelector('.staff-admin-box').getBoundingClientRect(); return { left: box.left, right: box.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; });
      assert.equal(cardGeometry.left >= 0 && cardGeometry.right <= width && cardGeometry.scrollWidth <= width, true, 'staff card fits viewport');
      await profile.scrollIntoViewIfNeeded();
      const cardImage = path.join(folder, `staff-card-role-${width}.png`);
      await page.screenshot({ path: cardImage }); screenshots.push(cardImage);
      const phoneHead = card.locator('.staff-admin-phone-head');
      await phoneHead.scrollIntoViewIfNeeded();
      const phoneLayout = await phoneHead.evaluate(element => {
        const title = element.querySelector('b').getBoundingClientRect();
        const button = element.querySelector('button').getBoundingClientRect();
        const head = element.getBoundingClientRect();
        return { title: { left: title.left, right: title.right, top: title.top, bottom: title.bottom }, button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom, height: button.height, width: button.width }, head: { left: head.left, right: head.right, width: head.width } };
      });
      const overlaps = phoneLayout.title.left < phoneLayout.button.right && phoneLayout.title.right > phoneLayout.button.left && phoneLayout.title.top < phoneLayout.button.bottom && phoneLayout.title.bottom > phoneLayout.button.top;
      assert.equal(overlaps, false, 'phone heading and add button do not overlap');
      if (width <= 650) {
        assert.equal(phoneLayout.button.top >= phoneLayout.title.bottom, true, 'mobile add button follows the heading');
        assert.equal(phoneLayout.button.width >= phoneLayout.head.width - 2, true, 'mobile add button fills the phone heading row');
        assert.equal(phoneLayout.button.height >= 44, true, 'mobile add button has a usable touch target');
      }
      const contactsImage = path.join(folder, `staff-card-contacts-${width}.png`);
      await page.screenshot({ path: contactsImage }); screenshots.push(contactsImage);
      await card.locator('.staff-admin-cancel').click();
      await card.waitFor({ state: 'hidden' });
      assert.equal(await cardOpener.evaluate(element => document.activeElement === element), true, 'staff card cancel restores opener focus');
      await context.close();
    }
    assert.deepEqual(writes, [], 'opening and cancelling either role dialog sends no staff profile PATCH');
    const after = (await client.query('SELECT custom_role_id,permission_scopes,role FROM users WHERE id=$1', [ids.employee])).rows[0];
    assert.deepEqual(after, baseline, 'employee role and permissions remain unchanged');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log(`STAFF ROLE DIALOG LAYOUT BROWSER QA: PASS (${useDist ? 'dist' : 'source'}; ${screenshots.join(', ')})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit').catch(() => {}); server.kill(); await stopped; }
    await client.end().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
