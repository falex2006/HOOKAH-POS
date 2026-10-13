// Reuse read-only geometry/contrast checks on the task-owned local preview.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const qa = require('./pos-workspace-polish-browser-qa.cjs');
const dir = path.resolve('docs/design/POS_EMPLOYEE_WORKSPACE_2026-10-11/evidence/unified-style');
const expectedHref = fs.readFileSync('index.html', 'utf8').match(/href="([^"]*pos-workspace\.css\?rev=[^"]+)"/)[1];
fs.mkdirSync(dir, { recursive: true });
let browser;
const results = [];
async function surfaces(page) {
  return page.evaluate(() => {
    const paint = node => {
      const s = getComputedStyle(node), r = node.getBoundingClientRect();
      return { background:s.backgroundColor, border:s.borderTopColor, radius:s.borderTopLeftRadius,
        color:s.color, font:s.fontSize, height:r.height, y:r.y, shadow:s.boxShadow };
    };
    const cards = [...document.querySelectorAll('.pos-workspace-counter')];
    return { cards:cards.map(node => ({ ...paint(node),value:paint(node.querySelector('.pos-workspace-counter-value')),
      icon:paint(node.querySelector('svg')),unit:node.querySelector('.pos-workspace-counter-unit').textContent })),
      switch:paint(document.querySelector('.pos-workspace-switch')),
      choices:[...document.querySelectorAll('.app>main>.tabs>[data-zone-id],.floor-density-toolbar>[data-floor-fit]')].map(paint),
      activeChoices:[...document.querySelectorAll('.pos-workspace-view[aria-pressed="true"],.app>main>.tabs>[aria-selected="true"],[data-floor-fit][aria-pressed="true"]')].map(paint),
      unselectedTables:[...document.querySelectorAll('.table:not(.sel)')].map(paint) };
  });
}
async function run() {
  const [floor,orders] = await Promise.all([qa.api('/api/floor'),qa.api('/api/orders?withPricing=1')]);
  const active = orders.items.find(order => order.items.length>=3) || orders.items.find(order => order.items.length);
  assert.ok(active);
  browser = await chromium.launch({ channel:'chrome',headless:true }); qa.useBrowser(browser);
  for(const [width,height] of [[1920,1080],[1366,768],[1366,600],[1181,768],[1180,768],[320,740]]) {
    const page = await qa.newPage(width,height);
    await page.goto((JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-workspace-private.json','utf8'))).base);
    await qa.loaded(page);
    if(width===320||width===1180) {
      for(const value of ['dark','light']) {
        await qa.theme(page,value);
        const overview = await page.evaluate(() => ({overflow:document.documentElement.scrollWidth>innerWidth,
          controls:[...document.querySelectorAll('.pos-workspace-counter,.pos-workspace-switch,.app>main>.tabs>[data-zone-id]')].map(node=>{
            const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,height:rect.height};})}));
        assert.equal(overview.overflow,false,'narrow floor overview fits horizontally');
        for(const control of overview.controls) { assert.ok(control.left>=0&&control.right<=width+1);assert.ok(control.height>=44); }
        await page.screenshot({path:path.join(dir,`overview-${width}-${value}.png`)});
      }
    }
    await qa.selectOrder(page,active,floor);
    assert.equal(await page.locator('link[href*="pos-workspace.css"]').getAttribute('href'),expectedHref);
    for(const value of ['dark','light']) {
      await qa.theme(page,value); await page.locator('.order-head h2').click(); await page.mouse.move(0,0);
      const geometry = await qa.geometry(page); qa.checkGeometry(geometry);
      assert.ok(geometry.rows[0].quantity.bottom<=geometry.body.bottom+1,'first quantity visible before scrolling');
      const paint = await surfaces(page), samples = await qa.contrast(page);
      assert.equal(new Set(paint.cards.map(c=>c.background)).size,1,'counter surfaces share one neutral color');
      assert.equal(new Set(paint.cards.map(c=>c.border)).size,1,'counter borders share one neutral color');
      assert.equal(new Set(paint.cards.map(c=>c.value.color)).size,1,'all counts share primary text');
      assert.equal(new Set(paint.cards.map(c=>c.icon.color)).size,1,'all counter icons share secondary text');
      assert.equal(paint.switch.background,paint.cards[0].background);
      assert.equal(paint.switch.border,paint.cards[0].border);
      assert.equal(paint.switch.radius,paint.cards[0].radius);
      assert.ok(paint.switch.height>=64);
      if(width>600) for(const card of paint.cards) assert.equal(card.height,paint.switch.height,'desktop controls align vertically');
      for(const choice of paint.choices) { assert.ok(choice.height>=44);assert.equal(choice.radius,paint.cards[0].radius);assert.equal(choice.shadow,'none'); }
      assert.equal(new Set(paint.activeChoices.map(c=>c.background)).size,1,'active choices share the same raised surface');
      for(const table of paint.unselectedTables) assert.equal(table.background,paint.cards[0].background,'statuses do not tint whole table cards');
      await page.screenshot({path:path.join(dir,`floor-${width}-${height}-${value}.png`)});
      await qa.more(page);
      results.push({width,height,theme:value,geometry,paint,contrast:samples});
    }
    if(width===1366&&height===768) {
      await page.locator('.table.free').first().click();
      for(const value of ['dark','light']) { await qa.theme(page,value);await page.screenshot({path:path.join(dir,`empty-${value}.png`)}); }
      await page.locator('[data-pos-view="preparation"]').click();
      for(const value of ['dark','light']) { await qa.theme(page,value);await page.screenshot({path:path.join(dir,`preparation-${value}.png`)}); }
      await page.locator('[data-pos-counter="open"]').click();
      assert.match(await page.locator('body').getAttribute('class'),/staff-orders-view/,'Open accounts keeps its destination');
      await page.getByRole('button',{name:'Рабочий зал',exact:true}).click();
      await qa.loaded(page);
      await page.locator('[data-pos-counter="ready"]').click();
      assert.equal(await page.locator('.chips [data-filter="ready"]').getAttribute('aria-pressed'),'true','Ready orders keeps its filter');
      await page.getByRole('button',{name:'Рабочий зал',exact:true}).click(); await qa.loaded(page);
      await page.locator('[data-pos-counter="preparation"]').click();
      assert.ok(await page.locator('#preparation-queue').isVisible(),'Preparation counter keeps its destination');
      await page.route('**/api/orders?withPricing=1',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
      await page.reload();
      await page.waitForFunction(()=>document.querySelector('[data-pos-counter="open"]')?.dataset.state==='error');
      for(const value of ['dark','light']) {
        await qa.theme(page,value);
        const unknown = page.locator('[data-pos-counter="open"]');
        assert.equal(await unknown.isDisabled(),true);
        assert.equal(await unknown.locator('.pos-workspace-counter-value').innerText(),'—');
        assert.match(await unknown.locator('.pos-workspace-counter-unit').innerText(),/Нет связи/);
        await qa.contrast(page);
        await page.screenshot({path:path.join(dir,`unknown-${value}.png`)});
      }
    }
    await page.close();
  }
  assert.deepEqual(qa.errors,[]);assert.deepEqual(qa.writes,[]);
  fs.writeFileSync(path.join(dir,'qa.json'),JSON.stringify({createdAt:new Date().toISOString(),environment:'Chrome headless; task-owned loopback; real API GET plus explicit503 GET override',results,errors:qa.errors,writes:qa.writes},null,2));
  console.log('PASS:6 viewport/height cases x2themes; consistent paint/geometry/contrast/targets,3counter destinations,unknown state,More andfirstquantity;0errors/writes');
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();});
