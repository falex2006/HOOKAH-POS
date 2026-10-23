'use strict';

// Read-only migration preflight. Conflict identity deliberately ignores rule_id:
// future scheme materialization must coexist with every active legacy entry.
const ACTIVE = "('draft','approved','paid')";
async function readPayrollEntryOverlapPreflight(db) {
  const invalid = (await db.query(`SELECT id::text,venue_id::text,user_id::text,status,
      period_from::text,period_to::text FROM payroll_entries
    WHERE status IN ${ACTIVE} AND (venue_id IS NULL OR user_id IS NULL OR period_from IS NULL
      OR period_to IS NULL OR NOT isfinite(period_from) OR NOT isfinite(period_to)
      OR period_to < period_from) ORDER BY id LIMIT 101`)).rows;
  const pairs = (await db.query(`SELECT a.venue_id::text,a.user_id::text,a.id::text AS left_id,b.id::text AS right_id,
      a.status AS left_status,b.status AS right_status,a.period_from::text AS left_from,a.period_to::text AS left_to,
      b.period_from::text AS right_from,b.period_to::text AS right_to
    FROM payroll_entries a JOIN payroll_entries b ON a.venue_id=b.venue_id AND a.user_id=b.user_id AND a.id<b.id
    WHERE a.status IN ${ACTIVE} AND b.status IN ${ACTIVE}
      AND a.period_from<=b.period_to AND b.period_from<=a.period_to
    ORDER BY a.venue_id,a.user_id,a.id,b.id LIMIT 1001`)).rows;
  return { schemaVersion: 1, status: invalid.length || pairs.length ? 'blocked' : 'clear',
    diagnosticOnly: true, constraintInstallationAuthorized: false,
    scope: 'all_active_employee_periods_including_legacy_and_different_rules',
    activeStatuses: ['draft', 'approved', 'paid'], inclusiveDates: true,
    invalidRows: invalid.slice(0, 100), invalidRowsTruncated: invalid.length > 100,
    conflicts: pairs.slice(0, 1000), conflictsTruncated: pairs.length > 1000,
    automaticallyResolved: false };
}

module.exports = { readPayrollEntryOverlapPreflight };
