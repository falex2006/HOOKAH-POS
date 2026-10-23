const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const marker = '(function mountRussianPhoneFormat(){';
const readMount = file => { const source = fs.readFileSync(file, 'utf8'); const start = source.indexOf(marker); assert.ok(start >= 0, file); const end = source.indexOf('\n})();', start); assert.ok(end > start, file); return source.slice(start, end + 6); };
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  let checks = 0;
  try {
    for (const file of ['portal.js', 'app.js', 'phone-format.js']) {
      assert.equal(readMount(file).replaceAll('\r\n', '\n'), readMount('dist/' + file).replaceAll('\r\n', '\n'), file + ' published parity');
      for (const variant of [file, 'dist/' + file]) {
        const page = await browser.newPage();
        const input = page.locator('#qa-phone');
        const setup = async () => { await page.setContent('<label>Телефон<input id="qa-phone" type="tel" placeholder="+7 900 123-45-67"></label><button>Дальше</button>'); await page.addScriptTag({ content: readMount(variant) }); await input.click(); };
        const expected = '+7 (900) 123-45-67';
        for (const mode of ['national', 'international', 'eight', 'paste', 'fill']) {
          await setup();
          if (mode === 'national') await input.pressSequentially('9001234567');
          if (mode === 'international') await input.pressSequentially('+79001234567');
          if (mode === 'eight') await input.pressSequentially('89001234567');
          if (mode === 'fill') await input.fill('+7 900 123 45 67');
          if (mode === 'paste') await page.evaluate(() => { const i = document.querySelector('input'); i.setRangeText('+7 900 123 45 67', i.selectionStart, i.selectionEnd, 'end'); i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); });
          await page.getByRole('button').click();
          assert.equal(await input.inputValue(), expected, variant + ' ' + mode); checks++;
        }
        await setup(); await input.pressSequentially('9001234567');
        for (let i = 0; i < 24; i++) await input.press('Backspace');
        assert.equal(await input.inputValue(), '', variant + ' backspace clears without punctuation trap'); checks++;
        await page.getByRole('button').click(); assert.equal(await input.inputValue(), '');
        await setup(); await input.fill(expected);
        for (let i = 0; i < 4; i++) await input.press('Backspace');
        await page.getByRole('button').click();
        assert.equal(await input.inputValue(), '+7 (900) 123-4', variant + ' partial deletion normalizes on blur'); checks++;
        await input.fill('+7 '); await page.getByRole('button').click();
        assert.equal(await input.inputValue(), '', variant + ' incomplete country-only value clears'); checks++;
        await setup(); await input.fill(expected);
        await input.press('Home'); await input.press('ArrowRight'); await input.press('ArrowRight'); await input.press('ArrowRight'); await input.press('ArrowRight');
        await input.press('9');
        const caret = await input.evaluate(i => ({ position: i.selectionStart, length: i.value.length }));
        assert.ok(caret.position < caret.length, variant + ' middle insertion keeps caret in middle'); checks++;
        await page.evaluate(() => { const i = document.createElement('input'); i.id = 'dynamic-phone'; i.type = 'tel'; document.body.append(i); });
        const dynamic = page.locator('#dynamic-phone'); await dynamic.click(); await dynamic.pressSequentially('9001234567');
        assert.equal(await dynamic.inputValue(), expected, variant + ' dynamic input'); checks++;
        await page.close();
      }
    }
    console.log(`PHONE ENTRY BROWSER: PASS (${checks} actual-source Chromium checks, source/dist for all three mounts; no business writes)`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
