import assert from 'node:assert/strict';
import fs from 'node:fs';

const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(portal, /portalUser\.role === 'owner' && !\['#staff', '#permissions'\]\.includes\(window\.location\.hash\)\) target\.querySelector\('#staff'\)\?\.remove\(\)/,
  'owner home omits staff while personnel routes keep their panel');
assert.match(portal, /window\.__refreshStaffList = canViewStaff && staffList \? loadStaffList : undefined/,
  'staff refresh is unavailable when owner dashboard has no staff panel');
assert.match(portal, /if \(canViewStaff && staffList\) loadStaffList\(\)/,
  'owner dashboard does not fetch the hidden staff directory');
assert.match(portal, /const routeOwnedStaff = \['#staff', '#permissions'\]\.includes\(focusedHash\) && node\.id === 'staff'/,
  'personnel route content remains visible regardless of saved dashboard preference');
assert.match(portal, /portalUser\.role === 'owner'\) settings\.querySelector\('\[data-dashboard-module-toggle="staff"\]'\)/,
  'owners cannot re-enable the staff directory as a dashboard module');
console.log('OWNER HOME STAFF CONTRACT: PASS (dashboard, personnel route, preferences and data loading)');
