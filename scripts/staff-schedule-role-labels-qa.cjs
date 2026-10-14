'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { config, folder } = require('./staff-schedule-local-config.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const expected = { hookah_master: 'Кальянщик', senior_hookah_master: 'Старший кальянщик', senior_bartender: 'Старший бармен', cleaner: 'Уборщица / уборщик', security: 'Охрана', technician: 'Техник', other_staff: 'Другая должность', developer: 'Разработчик', staff: 'Сотрудник' };
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const login = await context.request.post(base + '/api/login', { data: { username: f.users[0].login, password: f.password } });
    assert.equal(login.status(), 200);
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user));
    }, await login.json());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Response-only fixtures cover every missing role without changing any employee or database row.
    await page.route('**/api/staff/schedule/employees', async route => {
      const response = await route.fetch(), body = await response.json();
      assert.ok(body.items.length);
      body.items = Object.keys(expected).map((role, index) => ({ ...body.items[0], id: `role-label-${index}`, name: `Проверка ${index}`, role }));
      await route.fulfill({ response, json: body });
    });
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 0) await page.goto(base + '/admin#staff-schedule');
      else await page.reload();
      await page.locator('[data-role] option[value="hookah_master"]').waitFor({ state: 'attached' });
      for (const [role, label] of Object.entries(expected)) {
        assert.equal(await page.locator(`[data-role] option[value="${role}"]`).textContent(), label);
        assert.ok((await page.locator('.schedule-week').innerText()).includes(label), `Week row: ${role}`);
      }
      await page.locator('[data-role]').selectOption('hookah_master');
      assert.equal(await page.locator('.schedule-week tbody tr').count(), 1);
      assert.ok((await page.locator('.schedule-week tbody').innerText()).includes('Кальянщик'));
      assert.ok(!(await page.locator('.schedule-week tbody').innerText()).includes('hookah_master'));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(fs.readFileSync(path.join(__dirname, '..', 'staff-schedule-ui.js')), fs.readFileSync(path.join(__dirname, '..', 'dist', 'staff-schedule-ui.js')));
    console.log('SCHEDULE ROLE LABELS: PASS (9 roles, week rows, technical filter values retained, reload, dist parity; mocked employee responses, no business writes)');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
