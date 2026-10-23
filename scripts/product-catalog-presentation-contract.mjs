import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

for (const label of ['Категория меню', 'Направление приготовления', 'Сортировка', 'Все категории', 'Все направления', 'По названию', 'По категории', 'Сначала дешевле', 'Сначала дороже']) {
  assert.ok(portal.includes(label), `catalog filter/sort control is missing: ${label}`);
}
for (const view of ['list', 'table', 'cards']) {
  assert.ok(portal.includes(`data-product-view="${view}"`), `catalog view control is missing: ${view}`);
}
assert.match(portal, /item\.preparationStation === preparation/,
  'preparation filter must use the dedicated product preparation field');
assert.match(portal, /itemCategory === category/,
  'menu category filter must use the product category text field');
assert.match(portal, /const effectiveProductView = \(\) => window\.matchMedia\('\(max-width: 760px\)'\)\.matches \? 'list' : productCatalogView/,
  'narrow screens must always use the single list representation');
assert.match(portal, /productCatalogViewKey.*hookah_pos_product_catalog_view_/,
  'desktop display preference must be stored per signed-in catalog owner');
assert.ok(portal.includes("productDetailDialog.id = 'product-detail-dialog'"),
  'products must have an explicit read-only detail dialog');
assert.match(portal, /ui\.critical\(\{ element: productDetailDialog/,
  'product detail dialog must use the shared modal lifecycle');
assert.match(portal, /productDetailsShell\.open\(/,
  'the product detail action must open the accessible shared dialog');
assert.match(portal, /id="product-detail-edit"/,
  'the product detail modal exposes an explicit edit action');
assert.match(portal, /product-icon-action product-edit/,
  'secondary product edit action must be compact and accessible by name');
assert.match(portal, /const actions = item => `<div class="product-card-actions">\$\{editAction\(item\)\}<\/div>`/,
  'catalog row action renderer must preserve the direct edit action');
assert.doesNotMatch(portal, /const photoAction = item/,
  'photo replacement should live in the product editor rather than repeat on every catalog row');
assert.match(portal, /product-image-action-label/, 'editor photo action must have dynamic upload/replace wording');
assert.match(portal, /product-tile-category/, 'card view must place category in one dedicated metadata field');
assert.match(portal, /product-tile-preparation">Направление:/, 'card view must label preparation separately from menu category');
assert.match(css, /product-tile \.visual-product-placeholder span\{display:none\}/,
  'card placeholder must not repeat the category already shown in metadata');
assert.match(css, /#visual-catalog\[data-view="list"\][^{]*\{display:grid;grid-template-columns:minmax\(0,1fr\)/,
  'default product list must use one full-width row track');
assert.match(css, /@media\(max-width:760px\)[\s\S]*?\.product-catalog-view-switch\{display:none\}[\s\S]*?\.product-list-row\{grid-template-columns:42px/,
  'mobile catalog must not expose the view switch and must keep rows compact');
assert.match(css, /\.product-detail-dialog \.ui-modal-footer\{justify-content:flex-end/,
  'product detail actions must share the aligned modal footer');
console.log('PRODUCT CATALOG PRESENTATION CONTRACT: PASS (filters, sorting, responsive views, detail dialog, compact actions)');
