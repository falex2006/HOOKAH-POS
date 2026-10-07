import assert from 'node:assert/strict';
import fs from 'node:fs';
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
assert.match(portal, /const normalizeManagementSidebar = \(\) => \{/);
assert.match(portal, /disclosureRoot\.replaceChildren\(\.\.\.\['operations', 'menu', 'inventory', 'finance', 'team', 'system'\]/);
assert.match(portal, /const rememberGroupState = \(details, key\) => \{/);
// Navigation now restores a single preferred group. Restoring every saved group
// was deliberately removed because it reopened multiple sections after reload.
assert.match(portal, /const preferredGroup = currentPath === '\/admin' && !currentHash \? null/);
assert.match(portal, /normalizedGroups\.forEach\(\(group\) => \{ group\.open = group === preferredGroup; \}\)/);
assert.match(portal, /homeLink\.addEventListener\('click', \(\) => \{\s*normalizedGroups\.forEach\(\(group\) => \{\s*group\.open = false;/);
assert.doesNotMatch(portal, /activeGroup\.open = true/);
assert.match(portal, /href: '\/admin#permissions'/);
assert.match(portal, /href: '\/admin#diagnostics'/);
assert.match(css, /sidebar-mobile-toggle\{[^}]*width:44px;height:44px/);
console.log('SIDEBAR NAVIGATION CONTRACT: PASS (canonical routes, one restored group, home collapses all)');
