import assert from 'node:assert/strict';
import fs from 'node:fs';

const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const applyModules = portal.match(/const apply = \(\) => \{[\s\S]*?document\.querySelectorAll\('\[data-dashboard-module\]'\)\.forEach\(\(node\) => \{[\s\S]*?\n    \}\);[\s\S]*?\n  \};/)?.[0];
assert.ok(applyModules, 'dashboard module visibility handler must exist');
assert.match(applyModules, /window\.location\.hash === '#shift-control'.*node\.id === 'shift-control'/, 'direct shift deep link must keep its target visible after preferences apply');

const navigationStart = portal.indexOf('const getSettingsHashTarget =');
const navigationEnd = portal.indexOf('const settingsHash = [', navigationStart);
assert.ok(navigationStart >= 0 && navigationEnd > navigationStart, 'dashboard hash target mapper must exist');
const navigation = portal.slice(navigationStart, navigationEnd);
assert.match(navigation, /'#shift-control': '#shift-control'/, 'shift deep link must resolve to its panel');

const focusBranch = portal.match(/\} else if \(dashboardFocus === 'shift-control'\) \{[\s\S]*?\n  \} else if \(dashboardFocus === 'company'\)/)?.[0];
assert.ok(focusBranch, 'shift deep link focus branch must exist');
assert.match(focusBranch, /setDashboardPanelVisibility\('#shift-control', true\)/, 'shift panel must be explicitly shown');
assert.match(focusBranch, /Контроль смены/, 'focused title must identify shift control');

assert.ok(portal.includes("window.addEventListener('hashchange'") && portal.includes('getSettingsHashTarget'), 'hash changes must use the focused subsection navigator');
assert.match(portal, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/, 'hash changes must scroll to the mapped shift panel');

console.log('DASHBOARD SHIFT DEEP LINK CONTRACT: PASS (visibility, title and initial/hash-change focus)');
