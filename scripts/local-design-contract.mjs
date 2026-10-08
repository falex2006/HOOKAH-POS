import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { publishedHtmlFiles, routeAliases, publishedHtmlPaths, localPreviewHtmlFiles } from './published-html-manifest.mjs';

const root = new URL('../', import.meta.url);
const htmlFiles = publishedHtmlFiles;
for (const file of readdirSync(root).filter(file => file.endsWith('.html'))) {
  assert.ok(htmlFiles.includes(file) || localPreviewHtmlFiles.includes(file), `undeclared root HTML: ${file}`);
}
assert.ok(htmlFiles.length >= 14, 'all application HTML routes should be present');
const syncScript = readFileSync(new URL('../scripts/sync-published-assets.mjs', import.meta.url), 'utf8');
const shiftCloseContract = readFileSync(new URL('../shift-close-contract.js', import.meta.url), 'utf8');
const cssRevision = Number(syncScript.match(/cssRevision = '(\d+)'/)?.[1]);
const portalRevision = Number(syncScript.match(/portalRevision = '(\d+)'/)?.[1]);
const portalSessionRevision = Number(syncScript.match(/portalSessionRevision = '(\d+)'/)?.[1]);
const appRevision = Number(syncScript.match(/appRevision = '(\d+)'/)?.[1]);
const platformRevision = Number(syncScript.match(/platformRevision = '(\d+)'/)?.[1]);
assert.ok([cssRevision, portalRevision, portalSessionRevision, appRevision, platformRevision].every(Number.isInteger), 'published asset revisions must be declared in the sync script');
const portalSession = readFileSync(new URL('../portal-session.js', import.meta.url), 'utf8');
const distPortalSession = readFileSync(new URL('../dist/portal-session.js', import.meta.url), 'utf8');
assert.match(portalSession, new RegExp(`portal\\.js\\?rev=${portalRevision}`), 'session bootstrap must load the canonical portal script revision');
assert.equal(distPortalSession, portalSession, 'published session bootstrap must match its canonical source');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
assert.match(appSource, /floorPixelPlacement/, 'POS must convert floor layouts through one pixel contract');
assert.match(appSource, /layout\.unit==='grid'/, 'legacy grid layouts must remain readable');
assert.match(appSource, /layout\.unit==='px'/, 'new editor pixel layouts must remain exact');
assert.match(appSource, /data-layout-x/, 'rendered POS tables must expose canonical geometry');
for (const file of htmlFiles) {
  const html = readFileSync(new URL(file, root), 'utf8');
  assert.match(html, new RegExp(`style\\.css\\?rev=${cssRevision}`), `${file} must use current CSS cache version`);
  assert.doesNotMatch(html, /style\.css\?rev=(?:12[0-7]|1[01]\d)/, `${file} has stale CSS cache version`);
  if (file !== 'index.html' && file !== 'login.html' && file !== 'platform.html') assert.match(html, new RegExp(`portal-session\\.js\\?rev=${portalSessionRevision}`), `${file} must use the current session bootstrap revision`);
  if (file === 'index.html') assert.match(html, new RegExp(`app\\.js\\?rev=${appRevision}`), 'index.html must use current staff app JS cache version');
  if (file === 'index.html') assert.match(html, /assets\/tabler-icons\.svg\?rev=3#table-layout/, 'staff workspace must use the refreshed icon sprite');
  if (file === 'platform.html') assert.match(html, new RegExp(`platform\\.js\\?rev=${platformRevision}`), 'platform.html must use current platform JS cache version');
}
const distRoot = new URL('../dist/', import.meta.url);
assert.match(syncScript, /cpSync\(resolve\(root, 'shift-close-contract\.js'\), resolve\(root, 'dist', 'shift-close-contract\.js'\)\)/,
  'the shared shift close contract is copied to the published static directory');
assert.equal(readFileSync(new URL('../dist/shift-close-contract.js', import.meta.url), 'utf8'), shiftCloseContract,
  'the published checklist contract matches its source');
assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /shift-close-contract\.js\?rev=\d+/);
assert.match(readFileSync(new URL('../admin.html', import.meta.url), 'utf8'), /shift-close-contract\.js\?rev=\d+/);
const distHtmlFiles = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.html')) distHtmlFiles.push(path);
  }
};
walk(distRoot);
assert.deepEqual(distHtmlFiles.map(url => decodeURIComponent(url.href.slice(distRoot.href.length))).sort(),
  [...publishedHtmlPaths].sort(), 'dist HTML must exactly match the declared CRM routes');
assert.ok(distHtmlFiles.length >= htmlFiles.length, 'dist must contain all published HTML routes');
for (const fileUrl of distHtmlFiles) {
  const html = readFileSync(fileUrl, 'utf8');
  assert.match(html, new RegExp(`style\\.css\\?rev=${cssRevision}`), `${fileUrl.pathname} must use current CSS cache version`);
  if (!/\/login(?:\/|\.html)/.test(fileUrl.pathname) && !/\/platform(?:\/|\.html)/.test(fileUrl.pathname) && !fileUrl.pathname.endsWith('/dist/index.html')) {
    assert.match(html, new RegExp(`portal-session\\.js\\?rev=${portalSessionRevision}`), `${fileUrl.pathname} must use current session bootstrap revision`);
  }
}
for (const file of htmlFiles) {
  assert.equal(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
    `flat dist/${file} must match its current source template`);
}
for (const [alias, source] of Object.entries(routeAliases)) {
  assert.equal(readFileSync(new URL(`../dist/${alias}`, import.meta.url), 'utf8'), readFileSync(new URL(`../${source}`, import.meta.url), 'utf8'),
    `directory route dist/${alias} must match source ${source}`);
}
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(portal, /finance-categories-panel[\s\S]*?finance-category-filters/, 'finance category controls must have a page-specific responsive wrapper');
assert.match(css, /\.velora-theme \.finance-category-filters\{display:grid;grid-template-columns:minmax\(0,1\.35fr\) minmax\(180px,1fr\)/, 'finance category controls must share the available panel width');
assert.match(css, /@media\(max-width:900px\)\{\.velora-theme \.finance-categories-panel>\.panel-head\{display:grid;grid-template-columns:minmax\(0,1fr\)/, 'finance category panel header must stack on Fold-sized viewports');
assert.match(css, /@media\(max-width:520px\)\{\.velora-theme \.finance-category-filters\{grid-template-columns:minmax\(0,1fr\)\}/, 'finance category controls must become a single column on phone widths');
assert.match(css, /\.platform-main>\.platform-content\{[^}]*width:100%[^}]*min-width:0[^}]*box-sizing:border-box/,
  'the platform workspace must respect the available width beside its sidebar');
assert.match(css, /@media\(max-width:1180px\)\{\.platform-hero\{align-items:flex-start;flex-direction:column\}\}/,
  'the platform hero must stack before tablet content is squeezed by the persistent sidebar');
assert.match(portal, /staffPanel\.classList\.add\('staff-directory-only'\)/, 'staff directory must mark the drawer-only layout');
assert.match(css, /\.staff-panel\.staff-directory-only \.staff-layout\{grid-template-columns:minmax\(0,1fr\);gap:0\}/, 'staff directory must reclaim the drawer column width');
assert.match(css, /\.velora-theme \.staff-row\.inactive\{grid-template-columns:34px minmax\(0,1fr\) 100px max-content max-content max-content\}/, 'inactive staff rows must reserve separate columns for restore and archive actions');
assert.match(css, /@media\(max-width:720px\)[\s\S]*?\.staff-row\.inactive\{grid-template-columns:34px minmax\(0,1fr\) max-content;grid-template-areas:[^}]*"avatar archive archive"\}/, 'inactive staff actions must wrap into named, non-overlapping areas on compact screens');
assert.match(css, /\.dashboard-kpi-grid>\.dashboard-revenue-card \.dashboard-revenue-main>strong\{[^}]*white-space:nowrap;overflow-wrap:normal\}/, 'dashboard revenue amount and currency must stay together on one line');
assert.match(css, /\.velora-theme a\.button[^}]*text-decoration:none!important/);
assert.match(css, /\.portal-nav a[^}]*text-decoration:none/);
for (const file of ['admin.html', 'orders.html', 'inventory.html']) {
  assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /assets\/tabler-icons\.svg/,
    `${file} must use Tabler Icons`);
}
console.log(`LOCAL DESIGN CONTRACT: PASS (routes=${htmlFiles.length}, dist routes=${distHtmlFiles.length}, CSS rev=${cssRevision}, portal bootstrap rev=${portalSessionRevision} -> portal rev=${portalRevision}, action links and Tabler Icons)`);



