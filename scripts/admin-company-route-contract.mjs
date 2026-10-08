import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const siteTree = fs.readFileSync(new URL('../SITE_TREE.md', import.meta.url), 'utf8');

const routingStart = portal.indexOf('const getSettingsHashTarget =');
const routingEnd = portal.indexOf("if (target._dashboardHashChangeHandler)", routingStart);
assert.ok(routingStart >= 0 && routingEnd > routingStart, 'dashboard focus routing block must exist');
const routing = portal.slice(routingStart, routingEnd);

assert.match(routing, /const isCompanyPage = \(\) => focusedAdminDashboardHash\(\) === '#company'/,
  'company route uses the shared focused-route predicate');
assert.match(routing, /classList\.toggle\('company-page-active', active\)/,
  'company state is exposed on the page container and body for scoped perimeter styling');
assert.match(routing, /heading: 'Настройки заведения'/,
  'company subsection gets its own matching page heading');
assert.match(routing, /setDashboardPanelVisibility\('\.purchase-reversal-settings', focusedView === '#company'\)/,
  'reversal policy is shown on company and hidden on interface/layout subsections');
assert.match(routing, /setDashboardPanelVisibility\('#company > \.panel-head', focusedView === '#company'\)/,
  'company card heading is hidden while a nested sibling settings panel owns the view');
assert.match(routing, /setDashboardPanelVisibility\('\[data-dashboard-module="kpi"\], #dashboard-insights, #shift-control, \[data-dashboard-module="quick"\], #staff', false\)/,
  'focused settings route hides dashboard siblings');
assert.match(routing, /setDashboardPanelVisibility\('#company-form', \['owner', 'admin'\]\.includes\(portalUser\.role\)\)/,
  'focused route preserves the existing company-form role boundary');
assert.match(routing, /const dashboardHashChangeHandler = \(\) => \{[\s\S]*?syncCompanyPageClass\(\);/,
  'same-document hash navigation updates the scoped company page class');
assert.doesNotMatch(routing, /MutationObserver/,
  'route state is determined by the shared focus predicate, not a visibility observer workaround');
assert.match(siteTree, /`\/admin#company`[\s\S]*company-page-active/,
  'site tree documents focused company route visibility and scoped styling state');

// Execute the actual focus predicate and setupDashboardModules helper with a
// deferred preferences response so this covers the late async re-apply path.
const helperStart = portal.indexOf('const focusedAdminDashboardHashes =');
const helperEnd = portal.indexOf('const interfaceModulePermissions', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'shared predicate and preference helper exist');
const helperSource = portal.slice(helperStart, helperEnd);

const runLatePreferenceCase = async (hash, visibleModules = []) => {
  const moduleNames = ['kpi', 'insights', 'shift', 'quick', 'staff'];
  const modules = moduleNames.map((name) => ({ id: name === 'staff' ? 'staff' : name === 'shift' ? 'shift-control' : `dashboard-${name}`, dataset: { dashboardModule: name }, hidden: false }));
  const settings = { querySelector: () => null, querySelectorAll: () => [] };
  let resolvePreferences;
  const preferenceResponse = new Promise((resolve) => { resolvePreferences = resolve; });
  const context = {
    window: { location: { pathname: '/admin', hash } },
    document: {
      querySelector: (selector) => selector === '#settings-dashboard-modules' ? settings : null,
      querySelectorAll: (selector) => selector === '[data-dashboard-module]' ? modules : [],
    },
    portalUser: { id: 'company-route-test', role: 'admin' },
    hasPortalPermission: () => true,
    preferenceSessionIdentity: () => 'company-route-test',
    samePreferenceSession: () => true,
    localStorage: { getItem: () => null, setItem: () => {} },
    api: () => preferenceResponse,
  };
  vm.runInNewContext(`${helperSource}\nsetupDashboardModules();`, context);
  assert.ok(modules.every((node) => node.hidden === !visibleModules.includes(node.dataset.dashboardModule)), `initial focused modules match ${hash}`);
  resolvePreferences({ preferences: { dashboardModules: { kpi: true, insights: true, shift: true, quick: true, staff: true } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(modules.every((node) => node.hidden === !visibleModules.includes(node.dataset.dashboardModule)), `late preference restore must preserve focused visibility on ${hash}`);
};

for (const hash of ['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit']) await runLatePreferenceCase(hash);
await runLatePreferenceCase('#shift-control', ['shift']);
await runLatePreferenceCase('#staff', ['staff']);

console.log('ADMIN COMPANY ROUTE CONTRACT: PASS (shared focus predicate, late preference restore, title, visibility, reversal, scoped class)');
