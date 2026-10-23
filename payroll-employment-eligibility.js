'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIODS = 10000;

const isDate = value => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

const normalizeEligibilityPeriods = input => {
  if (!Array.isArray(input) || input.length > MAX_PERIODS) throw new TypeError('invalid_payroll_employment_periods');
  const rows = input.map(period => {
    if (!period || typeof period !== 'object' || Array.isArray(period)
        || !UUID.test(String(period.employeeId || '')) || !isDate(period.effectiveFrom)
        || (period.effectiveTo !== undefined && period.effectiveTo !== null && !isDate(period.effectiveTo))
        || (period.effectiveTo && period.effectiveTo < period.effectiveFrom)
        || Object.keys(period).some(key => !['employeeId', 'effectiveFrom', 'effectiveTo'].includes(key))) {
      throw new TypeError('invalid_payroll_employment_period');
    }
    return { employeeId: String(period.employeeId).toLowerCase(), effectiveFrom: period.effectiveFrom, effectiveTo: period.effectiveTo || null };
  }).sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.effectiveFrom.localeCompare(b.effectiveFrom));

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous.employeeId === current.employeeId
        && (!previous.effectiveTo || previous.effectiveTo >= current.effectiveFrom)) {
      throw new TypeError('payroll_employment_periods_overlap');
    }
  }
  return rows;
};

const eligibilityPayloadSha256 = (periods, reason = '', expectedRevisionId = null) => createHash('sha256')
  .update(canonicalJson({ reason: String(reason), expectedRevisionId: expectedRevisionId || null,
    periods: normalizeEligibilityPeriods(periods) })).digest('hex');

const eligibilitySourceWatermark = (venueId, revision, periods) => createHash('sha256').update(canonicalJson({
  venueId,
  id: revision.id,
  revision_no: revision.revision_no ?? revision.revisionNo,
  supersedes_revision_id: revision.supersedes_revision_id ?? revision.supersedesRevisionId ?? null,
  reason: revision.reason,
  idempotency_key: revision.idempotency_key ?? revision.idempotencyKey,
  payload_sha256: revision.payload_sha256 ?? revision.payloadSha256,
  period_count: revision.period_count ?? revision.periodCount,
  created_by: revision.created_by ?? revision.createdBy,
  created_by_name: revision.created_by_name ?? revision.createdByName,
  created_at: revision.created_at ?? revision.createdAt,
  periods
})).digest('hex');

const loadLatestEligibilitySourceInTransaction = async (db, venueId) => {
  const schema = (await db.query(`SELECT to_regclass('payroll_employment_eligibility_revisions') IS NOT NULL AS revisions,
    to_regclass('payroll_employment_eligibility_periods') IS NOT NULL AS periods`)).rows[0];
  if (!schema?.revisions || !schema?.periods) return {
    component: { status: 'unsupported', reasons: ['payroll_employment_eligibility_schema_missing'], sourceWatermark: null,
      watermarkScope: 'owner_attested_payroll_employment_eligibility_revision' },
    revision: null, periods: []
  };
  const revision = (await db.query(`SELECT id::text,revision_no,supersedes_revision_id::text AS supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,
      created_by::text AS created_by,created_by_name,created_at::text AS created_at
    FROM payroll_employment_eligibility_revisions WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 1`, [venueId])).rows[0];
  if (!revision) return {
    component: { status: 'incomplete', reasons: ['payroll_employment_eligibility_revision_required'], sourceWatermark: null,
      watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: null, revisionNo: null, periodCount: null },
    revision: null, periods: []
  };
  const rows = (await db.query(`SELECT employee_id::text AS "employeeId",employee_name_snapshot AS "employeeName",
      effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"
    FROM payroll_employment_eligibility_periods WHERE venue_id=$1 AND revision_id=$2
    ORDER BY employee_id,effective_from,id`, [venueId, revision.id])).rows.map(row => ({
      ...row, effectiveTo: row.effectiveTo || null
    }));
  const normalized = normalizeEligibilityPeriods(rows.map(({ employeeId, effectiveFrom, effectiveTo }) => ({ employeeId, effectiveFrom, effectiveTo })));
  const inputHash = eligibilityPayloadSha256(normalized, revision.reason, revision.supersedes_revision_id);
  if (inputHash !== revision.payload_sha256 || rows.length !== Number(revision.period_count)) {
    return {
      component: { status: 'incomplete', reasons: ['payroll_employment_eligibility_revision_integrity_mismatch'], sourceWatermark: null,
        watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: revision.id,
        revisionNo: Number(revision.revision_no), periodCount: rows.length },
      revision, periods: []
    };
  }
  const sourceWatermark = eligibilitySourceWatermark(venueId, revision, rows);
  return {
    component: { status: 'available', reasons: [], sourceWatermark,
      watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: revision.id,
      revisionNo: Number(revision.revision_no), periodCount: rows.length },
    revision: { ...revision, revisionNo: Number(revision.revision_no), periodCount: Number(revision.period_count), sourceWatermark },
    periods: rows
  };
};

const periodIntersects = (row, from, through) => row.effectiveFrom <= through && (!row.effectiveTo || row.effectiveTo >= from);

const buildEligibleEmployees = (periods, from, through) => {
  if (!isDate(from) || !isDate(through) || through < from) throw new TypeError('invalid_payroll_employment_period');
  const employees = new Map();
  for (const period of normalizeEligibilityPeriods(periods)) {
    if (!periodIntersects(period, from, through)) continue;
    const effectiveFrom = period.effectiveFrom > from ? period.effectiveFrom : from;
    const effectiveTo = period.effectiveTo && period.effectiveTo < through ? period.effectiveTo : through;
    const employee = employees.get(period.employeeId) || { id: period.employeeId, activeIntervals: [] };
    employee.activeIntervals.push({ from: effectiveFrom, to: effectiveTo });
    employees.set(period.employeeId, employee);
  }
  return [...employees.values()].sort((a, b) => a.id.localeCompare(b.id));
};

module.exports = { MAX_PERIODS, isDate, normalizeEligibilityPeriods, eligibilityPayloadSha256,
  eligibilitySourceWatermark, loadLatestEligibilitySourceInTransaction, buildEligibleEmployees };
