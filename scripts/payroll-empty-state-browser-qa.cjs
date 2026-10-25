// Isolated component QA: no application server, database, login or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'payroll-scheme-ui.js'), 'utf8');
const component = source.slice(source.indexOf('  const mountEmploymentEligibilityPanel ='), source.indexOf('  const mountProductDepartmentPanel ='));
const escape = source.match(/  const escapeHtml = [^\r\n]+/)[0];
const css = source.match(/<style data-payroll-editor-responsive>([\s\S]*?)<\/style>/)[1];
const summaryCode = source.slice(source.indexOf("    const settings = document.createElement('details');"), source.indexOf('    mountProductDepartmentPanel(payrollPanel, settings);'));

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<main id="page-content" class="finance-workspace"><section id="qa-payroll-host"></section></main>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'style.css'), 'utf8') + '\n' + css });
    await page.evaluate(({ component, escape, summaryCode }) => {
      window.qaSnapshot = { current: null, history: [] };
      window.qaError = false;
      // Execute actual component source with an in-memory, read-only API substitute.
      const request = async url => {
        if (window.qaError) throw new Error('offline');
        return url.endsWith('/employees') ? { items: [] } : window.qaSnapshot;
      };
      const payrollPanel = document.querySelector('#qa-payroll-host');
      const panel = document.createElement('section');
      eval(escape + '\n' + component + '\n' + summaryCode);
    }, { component, escape, summaryCode });
    const status = page.locator('[data-eligibility-status]');
    const current = page.locator('[data-eligibility-current]');
    await page.waitForFunction(() => document.querySelector('[data-eligibility-current]').textContent.includes('История ещё не настроена.'));
    assert.equal(await status.textContent(), '');
    assert.equal(((await page.locator('.finance-payroll-eligibility').innerText()).match(/История ещё не настроена\./g) || []).length, 1);
    assert.match(await current.textContent(), /расчёт зарплаты должен оставаться заблокированным/);
    const summary = page.locator('.finance-payroll-settings > summary');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await summary.evaluate(el => getComputedStyle(el, '::after').content), '""');
      const ax = await summary.ariaSnapshot();
      assert.ok(ax.includes('Настройки схем и проверка расчётов'), `Unexpected AX: ${ax}`);
      assert.ok(!ax.includes('⌄'), 'decorative chevron must not enter the accessible name');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await summary.evaluate(el => el.parentElement.open), true);
      await page.keyboard.press('Space');
      assert.equal(await summary.evaluate(el => el.parentElement.open), false);
    }
    await page.evaluate(() => { window.qaSnapshot = { current: { revisionNo: 2, createdByName: 'Владелец', periods: [] }, history: [] }; });
    await page.locator('[data-eligibility-reload]').click();
    await page.waitForFunction(() => document.querySelector('[data-eligibility-status]').textContent.includes('версия 2'));
    assert.match(await current.textContent(), /Сохранена пустая версия/);
    await page.evaluate(() => { window.qaError = true; });
    await page.locator('[data-eligibility-reload]').click();
    await page.waitForFunction(() => document.querySelector('[data-eligibility-status]').textContent.includes('Не удалось'));
    assert.match(await current.textContent(), /Сохранение временно недоступно/);
    console.log('PAYROLL EMPTY STATE BROWSER QA: PASS (isolated empty/version/error, AX, keyboard, 390/1440px)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
