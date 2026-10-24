import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const migration = readFileSync(new URL('migrations/039_shift_kpi_attribution.sql', root), 'utf8');
const server = readFileSync(new URL('server.js', root), 'utf8');
assert.match(migration, /payments[\s\S]*ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts\(id\)/);
assert.match(migration, /orders[\s\S]*ADD COLUMN IF NOT EXISTS closed_in_shift_id uuid REFERENCES shifts\(id\)/);
assert.match(server, /INSERT INTO payments \([^)]*\bshift_id\b[^)]*\) VALUES/,
  'new payment records must be attributed to the active shift');
assert.match(server, /closed_in_shift_id=\$\d/,
  'order closure must remember the shift that completed the check');
assert.match(server, /p\.shift_id=s\.id/,
  'shift totals and cash reconciliation must use explicit payment attribution');
assert.match(server, /o\.closed_in_shift_id=s\.id/,
  'closed order count must use explicit closure attribution');
assert.match(server, /const requestedShiftId = employeeView \? ''/,
  'employees cannot select another day or shift through the API');
const dashboardRoute = server.slice(server.indexOf("if (pathname === '/api/dashboard/shift-kpis'"), server.indexOf("if (pathname === '/api/finance/summary'"));
assert.match(dashboardRoute, /if \(employeeView\) \{[\s\S]*?o\.venue_id=\$1 AND o\.opened_by=\$2[\s\S]*?p\.created_at >= \(\$3::date::timestamp AT TIME ZONE \$4\)/,
  'employee payment totals must use the actor, venue and venue-local event date');
assert.match(dashboardRoute, /o\.closed_at >= \(\$3::date::timestamp AT TIME ZONE \$4\)[\s\S]*?shifts: \[\{ id: 'employee-today' \}\]/,
  'employee closed orders use local closure date and response hides shift identity');
assert.doesNotMatch(dashboardRoute.slice(0, dashboardRoute.indexOf('const unmatchedResult')), /p\.created_at>=s\.opened_at/,
  'dashboard totals must not guess payment shift from timestamp intervals');
assert.match(dashboardRoute, /unmatchedResult[\s\S]*p\.shift_id IS NULL[\s\S]*p\.created_at>=s\.opened_at/,
  'legacy payments in an overnight shift interval must be flagged without being assigned');
assert.match(migration, /Existing records remain NULL/,
  'migration must preserve unknown historical attribution instead of fabricating it');
assert.match(migration, /payment_shift_venue_guard/,
  'database must reject payment-to-shift links across venues');
assert.match(migration, /order_closed_shift_venue_guard/,
  'database must reject closure-to-shift links across venues');
console.log('DASHBOARD SHIFT ATTRIBUTION CONTRACT: PASS (explicit attribution, legacy history preserved)');
