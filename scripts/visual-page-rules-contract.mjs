import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const rules = fs.readFileSync(new URL('VISUAL_PAGE_RULES.md', root), 'utf8');
const css = fs.readFileSync(new URL('style.css', root), 'utf8');
const portal = fs.readFileSync(new URL('portal.js', root), 'utf8');
const warehousePrompt = fs.readFileSync(new URL('WAREHOUSE_PAGE_PROMPT.md', root), 'utf8');
const tree = fs.readFileSync(new URL('SITE_TREE.md', root), 'utf8');
const map = JSON.parse(fs.readFileSync(new URL('site-map.json', root), 'utf8'));
const requiredGlobal = [
  'DESIGN_TOKENS.md', 'prefers-reduced-motion', 'скроллбар', 'safe-area',
  '44px', 'Канонические адреса', 'Не добавлять новые цвета', 'Склад', 'Финансы', 'View Transition'
];
for (const text of requiredGlobal) assert.ok(rules.includes(text), `visual rules missing global rule: ${text}`);
for (const text of ['Остатки', 'Поставки и списания', 'Технологические карты', 'Каталог товаров', 'Понятны ли названия всех кнопок']) {
  assert.ok(warehousePrompt.includes(text), `warehouse prompt missing rule: ${text}`);
}
assert.match(rules, /WAREHOUSE_PAGE_PROMPT\.md/);
assert.match(rules, /Фильтры периода, поиска, статуса и сортировки имеют видимые подписи/,
  'guest filters must retain the labeled responsive layout rule');
assert.match(css, /@view-transition\s*\{\s*navigation:\s*none;\s*\}/,
  'same-origin navigation must avoid flicker while preserving local transitions');
assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.staff-theme nav button\{transition:none!important;transform:none!important\}/,
  'staff navigation must not shift on hover when reduced motion is requested');
for (const name of ['root', 'crm-sidebar', 'crm-header']) {
  assert.ok(css.includes(`::view-transition-group(${name})`), `missing shared ${name} transition timing`);
}
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?::view-transition-group\(root\)[\s\S]*?animation:\s*none!important/,
  'cross-document transitions must respect reduced-motion preferences');
assert.doesNotMatch(portal, /requestAnimationFrame\(\(\)\s*=>\s*document\.querySelector\('#page-content'\)\?\.classList\.add\('crm-route-enter'\)\)/,
  'do not animate the empty initial content container on every full-page navigation');
assert.match(portal, /const dashboardHashChangeHandler = \(\) => \{/,
  'in-page/hash section changes use their shared lightweight route lifecycle');
assert.match(portal, /const dashboardHashChangeHandler = \(\) => \{[\s\S]*?normalizeManagementSidebar\(\{ routeChange: true \}\);[\s\S]*?scrollIntoView\(\{ behavior: 'smooth'/,
  'section changes update the title, content and final scroll through the same lifecycle');
assert.doesNotMatch(portal, /classList\.add\('crm-route-enter'\)/,
  'do not animate dashboard geometry while its shared route helper aligns the section');
assert.match(rules, /значок стоит у заголовка группы; вложенные ссылки остаются текстовыми/,
  'visual rules must keep expanded sidebar groups calm and readable');
assert.deepEqual(map.staffHeaderPresentation.actions, ['shift', 'auto-lock-settings', 'screen-lock', 'profile']);
assert.equal(map.staffHeaderPresentation.notifications, 'server-authorized-management-only');
assert.deepEqual(map.sidebarBrandPresentation, {maxWidth:190,maxHeight:61,fit:'contain',compactMaxViewportWidth:900,compactWidth:42,compactHeight:40,compactDrawerAsset:'symbol'});
assert.match(rules, /Логотип боковой панели целиком помещается во внутреннюю ширину/);
assert.match(tree, /Размер исходного файла не увеличивает боковую панель/);
assert.match(rules, /Смена закрыта · Открыть.*Смена открыта · Закрыть/);
assert.match(tree, /смена → настройки автоблокировки → блокировка → профиль/);
assert.deepEqual(map.navigationPresentation, {
  expandableGroupIcon: 'summary-only', childLinks: 'text-only', childTextAlignment: 'group-label'
}, 'the site map must document the canonical sidebar visual hierarchy');
assert.match(tree, /каждый раскрываемый раздел имеет свой значок в заголовке, а вложенные маршруты показываются текстом/,
  'the site tree must record the shared sidebar presentation rule');
assert.match(rules, /В `venue-layout-settings` сначала создаётся зал\/этаж, после чего открывается форма первого стола; пока залов нет, добавление стола и VIP-комнаты недоступно/,
  'the venue layout rule must preserve the hall-first table workflow');
assert.match(tree, /В `admin#venue-layout-settings` зал\/этаж создаётся первым; сохранение сразу предлагает добавить в него стол/,
  'the site tree must document the hall-to-table handoff');
assert.match(rules, /Выбор места сгруппирован по залам; у стола видны вместимость и депозит, закрытые места отключены/,
  'reservation design rules must keep hall context and capacity visible while selecting a table');
assert.match(rules, /Поле количества гостей ограничивается вместимостью выбранного места, а API повторно проверяет этот предел/,
  'reservation visual contract must keep the guest count consistent with the selected place');
assert.match(tree, /В форме бронирования столы сгруппированы по залам; рядом указаны вместимость и депозит/,
  'the site tree must document the hall-aware reservation selector');
assert.match(tree, /Число гостей ограничено вместимостью, а журнал и поиск сохраняют контекст зала/,
  'the site tree must preserve hall context after a reservation is created');
for (const entry of map.entries) {
  assert.ok(rules.includes('### `' + entry.path + '`'), `missing page rule ${entry.path}`);
  assert.ok(tree.includes('| `' + entry.path + '` |'), `page absent from site tree ${entry.path}`);
}
for (const subroute of map.adminSubroutes) assert.ok(rules.includes('`' + subroute + '`'), `missing admin rule ${subroute}`);
assert.match(rules, /`\/admin#permissions` сохраняет общую боковую панель, верхнюю шапку и заголовок админки[\s\S]*?количеством назначенных сотрудников[\s\S]*?личные профили и имена сотрудников не дублируются[\s\S]*?архивирование недоступно, пока роль назначена/,
  'permissions page must keep the shell and present roles without employee profile cards');
assert.match(portal, /custom-role-title[\s\S]*?custom-role-description[\s\S]*?custom-role-assignees/,
  'permissions roles must show descriptions, assigned counts and scope labels');
assert.match(portal, /staff-permissions-mode/,
  'permissions styling must be scoped inside the staff panel');
assert.match(css, /#staff\.staff-permissions-mode/,
  'permissions styling must not restyle the shared admin shell');
assert.match(portal, /data-custom-role-archive="\$\{r\.id\}" \$\{count\?'disabled/,
  'assigned roles must not be archivable');
const headings = [...rules.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]);
assert.equal(new Set(headings).size, headings.length, 'duplicate page rule heading');
assert.equal(headings.length, map.entries.length, 'page rule count differs from canonical map');
console.log(`VISUAL PAGE RULES CONTRACT: PASS (${headings.length} canonical pages, ${map.adminSubroutes.length} admin subsections)`);

assert.equal(map.inventoryDirectoryPresentation.layout, "cascade");
assert.equal(map.inventoryDirectoryPresentation.editor, "modal");
assert.match(rules, /Справочники склада: каскадный выбор/);

assert.equal(map.inventoryMovementsPresentation.default, "documents");
assert.equal(map.inventoryMovementsPresentation.editor, "modal");
assert.match(rules, /Поставки и списания: журнал прежде формы/);

assert.equal(map.inventoryWorkingViewsPresentation.summary, "compact");
assert.equal(map.inventoryWorkingViewsPresentation.lists, "bounded");
