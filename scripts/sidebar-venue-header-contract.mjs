import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const pages = [
  ['admin.html', 'admin/index.html'], ['orders.html', 'orders/index.html'],
  ['clients.html', 'clients/index.html'], ['reservations.html', 'reservations/index.html'],
  ['delivery.html', 'delivery/index.html'], ['inventory.html', 'inventory/index.html'],
  ['finance.html', 'finance/index.html'], ['finance-report.html', 'finance/report/index.html'],
  ['finance-categories.html', 'finance/categories/index.html'],
  ['integrations.html', 'integrations/index.html'], ['network.html', 'network/index.html'],
];
for (const [file, alias] of pages) {
  const html = read(file);
  const header = html.match(/<header class="portal-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, `${file}: management header is present`);
  assert.match(header, /<span class="muted">\s*<span data-venue-name>—<\/span>\s*\/\s*<\/span>/,
    `${file}: venue name starts as a truthful loading placeholder in the existing muted breadcrumb`);
  assert.equal([...header.matchAll(/\bdata-venue-name\b/g)].length, 1, `${file}: header has one venue name target`);
  assert.doesNotMatch(header, /Hookah POS\s*\//, `${file}: venue context does not hardcode the product name`);
  assert.match(html, /<picture class="hookah-pos-brand">[\s\S]*?hookah-pos-lockup/, `${file}: shared product brand remains in the sidebar`);
  for (const published of [`dist/${file}`, `dist/${alias}`]) {
    assert.equal(read(published), html, `${published}: published flat and alias templates match source`);
  }
}
const portal = read('portal.js');
assert.match(portal, /document\.querySelectorAll\('\[data-venue-name\]'\)\.forEach\(\(node\) => \{ node\.textContent = venue\.name \|\| 'Hookah POS'; \}\)/,
  'the existing venue API updates the header and supplies the product name only when the venue name is absent');
assert.match(portal, /document\.querySelectorAll\('\[data-venue-name\]'\)\.forEach\(\(node\) => \{ node\.textContent = 'Заведение недоступно'; \}\)/,
  'failed venue loading remains visibly distinct from a real venue name');
assert.match(portal, /document\.querySelectorAll\('\[data-venue-name\],\[data-venue-address\],\[data-metric\]'\)\.forEach\(\(node\) => \{ node\.textContent = '—'; \}\)/,
  'changing venue clears old context while data loads');
assert.equal(read('dist/portal.js'), portal, 'venue behavior source/dist parity');
const css = read('style.css');
assert.equal(read('dist/style.css'), css, 'header design source/dist parity');
assert.match(css, /\.velora-theme \.portal-header>\.header-context\{[^}]*min-width:0;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/,
  'desktop context can shrink and truncate a long venue name within its own allocated space');
assert.match(css, /\.velora-theme \.header-context>\.muted\{[^}]*display:inline-flex;[^}]*min-width:0;[^}]*white-space:nowrap/,
  'venue prefix retains the existing muted typography and can shrink beside the page title');
assert.match(css, /\.velora-theme \.header-context>\.muted>\[data-venue-name\]\{[^}]*min-width:0;[^}]*max-width:clamp\(100px,18vw,300px\);[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/,
  'long venue names truncate inside a bounded desktop slot instead of pushing header controls out');
assert.match(read('header-shell.js'), /context\.classList\.add\('header-context'\)/,
  'legacy and current templates share the same header context sizing');
console.log('SIDEBAR VENUE HEADER CONTRACT: PASS (11 management routes; venue API states; brand preserved; source/dist parity)');
