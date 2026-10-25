import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const financeIncome = readFileSync(new URL('../finance-income.js', import.meta.url), 'utf8');
const incomeFallback = readFileSync(new URL('../migrations/211_finance_income_timezone_fallback.sql', import.meta.url), 'utf8');
assert.match(financeIncome, /venueTimezoneSql\('\$1'\)/, 'POS income writer validates venue then organization timezone through the shared SQL resolver');
assert.doesNotMatch(financeIncome, /AT TIME ZONE (?:v\.timezone|timezone\)|\(SELECT timezone FROM venues)/, 'POS income mapping and reporting never pass an unvalidated persisted timezone to PostgreSQL');
assert.match(incomeFallback, /pg_catalog\.pg_timezone_names[\s\S]*?v\.timezone[\s\S]*?pg_catalog\.pg_timezone_names[\s\S]*?org\.timezone[\s\S]*?'Asia\/Yekaterinburg'/, 'deferred immutable snapshot validation uses the same legacy-safe timezone fallback');
const helperStart = source.indexOf('const venueBusinessDateContext = async (pool, venueId) => {');
const helperEnd = source.indexOf('const recentBusinessDates', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'venue business date helper exists');
const helper = source.slice(helperStart, helperEnd);
assert.match(helper, /SELECT v\.timezone AS "venueTimezone", org\.timezone AS "organizationTimezone"[\s\S]*?WHERE v\.id=\$1/, 'business date context is scoped to the active venue and its organization');
assert.match(helper, /resolveIanaTimezone\(rows\[0\]\.venueTimezone, rows\[0\]\.organizationTimezone\)/, 'timezone resolution validates venue then organization values');
assert.match(helper, /SELECT \(now\(\) AT TIME ZONE \$1\)::date::text AS date/, 'business date is calculated in the resolved IANA timezone');
function route(startMarker, endMarker) {
  const start = source.indexOf(startMarker); const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route exists: ${startMarker}`);
  return source.slice(start, end);
}
const summary = route("if (pathname === '/api/finance/summary'", "if (pathname === '/api/finance/report'");
assert.match(summary, /venueBusinessDateContext\(repositories\.pool, venueDbId\)/, 'summary uses the active venue date context');
assert.match(summary, /if \(employeeFinanceView \|\| !requestedDate\) date = context\.date/, 'default/employee summary date cannot use the server process timezone');
assert.match(summary, /financeDateLedger\(client, venueDbId, date, timezone\)/, 'summary delegates its manager close-date interval to the shared ledger');
const ledgerStart = source.indexOf('const financeDateLedger = async'); const ledgerEnd = source.indexOf('async function accrueGuestOrderBonus', ledgerStart);
assert.ok(ledgerStart >= 0 && ledgerEnd > ledgerStart, 'shared finance ledger exists');
const ledger = source.slice(ledgerStart, ledgerEnd);
assert.match(ledger, /o\.closed_at>=b\.starts_at AND o\.closed_at<b\.ends_at/, 'shared sales ledger uses a venue-local half-open close-date interval');
const report = route("if (pathname === '/api/finance/report'", "if (pathname === '/api/deliveries'");
assert.match(report, /venueBusinessDateContext\(repositories\.pool, venueDbId\)/, 'reports use the active venue date context');
assert.match(report, /if \(employeeFinanceView \|\| !requestedDate\) date = context\.date/, 'default/employee report date cannot use the server process timezone');
assert.match(report, /closed_at >= \(\$[23]::date::timestamp AT TIME ZONE \$[34]\) AND o\.closed_at < \(\(\$[23]::date \+ 1\)::timestamp AT TIME ZONE \$[34]\)/, 'report filters a half-open interval in venue local time');
assert.match(report, /order_items oi[\s\S]*?AT TIME ZONE \$3/, 'X/Z item totals use the same venue-local calendar boundaries');
console.log('FINANCE TIMEZONE CONTRACT: PASS (venue-local date defaults and half-open report/summary intervals)');
