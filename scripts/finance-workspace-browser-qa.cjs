const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'true', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', browser;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Workspace QA server did not start: ${output}`)), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'ru-RU' });
    const exceptions = [];
    page.on('pageerror', error => exceptions.push(error.message));
    const noOverflow = async label => {
      const directory = path.resolve(__dirname, '../tmp/finance-workspace-visual');
      mkdirSync(directory, { recursive: true });
      for (const width of [1920, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(350);
        if (await page.locator('body.sidebar-drawer-open').count()) await page.getByRole('button', { name: 'Закрыть меню', exact: true }).click();
        const metrics = await page.evaluate(() => [document.documentElement, document.querySelector('.portal-main')].map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })));
        assert.ok(metrics.every(item => item.scroll <= item.width + 1), `${label} overflow at ${width}: ${JSON.stringify(metrics)}`);
        await page.screenshot({ path: path.join(directory, `${label.replaceAll(' ', '-')}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    };
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));

    await page.route('**/api/payroll/entries?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: Array.from({ length: 30 }, (_, index) => ({ id: `fixture-${index}`, userId: `employee-${index}`, userName: `Сотрудник ${index + 1}`, ruleId: 'fixture-rule', ruleName: 'Посменная оплата', ruleType: 'per_shift', periodFrom: '2026-10-01', periodTo: '2026-10-07', amount: 12000 + index, hours: 24, status: ['draft', 'approved', 'paid'][index % 3] })) }) }));
    await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
    await page.locator('[data-kpi-target="#payment-list"]').first().press('Enter');
    assert.equal(await page.locator('#payment-list').isVisible(), true, 'keyboard KPI activation reveals payments');
    assert.equal(await page.locator('#expense-form').isVisible(), false, 'expense creation starts collapsed');
    await page.locator('summary').filter({ hasText: 'Расходы · журнал операций' }).click();
    await page.locator('summary').filter({ hasText: 'Новый расход' }).click();
    await page.locator('#expense-amount').fill('321.45');
    await page.locator('#expense-description').fill('Draft preserved by disclosure');
    await page.locator('summary').filter({ hasText: 'Расходы · журнал операций' }).click();
    await page.locator('summary').filter({ hasText: 'Расходы · журнал операций' }).click();
    assert.equal(await page.locator('#expense-amount').inputValue(), '321.45');
    assert.equal(await page.locator('#expense-description').inputValue(), 'Draft preserved by disclosure');
    await noOverflow('finance overview with expense draft');
    await page.evaluate(() => { location.hash = 'payroll'; });
    await page.locator('.finance-payroll-title').waitFor();
    assert.equal(await page.locator('#expense-form').isVisible(), false, 'payroll workspace excludes expenses');
    assert.equal(await page.locator('.portal-sidebar a[href="/finance#payroll"][aria-current="page"]').count(), 1, 'payroll menu active');
    assert.equal(await page.locator('.portal-sidebar a[href="/finance"][aria-current="page"]').count(), 0, 'overview menu inactive');
    await noOverflow('payroll workspace');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.finance-payroll-title h1').innerText(), 'Зарплата');
    const heading = await page.locator('.finance-payroll-title').boundingBox();
    assert.ok(heading.y >= 0 && heading.y < 300, 'payroll heading stays in visible top area');
    await page.locator('.finance-payroll-title a').click();
    assert.equal(await page.locator('#finance-date').isVisible(), true, 'back to overview');
    await page.goto(`${base}/finance#expenses`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#expenses').isVisible(), true, 'legacy expenses link opens disclosure on load');

    await page.goto(`${base}/finance/categories`, { waitUntil: 'networkidle' });
    for (const [name, kind] of [['Workspace expense', 'expense'], ['Workspace income', 'income']]) {
      await page.locator('#new-finance-category').click();
      assert.equal(await page.locator('dialog[open] #finance-category-form').count(), 1, 'category editor is modal');
      await page.locator('#finance-category-name').fill(name);
      await page.locator('#finance-category-kind').selectOption(kind);
      await page.locator('#finance-category-form button[type=submit]').click();
      await page.locator('.category-row').filter({ hasText: new RegExp(name, 'i') }).waitFor();
    }
    await page.locator('#finance-category-search').fill('Workspace');
    await page.locator('#finance-category-type').selectOption('expense');
    assert.equal(await page.locator('.category-row').count(), 1, 'kind filter excludes income');
    await page.locator('.finance-category-edit').click();
    await page.locator('#finance-category-name').fill('Discarded name');
    await page.locator('#cancel-finance-category').click();
    assert.equal(await page.locator('#finance-category-search').inputValue(), 'Workspace');
    assert.equal(await page.locator('#finance-category-type').inputValue(), 'expense');
    assert.equal(await page.locator('#finance-category-status').inputValue(), 'active');
    await page.locator('.finance-category-edit').click();
    await page.locator('#finance-category-name').fill('Workspace expense revised');
    await page.locator('#finance-category-form button[type=submit]').click();
    await page.locator('.category-row').filter({ hasText: /Workspace expense revised/i }).waitFor();
    await page.locator('[data-category-status]').click();
    await page.locator('.action-modal.open .action-footer button[type=submit]').click();
    await page.locator('.category-row').waitFor({ state: 'detached' });
    await page.locator('#finance-category-status').selectOption('all');
    await page.locator('.category-row').filter({ hasText: /Workspace expense revised/i }).waitFor();
    assert.match(await page.locator('.category-row').innerText(), /В архиве/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#finance-category-search').fill('Workspace expense revised');
    await page.locator('#finance-category-status').selectOption('all');
    await page.locator('.category-row').waitFor();
    assert.match(await page.locator('.category-row').innerText(), /В архиве/, 'archive persisted through actual memory API reload');
    await noOverflow('categories');

    await page.goto(`${base}/finance/report`, { waitUntil: 'networkidle' });
    await page.locator('#report-date').fill('2026-09-29');
    await page.locator('#report-refresh').click();
    await page.locator('#loyalty-reconciliation-results details').first().waitFor();
    await page.locator('#loyalty-reconciliation-from').fill('2026-09-01');
    const summary = page.locator('#loyalty-reconciliation-results details > summary').first();
    await summary.click();
    await summary.click();
    assert.equal(await page.locator('#report-date').inputValue(), '2026-09-29');
    assert.equal(await page.locator('#loyalty-reconciliation-from').inputValue(), '2026-09-01');
    const tops = await page.locator('#report-kpis .kpi').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
    assert.equal(tops.length, 5);
    assert.equal(new Set(tops).size, 1, 'all five desktop KPIs share one row');
    await noOverflow('report');
    assert.deepEqual(exceptions.filter(message => !message.includes('ViewTransition opt-in disabled')), []);
    console.log('FINANCE WORKSPACE BROWSER QA: PASS (1920/390, payroll navigation/reload, draft disclosure, category modal CRUD/reload/kind filter, report period/disclosure/5 KPIs)');
  } finally {
    await browser?.close();
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
