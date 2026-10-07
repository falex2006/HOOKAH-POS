import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const portal = readFileSync(new URL('portal.js', root), 'utf8');
const styles = readFileSync(new URL('style.css', root), 'utf8');
const rules = readFileSync(new URL('VISUAL_PAGE_RULES.md', root), 'utf8');
const dashboardStart = portal.indexOf('function renderDashboard()');
const dashboard = portal.slice(dashboardStart, portal.indexOf('function renderInventory()', dashboardStart));

for (const label of ['Выручка сегодня', 'К оплате', 'Открытые заказы', 'Бронирования сегодня', 'Нужно пополнить']) {
  assert.ok(dashboard.includes(label), `dashboard KPI label missing: ${label}`);
}
assert.match(dashboard, /id="dash-pending-revenue"[\s\S]*?id="dash-pending-detail"/,
  'pending balance and explanation must remain distinct from received revenue');
assert.doesNotMatch(dashboard, /dashboard-revenue-spark/,
  'dashboard must not show a decorative trend without real time-series data');
assert.doesNotMatch(dashboard, /data-dashboard-revenue-style/,
  'headline KPIs must use one consistent design');
assert.doesNotMatch(dashboard, /insight-stat-grid|Брони сегодня|Ожидают оплаты/,
  'the lower dashboard section must not repeat headline metrics');
assert.ok(dashboard.includes('id="dashboard-shift-date"') && dashboard.includes('id="dashboard-shift-select"'),
  'shift performance must be selectable by date and shift');
assert.ok(dashboard.indexOf('id="dashboard-insights"') < dashboard.indexOf('class="kpi-grid dashboard-kpi-grid'),
  'selected shift KPIs must precede live operational cards');
assert.ok(dashboard.includes('Показатели смены') && dashboard.includes('Оплаты относятся к смене их проведения') && portal.includes('За выбранную дату смен не найдено'),
  'shift KPI panel must explain its context and empty state');
assert.ok(portal.includes('dashboard-shift-empty__action') && portal.includes('Выбрать дату'),
  'a no-shift day should present a complete empty state with a direct date-selection action');
assert.ok(portal.includes('dashboard-shift-kpis') && portal.includes('ambiguousPaymentCount'),
  'shift KPI rendering must expose values and warn about ambiguous attribution');
assert.ok(portal.includes('revision !== requestRevision'),
  'out-of-order requests must not overwrite the latest selected period');
assert.ok(portal.includes('Поступившие платежи ${periodLabel}') && portal.includes('dashboard-shift-retry'),
  'period names must reflect all-shifts selection and failed loads must be retryable');
assert.match(portal, /allOption\.textContent = data\.employeeView \? 'Сегодня' : data\.shifts\.length \? `Все смены · \$\{data\.shifts\.length\}` : 'Смен нет';\s*allOption\.selected = true;/,
  'the default shift scope must be visibly selected as all shifts when no specific shift is selected');
assert.match(portal, /shiftSelect\.disabled = data\.employeeView \|\| data\.shifts\.length < 2;\s*shiftSelect\._customSelectRefresh\?\.\(\);/,
  'the visible custom shift control must refresh after its option, selection, and disabled state update');
assert.match(portal, /const selectedShiftId = data\.selectedShiftId \? String\(data\.selectedShiftId\) : '';\s*const validSelectedId = selectedShiftId \? shiftSelect\.querySelector\([\s\S]*?\) : null;[\s\S]*?else shiftSelect\.value = '';/,
  'an empty selection must preserve the explicit empty-state option instead of assigning null or undefined');
assert.match(portal, /shiftSelect\.disabled = true;\s*shiftSelect\._customSelectRefresh\?\.\(\);\s*context\.textContent = 'Загружаем показатели…'/,
  'the visible shift control must stay synchronized while the selected date is loading');
assert.match(portal, /const selected = data\.employeeView \? null : data\.shifts\.find\(\(shift\) => shift\.id === shiftSelect\.value\);[\s\S]*?selected \? `\$\{venueDateTime\(selected\.openedAt\)\}[\s\S]*?: 'Итог по всем сменам выбранного дня'/,
  'shift context label and KPI period must use the selected shift or the explicit all-shifts option');
assert.ok(portal.includes('has-pending'), 'pending payments should only use alert color when a balance exists');
assert.match(styles, /\.dashboard-kpi-grid\{[^}]*container-type:inline-size/);
assert.match(styles, /\.portal-content\{container-type:inline-size;container-name:crm-content\}/,
  'page composition must respond to usable workspace width rather than viewport width');
assert.match(styles, /@container crm-content \(min-width:961px\)[\s\S]*?\.dashboard-kpi-grid\{grid-template-columns:minmax\(0,1\.18fr\) repeat\(3,minmax\(0,1fr\)\)\}/,
  'four headline KPIs must remain in one balanced row when the content area can support them');
assert.match(styles, /@container crm-content \(max-width:960px\)[\s\S]*?\.dashboard-kpi-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/,
  'headline KPI density must respond to available dashboard width');
assert.match(styles, /dashboard-revenue-card \.dashboard-revenue-main>strong\{[^}]*font-size:clamp\(34px,2\.8vw,42px\)/,
  'received revenue must remain the dominant value');
assert.match(styles, /\.dashboard-kpi-grid\{grid-template-columns:minmax\(0,1fr\);/,
  'mobile KPI layout must use one column');
const inlineSizeContainerRules = styles.slice(
  styles.indexOf('@supports (container-type:inline-size)'),
  styles.indexOf('@supports not (container-type:inline-size)')
);
const revenueCompactRule = inlineSizeContainerRules.lastIndexOf('@container crm-content (max-width:560px)');
const revenuePhoneOverride = inlineSizeContainerRules.lastIndexOf('@container crm-content (max-width:380px)');
assert.ok(revenueCompactRule >= 0 && revenuePhoneOverride > revenueCompactRule,
  'the narrow-content revenue-card rule must follow the wider compact rule in the cascade');
const narrowRevenueRules = inlineSizeContainerRules.slice(revenuePhoneOverride, inlineSizeContainerRules.indexOf('\n  }', revenuePhoneOverride));
assert.match(narrowRevenueRules, /\.dashboard-kpi-grid>\.dashboard-revenue-card\{grid-template-columns:minmax\(0,1fr\);/,
  'revenue card must stack when the usable page content is 380px or narrower, including narrow phone shells');
assert.match(narrowRevenueRules, /\.dashboard-kpi-grid \.dashboard-revenue-pending\{width:min\(100%,180px\);align-self:start/,
  'the pending-payment card must fit within the stacked revenue card on narrow content');
assert.match(styles, /\.dashboard-shift-controls input,\.dashboard-shift-controls select\{min-height:44px/,
  'date and shift controls must meet the shared touch target');
assert.match(styles, /\.dashboard-shift-empty\{grid-column:1\/-1;[^}]*min-height:132px/,
  'no-shift state must occupy and visually resolve the full KPI grid');
assert.match(styles, /\.dashboard-shift-empty__action\{min-height:44px/,
  'the empty-state date action must meet the shared touch target');
assert.match(styles, /\.dashboard-shift-kpis\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/,
  'shift KPI columns must adapt at narrower widths');
assert.match(styles, /\.dashboard-shift-retry\{[^}]*min-height:44px/,
  'retry action must retain the common touch target');
const sidebarTextColor = styles.match(/\.velora-theme \.side-label,\.velora-theme \.sidebar-nav-group summary,\.staff-theme \.portal-sidebar \.side-label\{color:(#[\da-f]{6})\}/i)?.[1];
assert.equal(sidebarTextColor?.toLowerCase(), '#9aa3ae', 'sidebar group labels must use the shared accessible muted text token');
const luminance = (hex) => { const rgb = hex.match(/[\da-f]{2}/gi).map((part) => parseInt(part, 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4); return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; };
const sidebarContrast = (luminance(sidebarTextColor) + 0.05) / (luminance('#17191d') + 0.05);
assert.ok(sidebarContrast >= 4.5, `sidebar group label contrast must meet WCAG AA for normal text, got ${sidebarContrast.toFixed(2)}:1`);
assert.match(rules, /Не использовать декоративные графики без реальных рядов данных/);
console.log('DASHBOARD KPI DESIGN CONTRACT: PASS (meaning, hierarchy, consistent styling, and responsive layout)');

const financeRevenueStart = portal.indexOf('class="kpi dashboard-revenue-card finance-revenue-card"');
assert.notEqual(financeRevenueStart, -1, 'finance revenue KPI exists');
const financeRevenueMarkup = portal.slice(financeRevenueStart, portal.indexOf('</article>', financeRevenueStart));
assert.doesNotMatch(financeRevenueMarkup, /dashboard-revenue-spark/, 'finance revenue has no synthetic trend bars without real time-series data');
