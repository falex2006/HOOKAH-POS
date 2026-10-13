// Read-only visual/geometry QA on the task-owned local fixture; never submits an order or payment.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const manifest = JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-workspace-private.json', 'utf8'));
assert.equal(path.resolve(manifest.root), path.resolve('.'));
assert.equal(manifest.ownerTag, 'pos-employee-workspace-20261011');
assert.equal(manifest.state, 'ready');
assert.match(manifest.base, /^http:\/\/127\.0\.0\.1:\d+$/);
const expectedCssHref = fs.readFileSync('index.html', 'utf8').match(/href="([^"]*pos-workspace\.css\?rev=[^"]+)"/)[1];
const dir = path.resolve('docs/design/POS_EMPLOYEE_WORKSPACE_2026-10-11/evidence/final-polish');
fs.mkdirSync(dir, { recursive: true });
const results = [], errors = [], writes = [];
let browser;
async function api(route) {
  const response = await fetch(manifest.base + route, { headers: { authorization: 'Bearer ' + manifest.actors.bartender.token } });
  assert.ok(response.ok, 'fixture GET must succeed');
  return response.json();
}
async function newPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method());
  });
  await page.addInitScript(actor => {
    localStorage.setItem('crm_session_token', actor.token);
    localStorage.setItem('crm_session_user', JSON.stringify(actor.user));
  }, manifest.actors.bartender);
  return page;
}
async function loaded(page) {
  await page.waitForFunction(() => document.querySelector('[data-pos-counter="open"]')?.dataset.state === 'ready'
    && document.querySelector('#tables')?.dataset.dataState === 'ready');
}
async function selectOrder(page, order, floor) {
  const zone = floor.zones.find(room => room.tables.some(table => table.id === order.tableId));
  assert.ok(zone);
  const table = page.locator(`.table[data-table="${order.tableId}"]`);
  if (!(await table.count())) await page.getByRole('tab', { name: zone.name, exact: true }).click();
  await table.click();
  await page.waitForFunction(() => document.querySelector('.order')?.dataset.posState === 'populated');
  await page.waitForFunction(() => document.querySelector('.order-pricing-summary')?.textContent.includes('Оплачено'));
}
async function theme(page, value) {
  await page.evaluate(value => document.body.classList.toggle('light-theme', value === 'light'), value);
  await page.waitForTimeout(150);
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const order = document.querySelector('.order'), body = order.querySelector('.pos-order-body');
    const grid = document.querySelector('.floor-map-stage');
    const tableData = [...grid.querySelectorAll('.table')].map(table => {
      const r = rect(table), c = getComputedStyle(table);
      const children = [...table.children].filter(n => !n.classList.contains('pos-workspace-sr-only')).map(n => ({ cls: n.className, rect: rect(n), color: getComputedStyle(n).color }));
      return { rect: r, background: c.backgroundColor, outline: c.outlineStyle, selected: table.getAttribute('aria-pressed'), children };
    });
    const rows = [...order.querySelectorAll('.order-item-row')].map(row => ({ rect: rect(row), columns: getComputedStyle(row).gridTemplateColumns, name: rect(row.firstElementChild), quantity: rect(row.querySelector('.quantity-control')), price: rect(row.querySelector('[data-line-total]')) }));
    return { viewport: [innerWidth, innerHeight], overflow: document.documentElement.scrollWidth > innerWidth,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, tableData, tables: rect(document.querySelector('#tables')),
      order: rect(order), body: { ...rect(body), overflow: getComputedStyle(body).overflowY, client: body.clientHeight, scroll: body.scrollHeight },
      action: rect(document.querySelector('#order-main-action')), rows,
      controls: [...order.querySelectorAll('.quantity-control button')].map(rect),
      counters: [...document.querySelectorAll('.pos-workspace-counter')].map(node => {
        const label = node.querySelector('.pos-workspace-counter-label'), range = document.createRange(); range.selectNodeContents(label);
        return { label: rect(range), value: rect(node.querySelector('.pos-workspace-counter-value')) };
      }),
      pricing: order.querySelector('.order-pricing-summary')?.textContent,
      selected: tableData.filter(t => t.selected === 'true').length };
  });
}
function checkGeometry(result) {
  const [width, height] = result.viewport;
  assert.equal(result.overflow, false, `no horizontal page overflow at ${width}`);
  assert.equal(result.selected, 1);
  assert.ok(result.action.height >= 48 && result.action.bottom <= height + 1, `primary CTA visible at ${width}x${height}`);
  assert.equal(result.body.overflow, 'auto');
  assert.ok(result.body.height > 60, 'order body retains a usable scroll area');
  for (const counter of result.counters) assert.ok(counter.label.right <= counter.value.x - 3, 'counter label and value do not overlap');
  for (const control of result.controls) assert.ok(control.width >= 44 && control.height >= 44, 'quantity target >=44');
  if (width >= 1181) assert.ok(result.order.y < result.tables.y, 'desktop order starts above table cards to retain useful space');
  for (const table of result.tableData) {
    assert.ok(table.rect.height >= 132);
    for (const child of table.children) if (child.rect.height && child.rect.width) {
      assert.ok(child.rect.x >= table.rect.x - 1 && child.rect.right <= table.rect.right + 1, 'table child contained horizontally');
      assert.ok(child.rect.y >= table.rect.y - 1 && child.rect.bottom <= table.rect.bottom + 1, 'table child contained vertically');
    }
    const visible = table.children.filter(c => c.rect.height && c.rect.width);
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i].rect, b = visible[j].rect;
      const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      assert.ok(intersection < 1, 'table text, total, badge, equipment and timer do not overlap');
    }
  }
  for (const row of result.rows) {
    if (row.columns.split(' ').length === 3) {
      assert.ok(row.name.right <= row.quantity.x + 1 && row.quantity.right <= row.price.x + 1, 'desktop row uses three nonoverlapping columns');
    }
    assert.ok(row.price.right <= row.rect.right + 1 && row.quantity.right <= row.rect.right + 1);
  }
}
async function contrast(page) {
  const samples = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0,0,1,1); ctx.fillStyle = color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].map((n,i) => i === 3 ? n/255 : n); };
    const over = (fg,bg) => fg.slice(0,3).map((n,i) => n * fg[3] + bg[i] * (1-fg[3])).concat(1);
    const backdrop = node => { const chain=[]; for(let n=node;n;n=n.parentElement) chain.unshift(n); return chain.reduce((bg,n) => over(rgba(getComputedStyle(n).backgroundColor),bg),[255,255,255,1]); };
    const luminance = rgb => rgb.slice(0,3).map(n => { const x=n/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4; }).reduce((sum,n,i) => sum+n*[.2126,.7152,.0722][i],0);
    const ratio = (a,b) => { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    const samples=[];
    const selectors=['.table>strong','.table>em','.table>small','.table-order-total','.pos-table-attention','.pos-workspace-counter-label','.pos-workspace-counter-value','.pos-workspace-counter-unit','.order .meta','.order-pricing-summary>span','.order-next-step','.order-tabs b','.order-tabs button','.order-item-row>span:first-child>span','.order-item-attribution','.order-more>summary','#order-main-action'];
    for(const selector of selectors) for(const node of document.querySelectorAll(selector)) {
      if(!node.getClientRects().length) continue;
      const style=getComputedStyle(node), bg=backdrop(node); let opacity=1;
      for(let n=node;n;n=n.parentElement) opacity*=Number(getComputedStyle(n).opacity);
      const fg=rgba(style.color);fg[3]*=opacity;
      samples.push({selector,kind:'text',fg:over(fg,bg),bg,opacity,ratio:ratio(over(fg,bg),bg)});
    }
    for(const node of document.querySelectorAll('.order .quantity-control button,.pos-workspace-counter,.pos-workspace-switch,.app>main>.tabs>[data-zone-id],.floor-density-toolbar>[data-floor-fit]')) {
      const style=getComputedStyle(node),bg=backdrop(node),border=rgba(style.borderTopColor);
      samples.push({selector:node.className,kind:'border',fg:border,bg,opacity:Number(style.opacity),ratio:ratio(border,bg)});
      const svg=node.querySelector('svg'); if(svg){const icon=rgba(getComputedStyle(svg).color);samples.push({selector:node.className+' svg',kind:'icon',fg:icon,bg,opacity:Number(style.opacity),ratio:ratio(icon,bg)});}
    }
    return samples;
  });
  for(const sample of samples) assert.ok(sample.ratio >= (sample.kind==='text'?4.5:3), sample.selector+' effective '+sample.kind+' contrast '+sample.ratio.toFixed(2));
  return samples;
}
async function more(page) {
  const summary = page.locator('.order-more > summary');
  await summary.click();
  const bounds = await page.locator('.order-more[open]').boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height + 1, 'More remains within viewport');
  await summary.press('Escape');
  assert.equal(await page.locator('.order-more').getAttribute('open'), null);
  assert.equal(await summary.evaluate(n => n === document.activeElement), true);
}
async function run() {
  const [floor, orders] = await Promise.all([api('/api/floor'), api('/api/orders?withPricing=1')]);
  const active = orders.items.find(order => order.items.some(item => item.preparationStatus === 'new') && order.items.length >= 3);
  assert.ok(active, 'mixed active fixture order required');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [width, height] of [[1920,1080],[1528,780],[1366,768],[1366,600],[1181,768],[1180,768],[768,1024],[600,900],[390,844],[320,740]]) {
    const page = await newPage(width, height);
    await page.goto(manifest.base); await loaded(page); await selectOrder(page, active, floor);
    assert.equal(await page.locator('link[href*="pos-workspace.css"]').getAttribute('href'), expectedCssHref);
    for (const value of ['dark', 'light']) {
      await theme(page, value);
      const result = await geometry(page); checkGeometry(result);
      assert.ok(result.rows[0].quantity.bottom <= result.body.bottom + 1, 'first item quantity is initially visible without scrolling');
      result.contrast = await contrast(page);
      assert.equal(result.rows.length, active.items.length);
      assert.match(result.pricing, /Оплачено/); assert.match(result.pricing, /Осталось/);
      if (width >= 1366 && height >= 768) assert.ok(result.columns >= 3, 'desktop small hall no longer becomes one or two giant columns');
      await page.screenshot({ path: path.join(dir, `floor-${width}-${height}-${value}.png`) });
      await more(page);
      await page.locator('.pos-order-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const scrolled = await geometry(page); checkGeometry(scrolled);
      await page.locator('.pos-order-body').evaluate(node => { node.scrollTop = 0; });
      results.push({ width, height, theme: value, state: 'mixed-order', ...result });
    }
    if (width === 1366 && height === 768) {
      await page.locator('#floor-density-range').evaluate(input => { input.value = '70'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.reload(); await loaded(page);
      assert.equal(await page.locator('#floor-density-range').inputValue(), '70', 'manual preference survives reload');
      assert.equal(await page.locator('[data-floor-fit]').getAttribute('aria-pressed'), 'false');
      await page.locator('[data-floor-fit]').click(); assert.equal(await page.locator('[data-floor-fit]').getAttribute('aria-pressed'), 'true');
      await selectOrder(page, active, floor);
      const allTables = floor.zones.flatMap(zone => zone.tables).map(table => table.id === active.tableId ? { ...table, name: 'Большой стол у панорамного окна — длинное название', layout: { ...table.layout, amenities: { playstation5: true, television: true } } } : table);
      const largerHall = { ...floor, zones: [{ ...floor.zones[0], tables: allTables }] };
      await page.route('**/api/floor', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(largerHall) }));
      await page.reload(); await loaded(page); await selectOrder(page, active, largerHall);
      for (const value of ['dark', 'light']) {
        await theme(page, value); const result = await geometry(page); checkGeometry(result);
        assert.equal(result.tableData.length, allTables.length);
        assert.equal(await page.locator('.table.sel .table-amenity').count(), 2);
        assert.match(await page.locator('.table.sel').getAttribute('aria-label'), /панорамного окна/);
        assert.match(await page.locator('.floor-density-status').innerText(), /при прокрутке/);
        await page.screenshot({ path: path.join(dir, `long-name-equipment-${value}.png`) });
        results.push({ width, height, theme: value, state: 'ten-tables-long-equipment', ...result });
      }
      for(const boundaryHeight of [820,840,860]) {
        await page.setViewportSize({width:1366,height:boundaryHeight}); await page.waitForTimeout(250);
        for(const value of ['dark','light']) {
          await theme(page,value);
          const fit = await page.evaluate(() => {
            const tables=document.querySelector('#tables'),status=document.querySelector('.floor-density-status'),toolbar=document.querySelector('.floor-density-toolbar');
            const compensation=status.textContent ? status.getBoundingClientRect().height+(parseFloat(getComputedStyle(toolbar).rowGap)||0) : 0;
            const top=tables.getBoundingClientRect().top+(tables.closest('main')?.scrollTop||0)+scrollY-compensation;
            return {actual:tables.querySelector('.floor-map-stage').getBoundingClientRect().height, available:innerHeight-top-28, warning:status.textContent};
          });
          assert.equal(Boolean(fit.warning),fit.actual>fit.available+1,'Fit warning follows actual content height');
          results.push({width:1366,height:boundaryHeight,theme:value,state:'fit-rendered-height-boundary',...fit});
        }
      }
      await page.setViewportSize({width,height});
      await page.unroute('**/api/floor');
      await page.reload(); await loaded(page);
      await page.locator('.table.free').first().click();
      for (const value of ['dark', 'light']) {
        await theme(page, value);
        const add = await page.locator('.order > .primary').boundingBox();
        assert.ok(add.height >= 44 && add.y + add.height <= height + 1);
        await page.screenshot({ path: path.join(dir, `empty-order-${value}.png`) });
      }
      await page.locator('[data-pos-view="preparation"]').click();
      for (const value of ['dark', 'light']) {
        await theme(page, value); assert.ok(await page.locator('#preparation-queue').isVisible());
        await page.screenshot({ path: path.join(dir, `preparation-${value}.png`) });
      }
    }
    await page.close();
  }
  const manual = await newPage(1366, 768);
  const freeRoom = { ...floor, zones: [{ ...floor.zones[0], tables: floor.zones.flatMap(zone => zone.tables).map(table => ({ ...table, status: 'free', reservation: null, layout: { ...table.layout, amenities: {} } })) }] };
  await manual.route('**/api/floor', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(freeRoom) }));
  await manual.route('**/api/orders?withPricing=1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...orders, items: [] }) }));
  await manual.goto(manifest.base); await loaded(manual);
  await manual.locator('#floor-density-range').evaluate(input => { input.value = '70'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await manual.waitForTimeout(100);
  for (const value of ['dark', 'light']) {
    await theme(manual, value);
    const actual = await manual.locator('.table').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.equal(actual.length, freeRoom.zones[0].tables.length);
    assert.ok(actual.every(height => Math.abs(height - 108) < 1), 'manual70 retains the original 108px free cards in a dense hall');
    assert.equal(await manual.locator('.floor-density-status').innerText(), '', 'readable manual70 grid really fits without hidden overflow');
    await manual.screenshot({ path: path.join(dir, `manual70-dense-hall-${value}.png`) });
    results.push({ width: 1366, height: 768, theme: value, state: 'manual70-ten-free-tables', heights: actual });
  }
  await manual.locator('#floor-density-range').evaluate(input => { input.value = '130'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await manual.locator('.floor-density-status').innerText(), /при прокрутке/);
  await manual.close();
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  fs.writeFileSync(path.join(dir, 'qa.json'), JSON.stringify({ createdAt: new Date().toISOString(), environment: 'Chrome headless; real local API GET; explicitly simulated long-name/equipment GET only', results, errors, writes }, null, 2));
  console.log('PASS: 10 viewport/height cases x 2 themes; panels, card content, rows, scroll, More, CTA, manual reload, long/equipment, empty and preparation; 0 API writes/JS errors');
}
module.exports = { api, newPage, loaded, selectOrder, theme, geometry, checkGeometry, contrast, more,
  errors, writes, useBrowser(value) { browser = value; } };
if (require.main === module) run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
