import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publishedHtmlFiles, publishedHtmlPaths } from './published-html-manifest.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const helper = read('staff-display-name.js');
const context = { window: {} };
vm.runInNewContext(helper, context);
const compact = context.window.HookahStaffDisplayName;
for (const [name, expected] of [
  ['Печеников Роман Александрович', 'Роман'],
  ['Печеников Роман', 'Роман'], ['Роман Печеников', 'Роман'],
  ['Лев Печеников', 'Лев'], ['Печеников Лев', 'Лев'],
  ['Анна Мария', 'Анна Мария'], ['Никита Ильин', 'Никита Ильин'],
  ['  Роман  ', 'Роман'], ['', 'Сотрудник'],
]) {
  const user = { name, role: 'hookah_master' };
  assert.equal(compact(user), expected, name);
  assert.equal(user.name, name, 'display helper must not mutate identity');
}
for (const role of ['owner', 'admin', 'manager', 'developer']) {
  assert.equal(compact({ name: 'Печеников Роман', firstName: 'Роман', role }), 'Печеников Роман');
}
assert.equal(compact({ fullName: 'Печеников Роман', role: 'bartender' }), 'Роман');
assert.equal(compact({ name: 'Неоднозначное Имя', firstName: 'Роман', role: 'bartender' }), 'Роман');
assert.equal(compact(), 'Сотрудник');
assert.equal(read('dist/staff-display-name.js'), helper);
const publicFiles = read('server.js').match(/const publicFiles = new Set\(\[([\s\S]*?)\]\)/)?.[1];
assert.ok(publicFiles, 'server static asset allowlist exists');
assert.match(publicFiles, /['"]\/staff-display-name\.js['"]/, 'helper is publicly served before session bootstrap');
assert.match(read('Dockerfile'), /^COPY[^\n]*\bstaff-display-name\.js\b[^\n]*\.\/$/m, 'production image contains the header helper');

let checked = 0;
for (const path of [...publishedHtmlFiles, ...publishedHtmlPaths.map((path) => `dist/${path}`)]) {
  const html = read(path);
  const boot = html.match(/<script src="\/(?:app|portal-session)\.js\?rev=\d+"><\/script>/);
  if (!boot) continue;
  const helpers = [...html.matchAll(/<script src="\/staff-display-name\.js\?rev=\d+"><\/script>/g)];
  assert.equal(helpers.length, 1, `${path}: load name helper exactly once`);
  assert.ok(helpers[0].index < boot.index, `${path}: helper precedes application bootstrap`);
  checked++;
}
assert.ok(checked >= 30, 'exercise published POS and portal templates plus route aliases');

const app = read('app.js');
const start = app.indexOf('const drawTableContextActions=');
const end = app.indexOf('\nfunction drawOrder(', start);
assert.ok(start >= 0 && end > start);
const container = { innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
const renderContext = { tableContextActions: container, staffSessionPermissions: new Set(['reservations', 'orders']), currentShift: {}, staffIcon: () => '' };
vm.runInNewContext(`${app.slice(start, end)};this.render=drawTableContextActions;`, renderContext);
renderContext.render({ id: 'table-a', status: 'occupied' }, { id: 'order-a' });
assert.match(container.innerHTML, /data-table-action="close-panel"/);
assert.doesNotMatch(container.innerHTML, /<details|data-table-action="transfer"/);
renderContext.render({ id: 'table-a', status: 'free' }, null);
assert.match(container.innerHTML, /data-table-action="reserve"/);
renderContext.render({ id: 'table-a', status: 'reserved' }, null);
assert.match(container.innerHTML, /data-table-action="open-reservation"/);
assert.match(container.innerHTML, /data-table-action="seat-guest"/);
renderContext.currentShift = null;
renderContext.render({ id: 'table-a', status: 'reserved' }, null);
assert.match(container.innerHTML, /data-table-action="seat-guest" disabled/);
assert.doesNotMatch(container.innerHTML, /data-table-action="close-panel" disabled/);
assert.equal([...read('index.html').matchAll(/id="transfer-order"/g)].length, 1);
assert.match(app, /const ids=\[[^\]]*'transfer-order'/, 'original transfer button remains in the single More menu');
assert.match(app, /node\.title=name/, 'POS retains full-name tooltip');
assert.match(read('portal.js'), /node\.title = portalHeaderName/, 'portal retains full-name tooltip');
for (const file of ['app.js', 'portal.js', 'style.css']) assert.equal(read(file), read(`dist/${file}`), `${file} publication parity`);
console.log(`STAFF WORKSPACE POLISH QA: PASS (name rules, unchanged identities, ${checked} bootstraps, context actions, one transfer/More menu, dist parity)`);
