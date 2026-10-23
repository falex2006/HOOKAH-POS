import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

assert.match(portal, /stock: \['\.inventory-stock-panel', '\.inventory-item-editor-panel'\]/,
  'the item editor belongs only to the stock view and must hide when switching to other warehouse sections');
assert.match(portal, /\.inventory-stock-panel,\.inventory-item-editor-panel,\.inventory-auto-order-panel/,
  'warehouse view switching must include the item editor in visibility toggles');
assert.match(portal, /inventoryLoadState === 'loading' && \['stock', 'movements'\]\.includes\(view\) \? '—'/,
  'stock and movement KPI values must remain loading placeholders until inventory data arrives');
assert.match(portal, /inventoryLoadState = 'error'; refreshInventoryContext\(\)/,
  'inventory API errors must not leave false zero KPI values on screen');

for (const label of ['Позиция', 'Цех / категория', 'Остаток', 'Порог пополнения', 'Состояние', 'Действия']) {
  assert.ok(portal.includes(`data-label="${label}"`), `stock card label is missing: ${label}`);
}
for (const label of ['Позиция', 'Остаток', 'Порог пополнения', 'К заказу', 'Поставщик', 'Оценка']) {
  assert.ok(portal.includes(`data-label="${label}"`), `replenishment card label is missing: ${label}`);
}
assert.match(css, /@media\(max-width:1000px\)\{[\s\S]*?\.inventory-stock-panel tbody tr\{display:grid/,
  'stock view must switch to labeled cards on constrained tablet/Fold widths');
assert.match(css, /@media\(max-width:1100px\)\{[\s\S]*?\.auto-order-table-wrap tbody tr\{display:grid/,
  'replenishment view must switch to labeled cards on constrained tablet/Fold widths');
assert.match(css, /\.inventory-stock-panel table\{display:block;width:100%;min-width:0/,
  'mobile stock cards must not retain the desktop minimum width');
assert.match(css, /\.velora-theme \.inventory-content-grid\{grid-template-columns:minmax\(0,1fr\);gap:24px\}/,
  'warehouse retains a single full-width track when generic Fold rules create a two-column content grid');
assert.match(css, /\.inventory-stock-panel tbody td\{[^}]*width:100%!important[^}]*justify-self:stretch[^}]*box-sizing:border-box/,
  'stock table cells must stretch across their mobile grid and avoid character-by-character wrapping');
assert.match(css, /inventory-stock-panel th:nth-child\(4\)\{width:18%\}\.velora-theme \.inventory-stock-panel th:nth-child\(5\)\{width:17%\}\.velora-theme \.inventory-stock-panel th:nth-child\(6\)\{width:17%\}/,
  'desktop stock table must reserve enough width for replenishment, state and actions');
assert.match(css, /\.velora-theme \.inventory-stock-panel th\{[^}]*line-height:1\.35;vertical-align:bottom;white-space:normal\}/,
  'desktop stock table headers must wrap cleanly instead of merging across narrow columns');
assert.match(css, /@media\(max-width:760px\)\{[\s\S]*?\.velora-theme \.product-catalog-view-switch\{display:none\}[\s\S]*?\.velora-theme #visual-catalog \.product-list-row\{grid-template-columns:42px/,
  'product catalog must use one compact list representation with no view switch on phone/Fold widths');
assert.match(css, /\.auto-order-table-wrap table\{display:block;width:100%;min-width:0/,
  'mobile replenishment cards must not retain the desktop minimum width');
assert.match(css, /\.auto-order-table-wrap tbody td:not\(\.auto-order-check-col\)\{[^}]*width:100%!important[^}]*justify-self:stretch[^}]*box-sizing:border-box/,
  'replenishment cells must stretch across their mobile grid and avoid character-by-character wrapping');
assert.match(css, /@media\(max-width:560px\)\{[\s\S]*?grid-template-columns:minmax\(0,1fr\)/,
  'phone-width warehouse cards must collapse to one column');
assert.doesNotMatch(portal, /class="inventory-tabs"/, 'warehouse views must not duplicate the sidebar navigation inside the page');
assert.match(css, /@media\(min-width:651px\) and \(max-width:1000px\)\{\.velora-theme \.kpi-grid\.compact\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
  'Fold/tablet KPI tiles must remain in a single balanced row');
assert.match(css, /@media\(min-width:651px\) and \(max-width:760px\)\{\.velora-theme \.kpi-grid\.compact\.inventory-context-kpis\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/,
  'Fold inner-width inventory KPIs must use two equal columns before the activity card spans the row');
assert.match(portal, /target\.classList\.toggle\('inventory-listing-mode', \['products', 'recipes'\]\.includes\(view\)\)/,
  'product and recipe pages must opt into their own compact listing header without changing other inventory views');
assert.match(css, /@media\(max-width:430px\)\{\.velora-theme \.inventory-listing-mode \.inventory-context-kpis>\.kpi\{grid-template-columns:minmax\(0,1fr\);padding:8px 9px\}\.velora-theme \.inventory-listing-mode \.inventory-context-kpis>\.kpi>span\{font-size:10px\}\.velora-theme \.inventory-listing-mode \.inventory-context-kpis>\.kpi>small\{display:none\}/,
  'phone-width product/recipe KPIs must avoid narrow inline label/value wrapping and secondary copy must collapse');
assert.match(css, /@container crm-content \(min-width:961px\)[\s\S]*?inventory-page-title>\.toolbar-row\{display:flex;width:auto/,
  'warehouse title actions must stay on one line when the usable content area can support them');
assert.match(css, /@container crm-content \(max-width:960px\)[\s\S]*?inventory-page-title>\.toolbar-row\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
  'warehouse actions must wrap based on the actual available content area');
assert.match(css, /\.sidebar-nav-group:not\(\[open\]\)>summary\.has-active-child\{color:#f3f5f7;background:#1d2027;border-radius:10px/,
  'a collapsed inventory group must still indicate that one of its child routes is active');
assert.match(css, /\.inventory-stock-panel \.inventory-item-edit\{min-height:44px/,
  'stock card actions must meet the touch target on constrained screens');
assert.match(css, /\.inventory-departments button\{min-height:44px/,
  'department filters must meet the touch target on constrained screens');
assert.match(css, /td\.auto-order-check-col\{display:flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;width:auto;min-width:92px;min-height:44px/,
  'auto-order selection must be a clear touch-sized control on constrained screens');
assert.match(css, /td\.auto-order-check-col::after\{content:'В заявку'/,
  'auto-order checkbox must explain its action on constrained screens');
assert.match(css, /@media\(max-width:560px\)\{[\s\S]*?auto-order-table-wrap tbody td\.auto-order-item-cell\{min-width:0;padding-right:112px\}/,
  'phone-width auto-order titles must reserve enough inline space for the positioned selection control');
for (const requirement of ['Приёмка по документу', 'Поставщик', 'Номер документа', 'Дата накладной', 'Добавить позицию', 'Сохранить черновик', 'Провести поступление', 'purchase-documents']) {
  assert.ok(portal.includes(requirement), `documented receiving workflow is missing: ${requirement}`);
}
assert.match(portal, /Черновик сохранён\. Остаток изменится после проведения\./,
  'saving a draft must clearly state that stock has not moved yet');
assert.match(portal, /allItems = data\.items \|\| \[\]; renderPurchaseLines\(/,
  'purchase item options must refresh after inventory finishes loading asynchronously');
assert.match(portal, /В учёт поступит|В учёт поступит /,
  'each purchase line must show its normalized stock quantity');
assert.match(portal, /purchasePanel\.querySelectorAll\('label:has\(:required\)'\)/,
  'required receiving fields must be visibly identified from their actual validation state');
assert.match(portal, /insertBefore\(purchasePanel, inventoryContentGrid\)/,
  'document receiving must appear before adjustment operations in the warehouse workflow');
assert.match(css, /\.purchase-document-form \.required-mark\{color:#ff7180;font-weight:800\}/,
  'required receiving markers must use the shared required-field treatment');
assert.match(css, /\.purchase-line\{display:grid;grid-template-columns:/,
  'purchase lines must have a structured desktop layout');
assert.match(css, /@media\(max-width:650px\)[\s\S]*?\.purchase-line\{grid-template-columns:minmax\(0,1fr\)/,
  'purchase lines must collapse into a single-column phone layout');
assert.match(css, /button\.button:not\(\.primary\):not\(\.danger\):not\(\.danger-outline\)\{background:#20242a;border:1px solid/,
  'neutral buttons must keep a visible premium control surface');
assert.match(css, /@media\(max-width:980px\)\{\.velora-theme \.purchase-lines-head>\.button,\.velora-theme \.purchase-document-row>\.toolbar-row>\.button\{min-height:44px\}\}/,
  'receiving actions must meet the touch target on Fold/tablet widths');
assert.match(css, /@media\(max-width:360px\)\{\.inventory-movements-mode \.purchase-document-filters\{grid-template-columns:minmax\(0,1fr\)\}\}/,
  'narrow movement filters must stack so labels and selects do not collide in two compressed columns');

console.log('INVENTORY RESPONSIVE CONTRACT: PASS');
