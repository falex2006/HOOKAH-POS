import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminHtml = fs.readFileSync('admin.html', 'utf8');
const portal = fs.readFileSync('portal.js', 'utf8');
const style = fs.readFileSync('style.css', 'utf8');
const titleMap = portal.match(/const adminSectionTitles = \{([^}]+)\}/)?.[1] || '';
const greeting = portal.match(/function updateDashboardGreeting\(\) \{([^}]+)\}/)?.[1] || '';
const staffBranchStart = portal.indexOf("} else if (dashboardFocus === 'staff' || dashboardFocus === 'permissions') {");
const staffBranchEnd = portal.indexOf("} else if (dashboardFocus === 'company') {", staffBranchStart);
const staffBranch = portal.slice(staffBranchStart, staffBranchEnd);

assert.match(adminHtml, /<b data-admin-section-title>Главная<\/b>/,
  'admin top bar exposes a dynamic subsection title');
assert.match(titleMap, /'#staff':\s*'Персонал'/,
  'staff subsection maps to the same label as its page heading');
assert.match(titleMap, /'#company':\s*'Настройки заведения'/,
  'company top-bar title matches the focused company page heading');
assert.match(titleMap, /'#venue-layout-settings':\s*'Залы и рабочая зона'/,
  'venue layout settings use the settings name from the sitemap instead of the operational hall/order label');
assert.match(portal, /window\.addEventListener\('hashchange', updateAdminSectionTitle\)/,
  'admin top bar title updates when the selected subsection changes');
assert.ok(/window\.location\.hash && window\.location\.hash !== '#'/.test(greeting) || /stable title; no recurring greeting/.test(greeting),
  'dashboard greeting must not overwrite a subsection heading or reappear as a recurring flash');
assert.match(staffBranch, /staffTitle\.textContent = dashboardFocus === 'permissions' \? 'Роли и права доступа' : 'Персонал'/,
  'staff and permissions subsection headings remain explicit');
assert.ok(staffBranch.includes(`setDashboardPanelVisibility('[data-dashboard-module="kpi"]`),
  'staff subsection hides both the KPI cards and their separate heading');
assert.match(portal, /dashboard-live-heading" data-dashboard-module="kpi"/,
  'the live KPI heading remains grouped with the dashboard KPI module');
const navigationStart = portal.indexOf('const getSettingsHashTarget =');
const navigationEnd = portal.indexOf('const settingsHash = [', navigationStart);
assert.ok(navigationStart >= 0 && navigationEnd > navigationStart, 'one shared dashboard settings target helper exists');
const navigation = portal.slice(navigationStart, navigationEnd);
assert.match(navigation, /const targets = \{/,
  'settings hash routes resolve to their actual visible panel instead of a generic page heading');
for (const hash of ['#shift-control', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit']) {
  assert.ok(navigation.includes(`'${hash}':`), `direct and in-app ${hash} child links resolve to their selected subsection`);
}
assert.match(portal, /target\._applySettingsView = applySettingsView/,
  'rerendering the dashboard exposes one settings route handler');
assert.ok(portal.includes("window.addEventListener('hashchange'") && portal.includes('applySettingsView'),
  'later hash changes use the same settings route helper');
assert.match(portal, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/,
  'initial and later settings routes scroll to the selected subsection');
assert.match(style, /\.velora-theme \.page-title\{scroll-margin-top:calc\(var\(--crm-header-height,68px\) \+ 12px\)\}/,
  'hash navigation keeps the complete eyebrow and heading clear of the fixed management header');
assert.match(style, /\.velora-theme #company-form,.velora-theme #settings-dashboard-modules/,
  'settings subsections also clear the fixed management header when scrolled into view');
const settingsHub = portal.match(/settingsHub\.innerHTML = `([^`]+)`/)?.[1] || '';
assert.ok(settingsHub, 'settings hub markup exists');
assert.doesNotMatch(settingsHub, /<h2>Настройки CRM<\/h2>/,
  'the settings overview does not repeat the page H1 inside its panel');

console.log('ADMIN SECTION HEADING CONTRACT: PASS (staff title stays aligned and dashboard KPI heading is hidden in subsections)');
