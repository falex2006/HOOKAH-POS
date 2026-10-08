import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
assert.match(app, /let products=staticStaffDemo\(\)\?demoProducts:\[\]/, 'only the intentionally static demo workspace may start with the built-in sample catalog');
assert.match(app, /let catalogState=staticStaffDemo\(\)\?'ready':'loading'/, 'the server-backed catalog must begin in a loading state');
assert.match(app, /const payload=await staffFetchJson\(`\/api\/products\?expectedVenueId=\$\{encodeURIComponent\(venueId\)\}`.*,\{cache:'no-store'\}\)/, 'catalog reads carry the active venue and bypass browser HTTP cache');
const boundaryStart = app.indexOf('const staffFetchJson=async');
const boundaryEnd = app.indexOf('const staffRoleLabels=', boundaryStart);
assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart);
assert.match(app.slice(boundaryStart, boundaryEnd), /if\(!response\.ok\)\{[\s\S]*error\.status=response\.status;throw error;/, 'shared API rejects failed responses before any sample catalog can be preserved');
assert.match(app, /if\(!Array\.isArray\(payload\?\.items\)\|\|String\(payload\.venueId\|\|venueId\)!==venueId\)throw new Error\('catalog_invalid_response'\)/, 'the catalog requires a valid list for the requested venue');
assert.match(app, /products=payload\.items\.map[\s\S]*?catalogState='ready'/, 'an empty successful API response must become the real empty catalog');
assert.match(app, /requestRevision!==catalogRequestRevision\|\|accessRevision!==staffAccessRevision\|\|venueId!==String\(floorVenueId\)/, 'obsolete request sequence, session, or venue cannot overwrite the current catalog');
assert.match(app, /catalogState='error'/, 'a failed current refresh enters the fail-closed error state');
assert.match(app, /if\(e\.target\.closest\('\.catalog-retry'\)\)\{if\(!catalogAddPending\)loadProducts\(\);return;\}/, 'catalog failure must expose a retry action without overlapping an add');
assert.match(app, /document\.querySelector\('\.primary'\)\?\.addEventListener\('click',\(\)=>\{catalog\.classList\.add\('open'\);loadProducts\(\);\}\)/, 'every catalog opening refreshes the list');
assert.match(app, /const refreshOpenCatalog=\(\)=>\{if\(catalog\?\.classList\.contains\('open'\)&&document\.visibilityState==='visible'\)loadProducts\(\);\}/, 'focus and visibility refresh only an open catalog in a visible tab');
assert.match(app, /window\.setInterval\(\(\)=>\{if\(catalog\?\.classList\.contains\('open'\)&&document\.visibilityState==='visible'\)loadProducts\(\);\},60000\)/, 'periodic refresh is bounded to an open visible catalog at 60 seconds');
assert.match(app, /catalogRequest&&catalogRequestContext===context\)return catalogRequest/, 'focus, visibility and timer triggers share one in-flight request');
assert.match(app, /catalog\.classList\.remove\('open'\);catalogRequestRevision\+\+;catalogRequest=null;catalogRequestContext='';/, 'closing the catalog invalidates any pending response');
assert.match(app, /catalogLoaded\?'Не удалось обновить каталог\. Список устарел; продажи временно недоступны\.'/ , 'a failed refresh clearly marks retained data as stale');

const productsRoute = server.indexOf("if (pathname === '/api/products' && req.method === 'GET')");
const productsRouteEnd = server.indexOf("if (pathname === '/api/recipes'", productsRoute);
assert.ok(productsRoute >= 0 && productsRouteEnd > productsRoute, 'products route is present');
assert.match(server.slice(productsRoute, productsRouteEnd), /res\.setHeader\('Cache-Control',\s*'no-store'\)/, 'server prevents HTTP caches from retaining a stale catalog');
assert.match(server.slice(productsRoute, productsRouteEnd), /expectedVenueId.*venue_context_changed/, 'server rejects a request whose active venue changed');

const drawStart = app.indexOf("function draw(q='')");
const loadStart = app.indexOf('async function loadProducts', drawStart);
assert.ok(drawStart >= 0 && loadStart > drawStart, 'catalog renderer and loader are present');
const drawSource = app.slice(drawStart, loadStart).trim();
const normalizeSearch = (value) => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escapeFloorText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const displayProductName = value => String(value ?? '').trim().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, prefix, letter) => prefix + letter.toLocaleUpperCase('ru-RU'));
const staffIcon = () => '<svg aria-hidden="true"></svg>';
const render = (state, items = [], query = '', loaded = false) => {
  const grid = { innerHTML: '' };
  const draw = new Function('grid', 'catalogState', 'products', 'normalizeSearch', 'escapeFloorText', 'displayProductName', 'staffIcon', 'catalogAddPending', 'catalogLoaded', `${drawSource}; return draw;`)(grid, state, items, normalizeSearch, escapeFloorText, displayProductName, staffIcon, false, loaded);
  draw(query);
  return grid.innerHTML;
};

const loading = render('loading');
assert.match(loading, /role="status"/);
assert.doesNotMatch(loading, /class="product"/);
const failed = render('error');
assert.match(failed, /role="alert"/);
assert.match(failed, /class="button small catalog-retry"/);
const stale = render('error', [['Old', 200, [], null, 'old']], '', true);
assert.match(stale, /устарел/);
assert.doesNotMatch(stale, /class="product"/, 'stale products are hidden and cannot be added after a failed refresh');
const empty = render('ready', []);
assert.match(empty, /Каталог пока пуст/);
assert.doesNotMatch(empty, /class="product"/);
const maliciousName = 'Комбо "Тест" <img src=x onerror=1>';
const populated = render('ready', [[maliciousName, 250, [], null, 'product-uuid']]);
assert.match(populated, /data-id="product-uuid"/);
assert.doesNotMatch(populated, /<img src=x onerror=1>/);
assert.match(populated, /&lt;img src=x onerror=1&gt;/);

console.log('STAFF CATALOG LOAD STATE CONTRACT: PASS (loading, empty, error/retry, server IDs and escaped product names)');
