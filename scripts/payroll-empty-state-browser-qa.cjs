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

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<main id="page-content" class="finance-workspace finance-payroll-workspace"><section id="payroll"></section></main>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'style.css'), 'utf8') + '\n' + css });
    await page.evaluate(({ component, escape }) => {
      window.qaSnapshot = { current: null, history: [] };
      window.qaError = false;
      window.qaWrites = [];
      // Execute actual component source with an in-memory, read-only API substitute.
      const request = async (url, options) => {
        if (options?.method === 'POST') window.qaWrites.push(JSON.parse(options.body));
        if (window.qaError) throw new Error('offline');
        return url.endsWith('/employees') ? { items: [] } : window.qaSnapshot;
      };
      const payrollPanel = document.querySelector('#payroll');
      const anchor = payrollPanel.appendChild(document.createElement('section'));
      eval(escape + '\n' + component + '\n' + 'mountEmploymentEligibilityPanel(payrollPanel, anchor);');
    }, { component, escape });
    const status = page.locator('[data-eligibility-status]');
    const current = page.locator('[data-eligibility-current]');
    await page.waitForFunction(() => document.querySelector('[data-eligibility-current]').textContent.includes('История ещё не настроена.'));
    assert.equal(await status.textContent(), '');
    assert.equal(((await page.locator('.finance-payroll-eligibility').innerText()).match(/История ещё не настроена\./g) || []).length, 1);
    assert.match(await current.textContent(), /расчёт по схеме оплаты недоступен/);
    const edit=page.locator('[data-eligibility-edit]');
    const form=page.locator('[data-eligibility-editor]');
    for (const width of [390, 1440]) {
      await page.setViewportSize({width,height:900});
      assert.match(await edit.ariaSnapshot(), /Настроить список/);
      await edit.focus(); await page.keyboard.press('Enter');
      assert.equal(await form.isVisible(),true);
      await form.locator('[data-eligibility-cancel]').focus(); await page.keyboard.press('Space');
      assert.equal(await form.isVisible(),false);
    }
    await page.evaluate(() => { window.qaSnapshot = { current: { revisionNo: 2, createdByName: 'Владелец', periods: [] }, history: [] }; });
    await page.locator('[data-eligibility-reload]').click();
    await page.waitForFunction(() => document.querySelector('[data-eligibility-status]').textContent.includes('версия 2'));
    assert.match(await current.textContent(), /Сохранена пустая версия/);
    await edit.click();
    const reason=page.locator('[data-eligibility-reason]');
    await reason.fill('Уточнён состав сотрудников');
    await page.locator('[data-eligibility-empty-confirm]').check();
    await page.evaluate(() => { window.qaError = true; });
    await page.locator('[data-eligibility-reload]').click();
    await page.waitForFunction(() => document.querySelector('[data-eligibility-status]').textContent.includes('Не удалось'));
    assert.match(await current.textContent(), /Сохранение временно недоступно/);
    const save=page.locator('[data-eligibility-save]');
    assert.equal(await save.isDisabled(),true);
    await form.evaluate(el=>el.requestSubmit());
    assert.deepEqual(await page.evaluate(()=>window.qaWrites),[]);
    await page.evaluate(()=>{window.qaError=false;});
    await page.locator('[data-eligibility-reload]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-eligibility-save]').disabled);
    assert.equal(await reason.inputValue(),'Уточнён состав сотрудников');
    console.log('PAYROLL EMPTY STATE BROWSER QA: PASS (isolated empty/version/error, AX, keyboard, 390/1440px)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
