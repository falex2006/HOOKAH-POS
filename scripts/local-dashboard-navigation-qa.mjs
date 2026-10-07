import assert from 'node:assert/strict';
import fs from 'node:fs';

// The dashboard hash lifecycle is intentionally owned by the current shared
// handler in portal.js; the former standalone helper was removed when routing
// and sidebar disclosure were unified.
const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(source, /const dashboardHashChangeHandler = \(\) => \{/);
assert.match(source, /normalizeManagementSidebar\(\);/);
assert.match(source, /if \(window\.location\.hash === '#tasks'\) renderTasks\(\);/);
assert.match(source, /else if \(window\.location\.hash === '#loyalty'\) renderLoyalty\(\);/);
assert.match(source, /scrollTarget\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
assert.match(source, /window\.addEventListener\('hashchange', dashboardHashChangeHandler\)/);
assert.doesNotMatch(source, /classList\.add\('crm-route-enter'\)/);
console.log('PASS local dashboard navigation: shared hash lifecycle, sidebar sync, sections, settings scroll, no route animation');
