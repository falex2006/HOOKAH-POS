'use strict';

// Persistence API for payroll-owned version configuration. Route callers must
// build the principal from authenticated server session state. Scenario preview
// uses caller-supplied data; the separate venue-turnover preview reads a
// source-backed venue total. Preview paths never persist calculations. The
// createVerifiedRun collects and saves its own source-fenced snapshot.
const { createHash, randomUUID } = require('node:crypto');
const { buildPayrollPersonalRevenueSource } = require('./payroll-personal-revenue-source');
const { collectPayrollRefundAwareCalculationInTransaction, readPayrollRefundAwareSourceArgsInTransaction,
  collectPayrollRefundAwareComparisonInTransaction } = require('./payroll-refund-aware-source');
const { buildPayrollRefundAwareRunProvenance, rebuildPayrollRefundAwareRunProvenance,
  ENGINE_VERSION: REFUND_RUN_ENGINE } = require('./payroll-refund-aware-provenance');
const { calculatePayrollScheme, validateScheme, validatePersonalThresholdAssignments, validatePersonalScalarAssignments } = require('./payroll-schemes');
const { makePayrollVenueTurnoverSource } = require('./payroll-venue-turnover-source');
const { makePayrollAttendanceManifestService } = require('./payroll-attendance-manifest');
const { normalizePayrollSourcePolicies, requiredPayrollSourceFacts } = require('./payroll-source-policies');
const { collectPersonalCapIncreases } = require('./payroll-personal-cap-policy');
const { parsePayrollReadinessPeriod, readPayrollSourceReadinessInTransaction, readPayrollSourceReadinessEvidenceInTransaction } = require('./payroll-source-readiness');
const { buildPayrollSourcedPreview } = require('./payroll-sourced-preview');
const { buildPayrollCandidateCalculation } = require('./payroll-candidate-calculation');
const { buildPayrollCandidateSnapshotBundle } = require('./payroll-candidate-snapshot-bundle');
const { buildPayrollSourcedComparison } = require('./payroll-sourced-comparison');
const { buildPayrollVerifiedSnapshotInput } = require('./payroll-verified-snapshot-input');
const { buildPayrollRunProvenance, ENGINE_VERSION: VERIFIED_RUN_ENGINE } = require('./payroll-run-provenance');
const { persistPayrollSnapshotBundleInTransaction } = require('./payroll-snapshot-persistence');
const savedRunReader = require('./payroll-saved-run-reader');
const { checkPayrollRunSourceFreshnessInTransaction } = require('./payroll-run-source-freshness');
const { collectPayrollRefundReviewAssessment } = require('./payroll-refund-review-assessment');
const refundReviewStore = require('./payroll-refund-review-store');
const reviewedCorrectionStore = require('./payroll-reviewed-correction-store');
const { normalizeReviewedCorrectionPreview, normalizeReviewedCorrectionCommand } = require('./payroll-reviewed-correction-command');
const calculationEntryBridge = require('./payroll-calculation-entry-bridge');
const calculationEntryLifecycle = require('./payroll-calculation-entry-lifecycle');
const { validateCalculatorReplay } = require('./payroll-calculator-replay');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { buildPayrollCalculatorSales } = require('./payroll-team-fund-source');
const { normalizeEligibilityPeriods, eligibilityPayloadSha256, loadLatestEligibilitySourceInTransaction,
  buildEligibleEmployees } = require('./payroll-employment-eligibility');
const { loadLatestProductDepartmentMappingInTransaction, mappingPayloadSha256, normalizeProductDepartmentMappings } = require('./payroll-product-department-source');
const { normalRevisionRequest, retroactiveRevisionRequest, buildNextDayDepartmentSnapshot, assertHistoryPreserved } = require('./payroll-product-department-revisions');
const { readPayrollEntryOverlapDiagnostic } = require('./payroll-entry-overlap-diagnostic');
const { buildPayrollOrderRevenueReconciliation } = require('./payroll-order-revenue-reconciliation');
const { beginPayrollSourceProducerTransaction, acquirePayrollSourceSnapshotLock, beginPayrollVerifiedRunSourceTransaction,
  beginPayrollVerifiedReadSourceTransaction } = require('./payroll-source-fence');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYOUT_RISK_ACK_POLICY = 'payroll-own-revenue-ceiling-v1';
const PERSONAL_CAP_ACK_POLICY = 'payroll-personal-cap-above-role-v1';

// Preview is owner-only and scenario-only, but a privileged caller can still
// submit oversized collections. Bound work before entering the calculator's
// employee × day and sales-line loops.
const MAX_PREVIEW_EMPLOYEES = 500;
const MAX_PREVIEW_SALES_LINES = 20000;
const MAX_PREVIEW_ATTENDANCE_ROWS = 20000;
const MAX_PREVIEW_VENUE_DAYS = 31;
const MAX_SCHEME_CHILD_ROWS = 15000;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

class PayrollSchemeServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PayrollSchemeServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new PayrollSchemeServiceError(code, status); };
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail('invalid_scheme_definition');
  return serialized;
};
const payoutConfigurationDigest = (definition) => {
  const sorted = (rows) => rows.map(canonicalJson).sort().map((row) => JSON.parse(row));
  const config = {
    mode: definition.mode, currency: definition.currency, effectiveFrom: definition.effectiveFrom,
    effectiveTo: definition.effectiveTo, roleParameters: definition.roleParameters,
    applyMilestones: definition.applyMilestones, milestoneCapPolicy: definition.milestoneCapPolicy,
    milestoneEligibility: definition.milestoneEligibility,
    sourcePolicies: definition.sourcePolicies,
    roleAssignments: sorted(definition.roleAssignments.map((row) => ({ employeeId: String(row.employeeId).toLowerCase(), roleId: row.roleId,
      effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo || null }))),
    employeeOverrides: sorted(definition.employeeOverrides.map((row) => ({ employeeId: String(row.employeeId).toLowerCase(), path: row.path,
      mode: row.mode, value: row.mode === 'override' ? row.value : undefined,
      effectiveFrom: row.effectiveFrom ?? definition.effectiveFrom, effectiveTo: row.effectiveTo ?? definition.effectiveTo }))),
    itemRules: sorted(definition.itemRules.map((row) => ({ menuItemId: String(row.menuItemId).toLowerCase(), roleId: row.roleId || null,
      employeeId: row.employeeId ? String(row.employeeId).toLowerCase() : null, mode: row.mode, rateBps: row.rateBps, priority: row.priority ?? 0 })))
  };
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
};
const personalCapExceptions = (definition, status = 400) => {
  try { return collectPersonalCapIncreases(definition); }
  catch (error) { if (error instanceof TypeError && String(error.code || '').startsWith('payroll_personal_cap_')) fail(error.code, status); throw error; }
};
const recordPayoutRiskAcknowledgement = async (db, actor, definition, acknowledgement) => {
  if (!acknowledgement || acknowledgement.confirmed !== true || acknowledgement.policyCode !== PAYOUT_RISK_ACK_POLICY) {
    fail('payroll_risk_acknowledgement_required', 400);
  }
  const configDigest = payoutConfigurationDigest(definition);
  const exceptions = personalCapExceptions(definition);
  if (exceptions.length && (acknowledgement.personalCapIncrease?.confirmed !== true
    || acknowledgement.personalCapIncrease.policyCode !== PERSONAL_CAP_ACK_POLICY)) {
    fail('payroll_personal_cap_increase_acknowledgement_required', 400);
  }
  const timestamp = await db.query('SELECT now() AS acknowledged_at');
  const audit = {
    confirmed: true, policyCode: PAYOUT_RISK_ACK_POLICY, configDigest,
    acknowledgedBy: actor.userId, acknowledgedByName: actor.name,
    acknowledgedAt: timestamp.rows[0].acknowledged_at
  };
  if (exceptions.length) audit.personalCapIncrease = { policyCode: PERSONAL_CAP_ACK_POLICY, configDigest,
    acknowledgedBy: actor.userId, acknowledgedByName: actor.name, acknowledgedAt: timestamp.rows[0].acknowledged_at, exceptions };
  return audit;
};
const cleanText = (value, max, code) => {
  if (typeof value !== 'string') fail(code);
  const result = value.trim();
  if (!result || result.length > max) fail(code);
  return result;
};
const nullableDate = (value, code) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(code);
  return value;
};
const sourcePoliciesForDefinition = (value) => {
  try { return normalizePayrollSourcePolicies(value); }
  catch (error) { fail(error.code || 'invalid_payroll_source_policies'); }
};
const ensureDefinition = (definition, schemeId, versionId) => {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) fail('scheme_definition_required');
  if (definition.employeeOverrides !== undefined && !Array.isArray(definition.employeeOverrides)) fail('invalid_employee_overrides');
  if (definition.itemRules !== undefined && !Array.isArray(definition.itemRules)) fail('invalid_item_rules');
  if ((definition.employeeOverrides?.length || 0) + (definition.itemRules?.length || 0)
      + (definition.roleAssignments?.length || 0) > MAX_SCHEME_CHILD_ROWS) fail('scheme_definition_too_large', 413);
  const effectiveFrom = nullableDate(definition.effectiveFrom, 'invalid_effective_from');
  if (!effectiveFrom) fail('effective_from_required');
  const effectiveTo = nullableDate(definition.effectiveTo, 'invalid_effective_to');
  if (effectiveTo && effectiveTo < effectiveFrom) fail('invalid_effective_window');
  const currency = definition.currency === undefined ? 'RUB' : String(definition.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('invalid_currency');
  const sourcePolicies = sourcePoliciesForDefinition(definition.sourcePolicies);
  const engineScheme = {
    id: schemeId,
    versionId,
    mode: definition.mode,
    currency,
    roleParameters: definition.roleParameters,
    applyMilestones: definition.applyMilestones,
    ...(definition.milestoneEligibility === undefined ? {} : { milestoneEligibility: definition.milestoneEligibility }),
    milestoneCapPolicy: definition.milestoneCapPolicy,
    sourcePolicies,
    employeeOverrides: Array.isArray(definition.employeeOverrides) ? definition.employeeOverrides : [],
    itemRules: Array.isArray(definition.itemRules) ? definition.itemRules : []
  };
  const errors = validateScheme(engineScheme);
  if (errors.length) fail('invalid_scheme_definition');
  const assignments = definition.roleAssignments === undefined ? [] : definition.roleAssignments;
  if (!Array.isArray(assignments)) fail('invalid_role_assignments');
  for (const item of assignments) {
    if (!item || typeof item !== 'object' || !item.employeeId || !item.roleId || !Object.hasOwn(engineScheme.roleParameters, item.roleId)) fail('invalid_role_assignment');
    const from = nullableDate(item.effectiveFrom, 'invalid_role_assignment');
    const to = nullableDate(item.effectiveTo, 'invalid_role_assignment');
    if (!from || from < effectiveFrom || (effectiveTo && (!to || to > effectiveTo)) || (to && to < from)) fail('role_assignment_outside_version');
  }
  for (const item of engineScheme.employeeOverrides) {
    const from = nullableDate(item.effectiveFrom ?? effectiveFrom, 'invalid_employee_override');
    const to = nullableDate(item.effectiveTo ?? effectiveTo, 'invalid_employee_override');
    if ((from && from < effectiveFrom) || (effectiveTo && (!to || to > effectiveTo)) || (to && from && to < from)) fail('employee_override_outside_version');
  }
  for (const item of engineScheme.itemRules) {
    if (!item || typeof item !== 'object' || !item.menuItemId || (item.roleId && !Object.hasOwn(engineScheme.roleParameters, item.roleId))) fail('invalid_item_rule');
    if (item.priority !== undefined && (!Number.isSafeInteger(item.priority) || item.priority < -2147483648 || item.priority > 2147483647)) fail('invalid_item_rule_priority');
  }
  // PostgreSQL UUID identity is case-insensitive. Match validation windows by
  // that same identity before storage; leave caller data and allocation IDs intact.
  const validationId = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : value;
  const validationScheme = { ...engineScheme, employeeOverrides: engineScheme.employeeOverrides.map(row => ({ ...row, employeeId: validationId(row.employeeId) })) };
  const validationAssignments = assignments.map(row => ({ ...row, employeeId: validationId(row.employeeId) }));
  const personalThresholdErrors = validatePersonalThresholdAssignments(validationScheme, validationAssignments);
  if (personalThresholdErrors.length) fail(personalThresholdErrors.includes('milestone_cap_policy_required')
    ? 'milestone_cap_policy_required' : 'invalid_personal_threshold');
  const personalParameterErrors = validatePersonalScalarAssignments(validationScheme, validationAssignments);
  if (personalParameterErrors.length) fail(personalParameterErrors.includes('milestone_cap_policy_required')
    ? 'milestone_cap_policy_required' : personalParameterErrors.includes('invalid_personal_cap') || personalParameterErrors.includes('cap_department_required')
      ? 'invalid_personal_cap' : 'invalid_personal_parameters');
  return { ...engineScheme, effectiveFrom, effectiveTo, roleAssignments: assignments };
};

const requireMilestoneConfigurationSchema = async (db, definition) => {
  if (definition.milestoneEligibility === undefined
      && !Object.values(definition.roleParameters).some(params => params.milestoneEligibility !== undefined)
      && !definition.employeeOverrides.some(row => row.path === 'milestoneEligibility')) return;
  // Config capability only, never source attestation or permission to create a
  // ready run. Preserve atomic rejection on installations still before 089.
  const result = await db.query(`SELECT to_regclass('payroll_milestone_day_snapshots') IS NOT NULL
      AND to_regclass('payroll_milestone_decision_snapshots') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('payroll_calculation_runs')
        AND attname='milestone_evidence_version' AND NOT attisdropped) AS ready`);
  if (result.rows[0]?.ready !== true) fail('payroll_milestone_eligibility_schema_required', 409);
};

const requirePersonalDepartmentConfigurationSchema = async (db, definition) => {
  // Inherit rows use the new paths too. Role-only department fields already
  // existed and must not require this additive personal-configuration capability.
  if (!definition.employeeOverrides.some(row => row.path === 'department' || row.path === 'cap.department')) return;
  const result = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid=to_regclass('payroll_employee_overrides')
      AND conname='payroll_employee_overrides_department_value_check'
      AND contype='c' AND convalidated
  ) AS ready`);
  if (result.rows[0]?.ready !== true) fail('payroll_personal_department_schema_required', 409);
};

const assertOwner = async (db, principal, lock = false) => {
  if (!principal || typeof principal.venueId !== 'string' || typeof principal.userId !== 'string') fail('authenticated_owner_required', 403);
  const result = await db.query(`SELECT id, full_name AS name
    FROM users
    WHERE id = $1 AND venue_id = $2 AND role = 'owner' AND is_active = true AND deleted_at IS NULL${lock ? ' FOR SHARE' : ''}`,
  [principal.userId, principal.venueId]);
  if (!result.rows[0]) fail('payroll_scheme_owner_only', 403);
  return { venueId: principal.venueId, userId: result.rows[0].id, name: cleanText(result.rows[0].name, 160, 'owner_name_required') };
};

const persistChildren = async (db, actor, versionId, definition) => {
  for (const assignment of definition.roleAssignments) {
    await db.query(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,effective_to,created_by,created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.venueId, versionId, assignment.employeeId, assignment.roleId, assignment.effectiveFrom, assignment.effectiveTo || null, actor.userId, actor.name]);
  }
  for (const override of definition.employeeOverrides) {
    const from = nullableDate(override.effectiveFrom ?? definition.effectiveFrom, 'invalid_employee_override');
    const to = nullableDate(override.effectiveTo ?? definition.effectiveTo, 'invalid_employee_override');
    await db.query(`INSERT INTO payroll_employee_overrides
      (venue_id,scheme_version_id,employee_id,parameter_path,override_mode,value_json,effective_from,effective_to,created_by,created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
    [actor.venueId, versionId, override.employeeId, override.path, override.mode, override.mode === 'override' ? JSON.stringify(override.value) : null,
      from, to, actor.userId, actor.name]);
  }
  for (const rule of definition.itemRules) {
    await db.query(`INSERT INTO payroll_item_commission_rules
      (venue_id,scheme_version_id,product_id,role_key,employee_id,rule_mode,rate_bps,priority,created_by,created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor.venueId, versionId, rule.menuItemId, rule.roleId || null, rule.employeeId || null, rule.mode, rule.rateBps,
      Number.isSafeInteger(rule.priority) ? rule.priority : 0, actor.userId, actor.name]);
  }
};

const loadVersion = async (db, venueId, versionId) => {
  const result = await db.query(`SELECT v.*,v.effective_from::text AS effective_from,v.effective_to::text AS effective_to,
      s.name AS scheme_name,s.description AS scheme_description
    FROM payroll_scheme_versions v JOIN payroll_schemes s ON s.venue_id=v.venue_id AND s.id=v.scheme_id
    WHERE v.venue_id=$1 AND v.id=$2`, [venueId, versionId]);
  const version = result.rows[0];
  if (!version) fail('payroll_scheme_version_not_found', 404);
  const assignments = await db.query(`SELECT employee_id AS "employeeId",role_key AS "roleId",effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"
    FROM payroll_role_assignments WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY employee_id,effective_from,id`, [venueId, versionId]);
  const overrides = await db.query(`SELECT employee_id AS "employeeId",parameter_path AS path,override_mode AS mode,value_json AS value,
      effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"
    FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY employee_id,parameter_path,effective_from,id`, [venueId, versionId]);
  const itemRules = await db.query(`SELECT id,product_id AS "menuItemId",role_key AS "roleId",employee_id AS "employeeId",rule_mode AS mode,rate_bps AS "rateBps",priority
    FROM payroll_item_commission_rules WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY product_id,priority DESC,id`, [venueId, versionId]);
  const config = typeof version.config_json === 'string' ? JSON.parse(version.config_json) : version.config_json;
  const scheme = {
    id: version.scheme_id,
    versionId: version.id,
    name: version.scheme_name,
    description: version.scheme_description,
    versionNo: version.version_no,
    mode: version.mode,
    currency: version.currency,
    effectiveFrom: version.effective_from instanceof Date ? version.effective_from.toISOString().slice(0, 10) : String(version.effective_from).slice(0, 10),
    effectiveTo: version.effective_to ? (version.effective_to instanceof Date ? version.effective_to.toISOString().slice(0, 10) : String(version.effective_to).slice(0, 10)) : null,
    status: version.status,
    payoutRiskAcknowledgement: config.payoutRiskAcknowledgement || null,
    roleParameters: config.roleParameters || {},
    applyMilestones: config.applyMilestones,
    ...(config.milestoneEligibility === undefined ? {} : { milestoneEligibility: config.milestoneEligibility }),
    milestoneCapPolicy: config.milestoneCapPolicy,
    sourcePolicies: sourcePoliciesForDefinition(config.sourcePolicies),
    roleAssignments: assignments.rows,
    // pg already decodes jsonb, including scalar strings such as a mode or
    // loss policy. Parsing those a second time corrupts valid string overrides.
    employeeOverrides: overrides.rows.map((row) => ({ ...row, value: row.mode === 'override' ? row.value : undefined })),
    itemRules: itemRules.rows
  };
  const acknowledgement = scheme.payoutRiskAcknowledgement;
  const acknowledgementCurrent = Boolean(acknowledgement?.policyCode === PAYOUT_RISK_ACK_POLICY
    && /^[a-f0-9]{64}$/.test(acknowledgement.configDigest || '')
    && acknowledgement.configDigest === payoutConfigurationDigest(scheme)
    && UUID.test(String(acknowledgement.acknowledgedBy || ''))
    && typeof acknowledgement.acknowledgedByName === 'string' && acknowledgement.acknowledgedByName.trim()
    && typeof acknowledgement.acknowledgedAt === 'string' && Number.isFinite(Date.parse(acknowledgement.acknowledgedAt)));
  if (acknowledgementCurrent) scheme.payoutRiskAcknowledgement = { ...acknowledgement, confirmed: true };
  scheme.payoutRiskAcknowledgementCurrent = acknowledgementCurrent;
  return scheme;
};

const recordRevision = async (db, actor, scheme, changeKind) => {
  const next = await db.query(`SELECT COALESCE(MAX(revision_no),0)::int+1 AS revision_no
    FROM payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2`, [actor.venueId, scheme.versionId]);
  const revisionNo = next.rows[0].revision_no;
  await db.query(`INSERT INTO payroll_scheme_version_revisions
    (venue_id,scheme_version_id,revision_no,change_kind,config_snapshot_json,changed_by,changed_by_name)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [actor.venueId, scheme.versionId, revisionNo, changeKind,
    JSON.stringify(scheme), actor.userId, actor.name]);
  return revisionNo;
};

const withOwnerTransaction = async (pool, principal, callback, { sourceProducer = false } = {}) => {
  const client = await pool.connect();
  let cleanupError;
  try {
    if (sourceProducer) await beginPayrollSourceProducerTransaction(client, principal?.venueId);
    else await client.query('BEGIN');
    const actor = await assertOwner(client, principal, true);
    const result = await callback(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(error => { cleanupError = error; });
    if (error instanceof PayrollSchemeServiceError) throw error;
    if (error?.code === '23505') fail('payroll_scheme_conflict', 409);
    if (error?.code === '23P01' && error?.message === 'payroll employment periods overlap') fail('payroll_employment_periods_overlap', 409);
    if (error?.code === '23P01' && String(error?.message || '').includes('payroll product department mapping periods overlap')) fail('payroll_product_department_mappings_overlap', 409);
    if (error?.code === '23P01') fail('payroll_scheme_effective_window_conflict', 409);
    if (error?.code === '23503') fail('payroll_scheme_reference_invalid', 400);
    if (error?.code === '23514' && ['payroll_scheme_versions_mode_check', 'payroll_employee_overrides_parameter_path_check'].includes(error.constraint)) {
      fail('payroll_personal_target_schema_required', 409);
    }
    if (error?.code === '23514') fail('payroll_scheme_configuration_rejected', 400);
    if (error?.code === '42501') fail('payroll_scheme_owner_only', 403);
    if (error?.code === '22023' && String(error?.message || '').includes('payroll product department')) fail('payroll_product_department_timezone_invalid', 409);
    if (error?.code === '22P02' || error?.code === '22003') fail('payroll_scheme_reference_invalid', 400);
    throw error;
  } finally {
    client.release(cleanupError);
  }
};

const withOwnerRead = async (pool, principal, callback, { sourceSnapshot = false } = {}) => {
  const client = await pool.connect();
  let releaseSourceLock = null;
  let clientReusable = true;
  let cleanupError = null;
  try {
    if (sourceSnapshot) releaseSourceLock = await beginPayrollVerifiedReadSourceTransaction(client, principal?.venueId);
    else await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor = await assertOwner(client, principal, false);
    const result = await callback(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (error?.discardPayrollConnection) cleanupError = error;
    await client.query('ROLLBACK').catch(error => { cleanupError = error; });
    throw error;
  } finally {
    if (releaseSourceLock) {
      try { await releaseSourceLock(); }
      catch (error) { clientReusable = false; client.release(error); throw error; }
    }
    if (clientReusable) client.release(cleanupError || undefined);
  }
};

// All review writers share the source fence, acquired before the RR snapshot.
// The private capability also permits the recognition reader on this RW client.
const withOwnerSourceWrite = async (pool, principal, callback, errorPrefix = 'payroll_refund_review') => {
  if (!principal || Object.getPrototypeOf(principal) !== Object.prototype
      || Object.values(Object.getOwnPropertyDescriptors(principal)).some(d => !Object.hasOwn(d, 'value'))
      || typeof principal.userId !== 'string' || !UUID.test(principal.userId)
      || typeof principal.venueId !== 'string' || !UUID.test(principal.venueId)) fail('authenticated_owner_required', 403);
  const owner = { userId: principal.userId.toLowerCase(), venueId: principal.venueId.toLowerCase() };
  const client = await pool.connect();
  let releaseSourceLock = null, discardConnectionError = null;
  try {
    releaseSourceLock = await beginPayrollVerifiedRunSourceTransaction(client, owner.venueId);
    const actor = await assertOwner(client, owner, true);
    const result = await callback(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (error?.discardPayrollConnection) discardConnectionError = error;
    await client.query('ROLLBACK').catch(cleanupError => { discardConnectionError = cleanupError; });
    if (['40001', '40P01'].includes(error?.code)) fail(`${errorPrefix}_retry_required`, 409);
    if (error?.code === '23505') fail(`${errorPrefix}_conflict`, 409);
    if (error?.code === '23P01') fail('payroll_period_overlap', 409);
    if (['42P01', '42703'].includes(error?.code)) fail(`${errorPrefix}_schema_required`, 409);
    if (errorPrefix === 'payroll_entry_materialization' && ['23514', '23503', '55000'].includes(error?.code)) fail('payroll_entry_materialization_rejected', 409);
    if (errorPrefix === 'payroll_entry_lifecycle' && ['23514', '23503', '55000'].includes(error?.code)) fail('payroll_entry_lifecycle_rejected', 409);
    if (errorPrefix === 'payroll_correction' && ['23514', '23503', '55000'].includes(error?.code)) fail('payroll_correction_rejected', 409);
    throw error;
  } finally {
    try { if (releaseSourceLock) await releaseSourceLock(); }
    catch (error) { discardConnectionError = error; throw error; }
    finally { client.release(discardConnectionError || undefined); }
  }
};
const reviewRequest = (id, input, decision = false) => {
  const keys = decision ? ['decision', 'reason', 'expectedAssessmentHash', 'idempotencyKey'] : ['idempotencyKey'];
  if (typeof id !== 'string' || !UUID.test(id) || !input || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)
      || (decision && (!['hold_for_review', 'close_without_payroll_change', 'acknowledge_no_effect'].includes(input.decision)
        || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 2000
        || typeof input.expectedAssessmentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedAssessmentHash)))) {
    fail('invalid_payroll_refund_review_request');
  }
  return id.toLowerCase();
};

const calculateScenario = (scheme, previewInput) => {
  const result = calculatePayrollScheme({
  ...previewInput,
  roleAssignments: scheme.roleAssignments,
  scheme: {
    id: scheme.id,
    versionId: scheme.versionId,
    mode: scheme.mode,
    currency: scheme.currency,
    roleParameters: scheme.roleParameters,
    applyMilestones: scheme.applyMilestones,
    ...(scheme.milestoneEligibility === undefined ? {} : { milestoneEligibility: scheme.milestoneEligibility }),
    milestoneCapPolicy: scheme.milestoneCapPolicy,
    employeeOverrides: scheme.employeeOverrides,
    itemRules: scheme.itemRules
  }
  });
  if (scheme.sourcePolicies === undefined) return result;
  return { ...result, sourcePolicyEvaluation: { state: 'selected_not_applied', officialReady: false,
    requiredFacts: requiredPayrollSourceFacts(scheme.sourcePolicies) } };
};

const assertPreviewSize = (input, scheme) => {
  if ((Array.isArray(input.employees) && input.employees.length > MAX_PREVIEW_EMPLOYEES)
      || (Array.isArray(input.sales) && input.sales.length > MAX_PREVIEW_SALES_LINES)
      || (Array.isArray(input.attendance) && input.attendance.length > MAX_PREVIEW_ATTENDANCE_ROWS)
      || (Array.isArray(input.venueDailyTurnover) && input.venueDailyTurnover.length > MAX_PREVIEW_VENUE_DAYS)) {
    fail('preview_input_too_large', 413);
  }
  if ((scheme.roleAssignments?.length || 0) + (scheme.employeeOverrides?.length || 0)
      + (scheme.itemRules?.length || 0) > MAX_SCHEME_CHILD_ROWS) fail('scheme_definition_too_large', 413);
};

const sumCentsSafely = (values) => {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return total >= MIN_SAFE_BIGINT && total <= MAX_SAFE_BIGINT ? Number(total) : null;
};

const makeService = (pool) => {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('payroll_scheme_pool_required');
  const attendanceManifest = makePayrollAttendanceManifestService(pool);
  const getEntryOverlapDiagnostic = (principal, input) => withOwnerRead(pool, principal, (db, actor) =>
    readPayrollEntryOverlapDiagnostic(db, actor.venueId, input));
  const listEmploymentEligibilityEmployees = async principal => withOwnerRead(pool, principal, async (db, actor) => {
    const result = await db.query(`SELECT id::text AS id,full_name AS name,is_active AS active
      FROM users WHERE venue_id=$1 AND deleted_at IS NULL ORDER BY full_name,id`, [actor.venueId]);
    return { schemaVersion: 1, items: result.rows };
  });
  const getEmploymentEligibilityHistory = async principal => withOwnerRead(pool, principal, async (db, actor) => {
    const source = await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
    if (source.component.status === 'unsupported') fail('payroll_employment_eligibility_schema_required', 503);
    const history = await db.query(`SELECT id::text,revision_no AS "revisionNo",supersedes_revision_id::text AS "supersedesRevisionId",
        reason,payload_sha256 AS "payloadSha256",period_count AS "periodCount",created_by_name AS "createdByName",created_at::text AS "createdAt"
      FROM payroll_employment_eligibility_revisions WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 30`, [actor.venueId]);
    return {
      schemaVersion: 1,
      current: source.revision ? { ...source.revision, periods: source.periods } : null,
      component: source.component,
      history: history.rows
    };
  });
  const createEmploymentEligibilityRevision = async (principal, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).length !== 4 || !Object.hasOwn(input, 'reason') || !Object.hasOwn(input, 'idempotencyKey')
        || !Object.hasOwn(input, 'expectedRevisionId')
        || !Object.hasOwn(input, 'periods')
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
      fail('invalid_payroll_employment_revision');
    }
    if (input.expectedRevisionId !== null && !UUID.test(String(input.expectedRevisionId || ''))) fail('invalid_payroll_employment_revision');
    const expectedRevisionId = input.expectedRevisionId === null ? null : String(input.expectedRevisionId).toLowerCase();
    const reason = cleanText(input.reason, 1000, 'invalid_payroll_employment_reason');
    if (reason.length < 8) fail('invalid_payroll_employment_reason');
    const idempotencyKey = cleanText(input.idempotencyKey, 160, 'invalid_payroll_employment_idempotency_key');
    if (idempotencyKey.length < 8) fail('invalid_payroll_employment_idempotency_key');
    let periods;
    try { periods = normalizeEligibilityPeriods(input.periods); }
    catch (error) { fail(error.message === 'payroll_employment_periods_overlap'
      ? error.message : 'invalid_payroll_employment_periods'); }
    const payloadSha256 = eligibilityPayloadSha256(periods, reason, expectedRevisionId);
    return withOwnerTransaction(pool, principal, async (db, actor) => {
      // Serialize idempotency lookup and revision allocation even before the DB guard executes.
      await db.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [actor.venueId]);
      const prior = await db.query(`SELECT id::text,revision_no,supersedes_revision_id::text AS "supersedesRevisionId" FROM payroll_employment_eligibility_revisions
        WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, idempotencyKey]);
      if (prior.rows[0]) {
        const stored = await db.query(`SELECT payload_sha256 FROM payroll_employment_eligibility_revisions WHERE venue_id=$1 AND id=$2`,
          [actor.venueId, prior.rows[0].id]);
        if (stored.rows[0]?.payload_sha256 !== payloadSha256 || prior.rows[0].supersedesRevisionId !== expectedRevisionId) {
          fail('payroll_employment_idempotency_conflict', 409);
        }
        const source = await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
        if (source.revision?.id === prior.rows[0].id) return { ...source.revision, periods: source.periods, replayed: true };
        const revision = await db.query(`SELECT id::text,revision_no AS "revisionNo",supersedes_revision_id::text AS "supersedesRevisionId",
            reason,payload_sha256 AS "payloadSha256",period_count AS "periodCount",created_by_name AS "createdByName",created_at::text AS "createdAt"
          FROM payroll_employment_eligibility_revisions WHERE venue_id=$1 AND id=$2`, [actor.venueId, prior.rows[0].id]);
        const rows = await db.query(`SELECT employee_id::text AS "employeeId",employee_name_snapshot AS "employeeName",
            effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"
          FROM payroll_employment_eligibility_periods WHERE venue_id=$1 AND revision_id=$2 ORDER BY employee_id,effective_from,id`,
        [actor.venueId, prior.rows[0].id]);
        return { ...revision.rows[0], periods: rows.rows.map(row => ({ ...row, effectiveTo: row.effectiveTo || null })), replayed: true };
      }
      const latest = await db.query(`SELECT id::text,revision_no FROM payroll_employment_eligibility_revisions
        WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 1`, [actor.venueId]);
      if ((latest.rows[0]?.id || null) !== expectedRevisionId) fail('payroll_employment_revision_conflict', 409);
      const revisionNo = Number(latest.rows[0]?.revision_no || 0) + 1;
      const created = await db.query(`INSERT INTO payroll_employment_eligibility_revisions
        (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
      [actor.venueId, revisionNo, latest.rows[0]?.id || null, reason, idempotencyKey, payloadSha256, periods.length, actor.userId, actor.name]);
      const revisionId = created.rows[0].id;
      for (const period of periods) {
        await db.query(`INSERT INTO payroll_employment_eligibility_periods
          (venue_id,revision_id,employee_id,employee_name_snapshot,effective_from,effective_to)
          VALUES ($1,$2,$3,'',$4,$5)`, [actor.venueId, revisionId, period.employeeId, period.effectiveFrom, period.effectiveTo]);
      }
      const source = await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
      if (source.revision?.id !== revisionId) fail('payroll_employment_revision_conflict', 409);
      return { ...source.revision, periods: source.periods, replayed: false };
    }, { sourceProducer: true });
  };
  const loadProductDepartmentRevision = async (db, venueId, revisionId) => {
    const revision = (await db.query(`SELECT id::text,venue_id::text AS "venueId",revision_no AS "revisionNo",
      supersedes_revision_id::text AS "supersedesRevisionId",reason,idempotency_key AS "idempotencyKey",
      payload_sha256 AS "payloadSha256",mapping_count AS "mappingCount",effective_from::text AS "effectiveFrom",
      retroactive_attested AS "retroactiveAttested",retroactive_reason AS "retroactiveReason",
      created_by::text AS "createdBy",created_by_name AS "createdByName",
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS "createdAt"
      FROM payroll_product_department_revisions WHERE venue_id=$1 AND id=$2`, [venueId, revisionId])).rows[0];
    if (!revision) return null;
    const mappings = (await db.query(`SELECT product_id::text AS "productId",product_name_snapshot AS "productName",
      department_code AS "departmentCode",department_name_snapshot AS "departmentName",effective_from::text AS "effectiveFrom",
      effective_to::text AS "effectiveTo" FROM payroll_product_department_mappings
      WHERE venue_id=$1 AND revision_id=$2 ORDER BY product_id,effective_from,effective_to NULLS LAST,department_code,department_name_snapshot`,
    [venueId, revision.id])).rows;
    const normalized = normalizeProductDepartmentMappings(mappings);
    if (normalized.length !== revision.mappingCount || mappingPayloadSha256(normalized) !== revision.payloadSha256) {
      fail('payroll_product_department_revision_integrity_failed', 503);
    }
    return { ...revision, mappings: normalized };
  };
  const getProductDepartmentMappings = async principal => withOwnerRead(pool, principal, async (db, actor) => {
    const capability = (await db.query(`SELECT to_regclass('payroll_product_department_revisions') IS NOT NULL AS revisions,
      to_regclass('payroll_product_department_mappings') IS NOT NULL AS mappings,
      to_regclass('products') IS NOT NULL AS products`)).rows[0];
    if (!capability?.revisions || !capability?.mappings || !capability?.products) fail('payroll_product_department_schema_required', 503);
    const venueTimezone = (await db.query('SELECT timezone FROM venues WHERE id=$1', [actor.venueId])).rows[0]?.timezone;
    if (typeof venueTimezone !== 'string' || !venueTimezone.trim()) fail('payroll_product_department_timezone_invalid', 503);
    const localToday = (await db.query(`SELECT (transaction_timestamp() AT TIME ZONE $1)::date::text AS day`, [venueTimezone])).rows[0]?.day;
    if (typeof localToday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localToday)) fail('payroll_product_department_timezone_invalid', 503);
    const nextEffectiveFrom = new Date(Date.parse(`${localToday}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    const latestSource = await loadLatestProductDepartmentMappingInTransaction(db, actor.venueId);
    const currentRevision = latestSource.revision ? await loadProductDepartmentRevision(db, actor.venueId, latestSource.revision.id) : null;
    const history = (await db.query(`SELECT id::text,revision_no AS "revisionNo",supersedes_revision_id::text AS "supersedesRevisionId",
      reason,payload_sha256 AS "payloadSha256",mapping_count AS "mappingCount",effective_from::text AS "effectiveFrom",
      retroactive_attested AS "retroactiveAttested",retroactive_reason AS "retroactiveReason",
      created_by_name AS "createdByName",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS "createdAt"
      FROM payroll_product_department_revisions WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 30`, [actor.venueId])).rows;
    const products = (await db.query(`SELECT id::text AS id,name,category,is_active AS active FROM products
      WHERE venue_id=$1 AND is_active=true ORDER BY lower(name),id LIMIT 10001`, [actor.venueId])).rows;
    const departmentOptions = [...new Map((currentRevision?.mappings || []).map(row => [row.departmentCode,
      { code: row.departmentCode, name: row.departmentName }])).values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const productOptionsTruncated = products.length > 10000;
    const currentAssignments = (currentRevision?.mappings || []).filter(row => row.effectiveFrom <= nextEffectiveFrom
      && (!row.effectiveTo || row.effectiveTo >= nextEffectiveFrom)).map(row => ({ productId: row.productId,
        departmentCode: row.departmentCode, departmentName: row.departmentName }));
    return { schemaVersion: 1, venueId: actor.venueId, timezone: venueTimezone, nextEffectiveFrom, currentAssignments,
      component: currentRevision ? { status: 'available', reasons: [], sourceWatermark: latestSource.component.sourceWatermark,
        watermarkScope: latestSource.component.watermarkScope } : latestSource.component,
      currentRevision, history, productOptions: products.slice(0, 10000), productOptionsTruncated, departmentOptions };
  });
  const getProductDepartmentRevision = async (principal, revisionId) => {
    if (!UUID.test(String(revisionId || ''))) fail('invalid_payroll_product_department_revision_id');
    return withOwnerRead(pool, principal, async (db, actor) => {
      const capability = (await db.query(`SELECT to_regclass('payroll_product_department_revisions') IS NOT NULL AS revisions,
        to_regclass('payroll_product_department_mappings') IS NOT NULL AS mappings`)).rows[0];
      if (!capability?.revisions || !capability?.mappings) fail('payroll_product_department_schema_required', 503);
      const revision = await loadProductDepartmentRevision(db, actor.venueId, String(revisionId).toLowerCase());
      if (!revision) fail('payroll_product_department_revision_not_found', 404);
      return revision;
    });
  };
  const writeProductDepartmentRevision = async (principal, input, retroactive = false) => {
    const request = retroactive ? retroactiveRevisionRequest(input) : normalRevisionRequest(input);
    return withOwnerTransaction(pool, principal, async (db, actor) => {
      await db.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [actor.venueId]);
      const capability = (await db.query(`SELECT to_regclass('payroll_product_department_revisions') IS NOT NULL AS revisions,
        to_regclass('payroll_product_department_mappings') IS NOT NULL AS mappings, to_regclass('products') IS NOT NULL AS products`)).rows[0];
      if (!capability?.revisions || !capability?.mappings || !capability?.products) fail('payroll_product_department_schema_required', 503);
      const latestHeader = (await db.query(`SELECT id::text,revision_no AS "revisionNo",effective_from::text AS "effectiveFrom",
        supersedes_revision_id::text AS "supersedesRevisionId" FROM payroll_product_department_revisions
        WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 1`, [actor.venueId])).rows[0] || null;
      const priorRequest = (await db.query(`SELECT id::text FROM payroll_product_department_revisions
        WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, request.idempotencyKey])).rows[0];
      if (priorRequest) {
        const prior = await loadProductDepartmentRevision(db, actor.venueId, priorRequest.id);
        const sameHeader = prior.reason === request.reason && prior.supersedesRevisionId === request.expectedRevisionId
          && prior.retroactiveAttested === retroactive
          && (retroactive ? prior.effectiveFrom === request.effectiveFrom && prior.retroactiveReason === request.retroactiveReason
            && requestRetroMappingsMatchSnapshot(request.mappings, prior.mappings)
            : !prior.retroactiveReason && requestAssignmentsMatchSnapshot(request.mappings, prior));
        if (!sameHeader) fail('payroll_product_department_idempotency_conflict', 409);
        return { ...prior, replayed: true };
      }
      if ((latestHeader?.id || null) !== request.expectedRevisionId) fail('payroll_product_department_revision_conflict', 409);
      const timezone = (await db.query('SELECT timezone FROM venues WHERE id=$1', [actor.venueId])).rows[0]?.timezone;
      if (typeof timezone !== 'string' || !timezone.trim()) fail('payroll_product_department_timezone_invalid', 409);
      const localToday = (await db.query(`SELECT (transaction_timestamp() AT TIME ZONE $1)::date::text AS day`, [timezone])).rows[0]?.day;
      if (typeof localToday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localToday)) fail('payroll_product_department_timezone_invalid', 409);
      const effectiveFrom = retroactive ? request.effectiveFrom : new Date(Date.parse(`${localToday}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
      if (retroactive && effectiveFrom > localToday) fail('payroll_product_department_retroactive_date_invalid');
      const previousRevision = latestHeader ? await loadProductDepartmentRevision(db, actor.venueId, latestHeader.id) : null;
      const previousMappings = previousRevision?.mappings || [];
      let mappings;
      if (retroactive) {
        mappings = normalizeProductDepartmentMappings(request.mappings);
        if (JSON.stringify(mappings) === JSON.stringify(previousMappings)) fail('payroll_product_department_retroactive_no_change');
      } else {
        const assignments = request.mappings;
        const boundary = effectiveFrom;
        const previousActive = new Map(previousMappings.filter(row => row.effectiveFrom <= boundary
          && (!row.effectiveTo || row.effectiveTo >= boundary)).map(row => [row.productId, row]));
        const productIdsNeedingCatalog = assignments.filter(row => {
          const old = previousActive.get(row.productId);
          return !old || old.departmentCode !== row.departmentCode || old.departmentName !== row.departmentName;
        }).map(row => row.productId);
        const productRows = productIdsNeedingCatalog.length ? (await db.query(`SELECT id::text,name,is_active FROM products
          WHERE venue_id=$1 AND id=ANY($2::uuid[]) AND is_active=true`, [actor.venueId, productIdsNeedingCatalog])).rows : [];
        const products = new Map(productRows.map(row => [row.id.toLowerCase(), { name: row.name, active: row.is_active }]));
        mappings = buildNextDayDepartmentSnapshot({ previousMappings, assignments, products, effectiveFrom });
        assertHistoryPreserved(previousMappings, mappings, effectiveFrom);
      }
      if (mappings.length > 10000) fail('payroll_product_department_mappings_invalid');
      const changedProductIds = mappings.filter(row => !previousMappings.some(previous => JSON.stringify(previous) === JSON.stringify(row)))
        .map(row => row.productId);
      if (retroactive && changedProductIds.length) {
        const sameVenueProducts = new Map((await db.query(`SELECT id::text,name FROM products WHERE venue_id=$1 AND id=ANY($2::uuid[])`,
          [actor.venueId, [...new Set(changedProductIds)]])).rows.map(row => [row.id.toLowerCase(), row.name]));
        // Rows already frozen in the previous snapshot remain valid if catalog items were archived/deleted.
        const invalid = mappings.filter(row => changedProductIds.includes(row.productId)
          && !sameVenueProducts.has(row.productId) && !previousMappings.some(previous => JSON.stringify(previous) === JSON.stringify(row)));
        if (invalid.length) fail('payroll_product_department_product_invalid');
        mappings = mappings.map(row => sameVenueProducts.has(row.productId)
          ? { ...row, productName: String(sameVenueProducts.get(row.productId) || '').trim() } : row);
      }
      const payloadSha256 = mappingPayloadSha256(mappings), revisionNo = (latestHeader?.revisionNo || 0) + 1;
      const header = await db.query(`INSERT INTO payroll_product_department_revisions
        (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,mapping_count,effective_from,
         retroactive_attested,retroactive_reason,created_by,created_by_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text`,
      [actor.venueId, revisionNo, latestHeader?.id || null, request.reason, request.idempotencyKey, payloadSha256, mappings.length,
        effectiveFrom, retroactive, retroactive ? request.retroactiveReason : null, actor.userId, actor.name]);
      const revisionId = header.rows[0].id;
      for (const row of mappings) await db.query(`INSERT INTO payroll_product_department_mappings
        (venue_id,revision_id,product_id,product_name_snapshot,department_code,department_name_snapshot,effective_from,effective_to)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.venueId, revisionId, row.productId, row.productName, row.departmentCode,
        row.departmentName, row.effectiveFrom, row.effectiveTo]);
      const saved = await loadProductDepartmentRevision(db, actor.venueId, revisionId);
      return { ...saved, replayed: false };
    }, { sourceProducer: true });
  };
  const requestAssignmentsMatchSnapshot = (assignments, revision) => {
    const atBoundary = revision.mappings.filter(row => row.effectiveFrom <= revision.effectiveFrom
      && (!row.effectiveTo || row.effectiveTo >= revision.effectiveFrom)).map(row => ({ productId: row.productId,
        departmentCode: row.departmentCode, departmentName: row.departmentName })).sort((a, b) => a.productId.localeCompare(b.productId));
    return JSON.stringify(atBoundary) === JSON.stringify(assignments);
  };
  const requestRetroMappingsMatchSnapshot = (requested, stored) => {
    const semantic = rows => rows.map(row => ({ productId: row.productId, departmentCode: row.departmentCode,
      departmentName: row.departmentName, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo }))
      .sort((a, b) => a.productId.localeCompare(b.productId) || a.effectiveFrom.localeCompare(b.effectiveFrom));
    return JSON.stringify(semantic(requested)) === JSON.stringify(semantic(stored));
  };
  const getSourceReadiness = async (principal, versionId, input) => {
    const period = parsePayrollReadinessPeriod(input);
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      return readPayrollSourceReadinessInTransaction(db, actor, scheme, period, attendanceManifest);
    }, { sourceSnapshot: true });
  };
  const collectSourcedPayrollContext = async (db, actor, scheme, period, sharedSources = undefined) => {
      const evidence = await readPayrollSourceReadinessEvidenceInTransaction(db, actor, scheme, period, attendanceManifest,
        sharedSources ? { recognitionManifest: sharedSources.recognitionManifest, sharedSources } : undefined);
      const periodClosureRow = sharedSources?.closure ? { transaction_timestamp: sharedSources.closure.transactionTimestamp,
        venue_local_date: sharedSources.closure.venueLocalDate, timezone: sharedSources.closure.timezone }
        : (await db.query(`SELECT transaction_timestamp()::text AS transaction_timestamp,
          (transaction_timestamp() AT TIME ZONE v.timezone)::date::text AS venue_local_date, v.timezone AS timezone
        FROM venues v WHERE v.id=$1`, [actor.venueId])).rows[0];
      if (!periodClosureRow) throw new Error('payroll_readiness_timezone_missing');
      const closedOrdersResult = await db.query(`SELECT o.id::text AS order_id,
          to_char(o.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS closed_at,
          s.id::text AS pricing_snapshot_id,s.subtotal_minor::text,s.discount_minor::text,
          s.minimum_adjustment_minor::text,s.final_total_minor::text,
          (s.id IS NOT NULL AND s.subtotal_minor IS NOT NULL AND s.discount_minor IS NOT NULL
            AND s.minimum_adjustment_minor IS NOT NULL AND s.final_total_minor IS NOT NULL
            AND s.subtotal_minor>=s.discount_minor
            AND s.final_total_minor=s.subtotal_minor-s.discount_minor+s.minimum_adjustment_minor) AS canonical_valid
        FROM orders o JOIN venues v ON v.id=o.venue_id
        LEFT JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
        WHERE o.venue_id=$1 AND o.status='closed'
          AND o.closed_at >= ($2::date::timestamp AT TIME ZONE v.timezone)
          AND o.closed_at < (($3::date + 1)::timestamp AT TIME ZONE v.timezone)
        ORDER BY o.closed_at,o.id`, [actor.venueId, period.from, period.to]);
      const orderRevenueReconciliation = buildPayrollOrderRevenueReconciliation({
        venueId: actor.venueId, currency: scheme.currency, period,
        venueTimezone: evidence.readiness.period.timezone,
        orders: closedOrdersResult.rows.map(row => ({ orderId: row.order_id, closedAt: row.closed_at,
          canonicalPricing: row.pricing_snapshot_id ? { snapshotId: row.pricing_snapshot_id,
            subtotalMinor: row.subtotal_minor, discountMinor: row.discount_minor,
            minimumAdjustmentMinor: row.minimum_adjustment_minor, finalTotalMinor: row.final_total_minor,
            valid: row.canonical_valid === true } : null })),
        recognitionManifest: evidence.recognitionManifest
      });
      // One owner-checked RR/RO transaction supplies both calculator evidence
      // and candidate-only sale/refund rows. The latter never enter calculatorInput.
      const components = {
        recognitionManifest: { ...evidence.readiness.components.recognitionManifest,
          venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } },
        recognizedLineRefunds: { ...evidence.readiness.components.recognizedLineRefunds,
          venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } },
        fullEmployeeNetRevenue: { ...evidence.readiness.components.fullEmployeeNetRevenue,
          venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } }
      };
      for (const key of ['canonicalLinePricing', 'payrollSaleCredit', 'employeeRoleCoverage']) {
        const component = evidence.readiness.components[key];
        if (component) components[key] = { ...component, venueId: actor.venueId, currency: scheme.currency,
          period: { from: period.from, to: period.to } };
      }
      for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights', 'marginCosts']) {
        const component = evidence.readiness.components[key];
        if (component) components[key] = { ...component, venueId: actor.venueId, currency: scheme.currency,
          period: { from: period.from, to: period.to } };
      }
      const attestations = {};
      if (evidence.departmentMappingSource) attestations.immutableDepartmentAttribution = {
        status: evidence.departmentMappingSource.status, reasons: evidence.departmentMappingSource.reasons,
        sourceWatermark: evidence.departmentMappingSource.sourceWatermark,
        watermarkScope: evidence.departmentMappingSource.watermarkScope, venueId: actor.venueId,
        currency: scheme.currency, period: { from: period.from, to: period.to }
      };
      if (evidence.readiness.components.immutableDepartmentAttribution) {
        components.immutableDepartmentAttribution = { ...evidence.readiness.components.immutableDepartmentAttribution,
          venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } };
      }
      const calculatorInput = { periodFrom: period.from, periodTo: period.to };
      let calculationSourceBundle = null;
      {
        // These collections are server-projected candidates only. They are
        // sourced from the selected saved version and owner-attested history;
        // missing sales, role coverage or other required facts still block
        // the calculation input contract below.
        calculatorInput.roleAssignments = structuredClone(scheme.roleAssignments || []);
        const requiredFacts = buildPayrollModeAvailability(evidence.readiness.components, {}, scheme, period)[scheme.mode].requiredFacts;
        let venueDailyTurnoverSource = null;
        if (requiredFacts.includes('venueDailyTurnover')) {
          try {
            venueDailyTurnoverSource = await makePayrollVenueTurnoverSource(db).getVenueDailyTurnover(actor, {
              from: `${period.from.slice(0, 7)}-01`, through: period.to
            });
            const component = { status: 'available', reasons: [], sourceWatermark: venueDailyTurnoverSource.sourceWatermark,
              watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId: actor.venueId, currency: scheme.currency,
              period: { from: period.from, to: period.to } };
            components.venueDailyTurnover = component;
            attestations.venueDailyTurnover = component;
            calculatorInput.venueDailyTurnover = structuredClone(venueDailyTurnoverSource.venueDailyTurnover);
            calculatorInput.venueDailyTurnoverCoverage = { from: venueDailyTurnoverSource.from,
              through: venueDailyTurnoverSource.through, complete: true, venueId: actor.venueId, currency: scheme.currency,
              period: { from: period.from, to: period.to }, venueTimezone: venueDailyTurnoverSource.venueTimezone,
              sourceWatermark: venueDailyTurnoverSource.sourceWatermark, watermarkScope: component.watermarkScope,
              refundsIncluded: false, amountBasis: venueDailyTurnoverSource.amountBasis };
          } catch (error) {
            if (!error || typeof error.code !== 'string' || !error.code.startsWith('payroll_venue_turnover_')) throw error;
            const component = { status: 'incomplete', reasons: [error.code], sourceWatermark: null,
              watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId: actor.venueId, currency: scheme.currency,
              period: { from: period.from, to: period.to } };
            components.venueDailyTurnover = component;
            attestations.venueDailyTurnover = component;
          }
        }
        if (requiredFacts.includes('approvedAttendance') && evidence.approvedAttendanceSource) {
          const { attendance, attendanceCoverage } = evidence.approvedAttendanceSource;
          calculatorInput.attendance = attendance;
          calculatorInput.attendanceCoverage = attendanceCoverage;
          components.approvedAttendance = { status: 'available', sourceWatermark: attendanceCoverage.watermark,
            watermarkScope: 'owner_approved_attendance_snapshot', venueId: actor.venueId, currency: scheme.currency,
            period: { from: period.from, to: period.to } };
        }
        if (evidence.employmentEligibilitySource?.revision) {
          const source = evidence.employmentEligibilitySource;
          components.employeeEligibility = { ...source.component, venueId: actor.venueId, currency: scheme.currency,
            period: { from: period.from, to: period.to } };
          calculatorInput.employmentEligibilityRevisionId = source.revision.id;
          calculatorInput.employees = buildEligibleEmployees(source.periods.map(({ employeeId, effectiveFrom, effectiveTo }) =>
            ({ employeeId, effectiveFrom, effectiveTo })), period.from, period.to);
        }
        calculatorInput.sales = structuredClone(evidence.calculatorSales || buildPayrollCalculatorSales({ currency: scheme.currency,
          recognitionManifest: evidence.recognitionManifest, recognitionProjection: evidence.recognitionProjection,
          departmentAttribution: evidence.departmentMappingSource, marginCostSource: evidence.marginCostSource }));
        const salesCoverageWatermark = createHash('sha256').update(canonicalJson({ schemaVersion: 1,
          venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to },
          recognitionWatermark: evidence.recognitionManifest.watermark,
          projectionWatermark: evidence.recognitionProjection.projectionWatermark || null,
          departmentWatermark: evidence.departmentMappingSource?.sourceWatermark || null,
          sales: calculatorInput.sales })).digest('hex');
        calculatorInput.coverage = { kind: 'month_to_date_complete', from: `${period.from.slice(0, 7)}-01`,
          through: period.to, complete: true, watermark: salesCoverageWatermark };
        calculatorInput.personalRevenueSource = buildPayrollPersonalRevenueSource({ venueId: actor.venueId,
          currency: scheme.currency, period, recognitionManifest: evidence.recognitionManifest,
          sourcePolicies: scheme.sourcePolicies, fullEmployeeNetRevenue: evidence.fullEmployeeNetRevenueSource,
          orderRevenueReconciliation });
        if (requiredFacts.includes('approvedAttendance') && !evidence.approvedAttendanceSource) {
          components.approvedAttendance = { status: evidence.readiness.components.approvedAttendance?.status || 'unsupported',
            reasons: evidence.readiness.components.approvedAttendance?.reasons || ['payroll_approved_attendance_unavailable'],
            sourceWatermark: evidence.readiness.components.approvedAttendance?.sourceWatermark || null,
            watermarkScope: evidence.readiness.components.approvedAttendance?.watermarkScope || 'owner_approved_attendance_snapshot',
            venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } };
        }
        calculationSourceBundle = {
          schemaVersion: 1, venueId: actor.venueId, schemeVersionId: scheme.versionId, currency: scheme.currency,
          period: { from: period.from, to: period.to },
          readinessWatermark: createHash('sha256').update(canonicalJson(evidence.readiness.components)).digest('hex'),
          components,
          recognizedLineProjection: {
            schemaVersion: 1,
            venueId: actor.venueId,
            currency: scheme.currency,
            period: { from: period.from, to: period.to },
            sourceWatermark: evidence.recognitionManifest.watermark,
            projectionWatermark: evidence.recognitionProjection.projectionWatermark || null,
            sourceStatus: evidence.recognitionProjection.sourceStatus,
            sourceReasons: evidence.recognitionProjection.sourceReasons,
            saleLines: structuredClone(evidence.recognitionProjection.saleLines),
            refundAdjustments: structuredClone(evidence.recognitionProjection.refundAdjustments)
          },
          ...(evidence.marginCostSource ? { marginCostSource: structuredClone(evidence.marginCostSource),
            marginCostEvidenceByOrder: structuredClone(evidence.marginCostEvidenceByOrder) } : {}),
          fullEmployeeNetRevenue: structuredClone(evidence.fullEmployeeNetRevenueSource),
          orderRevenueReconciliation: structuredClone(orderRevenueReconciliation),
          ...(venueDailyTurnoverSource ? { venueDailyTurnover: structuredClone(venueDailyTurnoverSource) } : {}),
          ...(evidence.departmentMappingSource ? { departmentAttribution: structuredClone(evidence.departmentMappingSource) } : {}),
          ...(evidence.teamFundEvidence ? { teamFundEvidence: structuredClone(evidence.teamFundEvidence) } : {}),
          recognitionManifest: evidence.recognitionManifest,
          ...(evidence.employmentEligibilitySource?.revision ? { employmentEligibility: evidence.employmentEligibilitySource } : {}),
          ...(evidence.approvedAttendanceSource?.sourceAttendanceApproval
            ? { sourceAttendanceApproval: structuredClone(evidence.approvedAttendanceSource.sourceAttendanceApproval) } : {}),
          // Carry only verified source evidence. Missing calculator collections remain absent so
          // neither an empty roster nor approved attendance can masquerade as a complete input.
          calculatorInput
        };
        calculationSourceBundle.inputWatermark = createHash('sha256').update(canonicalJson(calculationSourceBundle)).digest('hex');
      }
      return { evidence, attestations, calculationSourceBundle, periodClosure: {
        schemaVersion: 1, venueId: actor.venueId, period: { from: period.from, to: period.to },
        transactionTimestamp: periodClosureRow.transaction_timestamp, venueLocalDate: periodClosureRow.venue_local_date,
        timezone: periodClosureRow.timezone }, venueTimezone: evidence.readiness.period.timezone };
  };
  const assembleSourcedPreview = ({ actor, scheme, period, evidence, attestations, calculationSourceBundle, periodClosure }) => {
      const candidateCalculation = buildPayrollCandidateCalculation({ venueId: actor.venueId, scheme, period,
        readiness: evidence.readiness, attestations, sourceBundle: calculationSourceBundle });
      let candidateSnapshot = null, candidateSnapshotStatus = 'not_applicable';
      if (candidateCalculation.status === 'scenario_ready') {
        try {
          candidateSnapshot = buildPayrollCandidateSnapshotBundle({ venueId: actor.venueId, scheme, period,
            venueTimezone: evidence.readiness.period.timezone, sourceBundle: calculationSourceBundle, candidateCalculation });
          candidateSnapshotStatus = 'available';
        } catch (error) {
          if (error?.code !== 'payroll_candidate_snapshot_line_limit_exceeded') throw error;
          candidateSnapshotStatus = 'size_limited';
        }
      }
      return buildPayrollSourcedPreview({ venueId: actor.venueId, scheme, period,
        readiness: evidence.readiness, recognitionManifest: evidence.recognitionManifest, calculationSourceBundle, attestations,
        candidateCalculation, candidateSnapshot, candidateSnapshotStatus,
        periodClosure });
  };
  const buildSourcedPreviewForScheme = async (db, actor, scheme, period, sharedSources = undefined) => {
    const context = await collectSourcedPayrollContext(db, actor, scheme, period, sharedSources);
    return assembleSourcedPreview({ actor, scheme, period, ...context });
  };
  const prepareVerifiedSnapshotInput = async (principal, versionId, input) => {
    const expectedKeys = ['periodFrom', 'periodTo', 'runId'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(input, key))
        || Object.keys(input).some(key => !expectedKeys.includes(key))
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))
        || typeof input.runId !== 'string' || !UUID.test(input.runId) || input.runId !== input.runId.toLowerCase()) {
      fail('invalid_payroll_verified_snapshot_input_request');
    }
    const period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      const context = await collectSourcedPayrollContext(db, actor, scheme, period);
      return buildPayrollVerifiedSnapshotInput({ venueId: actor.venueId, runId: input.runId,
        venueTimezone: context.venueTimezone, scheme, period, readiness: context.evidence.readiness,
        attestations: context.attestations, sourceBundle: context.calculationSourceBundle,
        periodClosure: context.periodClosure });
    }, { sourceSnapshot: true });
  };
  // Source collection, calculation and storage share one locked
  // snapshot; no prepared object from a browser or another transaction is used.
  const createVerifiedRun = async (principal, input) => {
    const keys = ['schemeVersionId', 'periodFrom', 'periodTo', 'idempotencyKey'];
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Reflect.ownKeys(input).length !== keys.length
        || keys.some(key => !Object.hasOwn(input, key))
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
        || typeof input.schemeVersionId !== 'string' || !UUID.test(input.schemeVersionId)
        || typeof input.idempotencyKey !== 'string' || !/^[\x21-\x7e]{8,120}$/.test(input.idempotencyKey)) {
      fail('invalid_payroll_verified_run_request');
    }
    if (!principal || typeof principal.userId !== 'string' || typeof principal.venueId !== 'string'
        || !UUID.test(principal.userId) || !UUID.test(principal.venueId)) {
      fail('authenticated_owner_required', 403);
    }
    const owner = { userId: principal.userId.toLowerCase(), venueId: principal.venueId.toLowerCase() };
    const versionId = input.schemeVersionId.toLowerCase();
    const idempotencyKey = input.idempotencyKey;
    const period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    if (period.from.slice(0, 7) !== period.to.slice(0, 7)) fail('payroll_run_must_fit_one_month');
    const client = await pool.connect();
    let releaseSourceLock = null;
    let discardConnectionError = null;
    try {
      releaseSourceLock = await beginPayrollVerifiedRunSourceTransaction(client, owner.venueId);
      const actor = await assertOwner(client, owner, true);
      const venue = (await client.query('SELECT id,timezone FROM venues WHERE id=$1 FOR SHARE', [actor.venueId])).rows[0];
      if (!venue) fail('payroll_run_venue_unavailable', 403);
      const version = (await client.query(`SELECT status,effective_from::text,effective_to::text
        FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR SHARE`, [actor.venueId, versionId])).rows[0];
      if (!version || !['active', 'retired'].includes(version.status)) fail('payroll_run_version_not_available', 409);
      if (period.from < version.effective_from || (version.effective_to && period.to > version.effective_to)) {
        fail('payroll_run_outside_scheme_version', 409);
      }
      const existing = (await client.query(`SELECT id,scheme_version_id,period_from::text,period_to::text,
        status,engine_version,input_checksum FROM payroll_calculation_runs
        WHERE venue_id=$1 AND idempotency_key=$2 FOR SHARE`, [actor.venueId, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.scheme_version_id !== versionId || existing.period_from !== period.from
            || existing.period_to !== period.to || existing.status !== 'ready' || existing.engine_version !== VERIFIED_RUN_ENGINE) {
          fail('payroll_run_idempotency_conflict', 409);
        }
        const evidence = (await client.query(`SELECT capability_version,evidence_payload,evidence_sha256,total_amount_cents
          FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2`, [actor.venueId, existing.id])).rows[0];
        if (!evidence || evidence.evidence_sha256 !== existing.input_checksum
            || createHash('sha256').update(evidence.evidence_payload).digest('hex') !== existing.input_checksum
            || evidence.capability_version !== 'employee_attributed_merchandise_net_no_refund_v1'
            || !Number.isSafeInteger(Number(evidence.total_amount_cents))) fail('payroll_run_evidence_invalid', 409);
        try {
          const payload = JSON.parse(evidence.evidence_payload);
          if (Object.hasOwn(payload, 'calculatorReplay')) {
            if (!payload.calculatorReplay) fail('payroll_run_evidence_invalid', 409);
            validateCalculatorReplay(payload.calculatorReplay, { schemeSnapshot: payload.schemeSnapshot,
              sourceEvidence: payload.sourceEvidence, period: payload.period, currency: payload.currency });
            const amounts = payload.calculatorReplay.result.employees.map(row => row.amountCents);
            if (amounts.some(amount => !Number.isSafeInteger(amount) || amount < 0)
                || amounts.reduce((sum, amount) => sum + BigInt(amount), 0n) !== BigInt(evidence.total_amount_cents)) {
              fail('payroll_run_evidence_invalid', 409);
            }
          }
        } catch (_) { fail('payroll_run_evidence_invalid', 409); }
        await client.query('COMMIT');
        return { status: 'ready', runId: existing.id, amountCents: Number(evidence.total_amount_cents),
          capabilityVersion: evidence.capability_version, replayed: true, officialReady: false,
          payoutEligible: false, persistence: 'snapshots' };
      }
      const scheme = await loadVersion(client, actor.venueId, versionId);
      const context = await collectSourcedPayrollContext(client, actor, scheme, period);
      if (context.venueTimezone !== venue.timezone) fail('payroll_run_timezone_mismatch', 409);
      const runId = randomUUID();
      const evidence = buildPayrollRunProvenance({ venueId: actor.venueId, runId,
        venueTimezone: context.venueTimezone, scheme, period, readiness: context.evidence.readiness,
        attestations: context.attestations, sourceBundle: context.calculationSourceBundle, periodClosure: context.periodClosure });
      if (evidence.status !== 'verified_run_evidence') {
        await client.query('COMMIT');
        return { status: 'blocked', reasons: [...evidence.reasons], replayed: false,
          officialReady: false, payoutEligible: false, persistence: 'none' };
      }
      const run = { id: runId, venue_id: actor.venueId, scheme_version_id: versionId,
        period_from: period.from, period_to: period.to, status: 'ready', source_coverage: 'complete',
        commission_basis: 'net_after_discounts_refunds', eligible_line_count: evidence.prepared.mappedRows.snapshotLines.length,
        unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: evidence.prepared.sourceWatermark,
        input_checksum: evidence.provenance.evidence_sha256, engine_version: VERIFIED_RUN_ENGINE, blocked_reason: null,
        idempotency_key: idempotencyKey, created_by: actor.userId, created_by_name: actor.name,
        venue_timezone: context.venueTimezone, currency: scheme.currency };
      await persistPayrollSnapshotBundleInTransaction(client, {
        run, input: evidence.prepared.snapshotInput, provenance: evidence.provenance
      });
      await client.query('COMMIT');
      return { status: 'ready', runId, amountCents: evidence.provenance.total_amount_cents,
        capabilityVersion: evidence.provenance.capability_version, replayed: false,
        officialReady: false, payoutEligible: false, persistence: 'snapshots' };
    } catch (error) {
      if (error?.discardPayrollConnection) discardConnectionError = error;
      await client.query('ROLLBACK').catch(cleanupError => { discardConnectionError = cleanupError; });
      if (error instanceof PayrollSchemeServiceError) throw error;
      if (error?.code === '23505') fail('payroll_run_idempotency_conflict', 409);
      if (['40001', '40P01'].includes(error?.code)) fail('payroll_run_retry_required', 409);
      if (['42P01', '42703'].includes(error?.code) || String(error?.code || '').startsWith('payroll_snapshot_persistence_schema')) {
        fail('payroll_run_schema_required', 409);
      }
      throw error;
    } finally {
      try {
        if (releaseSourceLock) await releaseSourceLock();
      } catch (error) {
        discardConnectionError = error;
        throw error;
      } finally {
        client.release(discardConnectionError || undefined);
      }
    }
  };
  const previewSourced = async (principal, versionId, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'periodFrom') || !Object.hasOwn(input, 'periodTo')
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
      fail('invalid_payroll_sourced_preview_request');
    }
    const period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      return buildSourcedPreviewForScheme(db, actor, scheme, period);
    }, { sourceSnapshot: true });
  };
  const compareSourced = async (principal, input) => {
    const expectedKeys = ['baselineVersionId', 'periodFrom', 'periodTo', 'versionIds'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(input, key))
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
      fail('invalid_payroll_sourced_comparison_request');
    }
    const { versionIds, baselineVersionId } = input;
    if (!Array.isArray(versionIds) || versionIds.length < 2 || versionIds.length > 8
        || new Set(versionIds).size !== versionIds.length) fail('comparison_versions_required');
    if (versionIds.some(versionId => typeof versionId !== 'string' || !UUID.test(versionId))
        || typeof baselineVersionId !== 'string' || !UUID.test(baselineVersionId)) fail('invalid_payroll_scheme_version_id');
    if (!versionIds.includes(baselineVersionId)) fail('comparison_baseline_required');
    const period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    return withOwnerRead(pool, principal, async (db, actor) => {
      const schemes = [];
      for (const versionId of versionIds) schemes.push(await loadVersion(db, actor.venueId, versionId));
      if (new Set(schemes.map(scheme => scheme.currency)).size !== 1) fail('comparison_currency_mismatch', 409);
      for (const scheme of schemes) {
        if (period.from < scheme.effectiveFrom || (scheme.effectiveTo && period.to > scheme.effectiveTo)) {
          fail('comparison_period_outside_scheme_effective_window', 409);
        }
      }
      if (schemes.some(scheme => scheme.sourcePolicies?.schemaVersion === 2)) {
        const legacyPreviewsByVersionId = Object.create(null);
        return collectPayrollRefundAwareComparisonInTransaction(db, actor, schemes, period, attendanceManifest,
          { baselineVersionId, legacyPreviewsByVersionId, onSharedSources: async sharedSources => {
            for (const scheme of schemes) if (scheme.sourcePolicies?.schemaVersion !== 2) {
              legacyPreviewsByVersionId[scheme.versionId] = await buildSourcedPreviewForScheme(db, actor, scheme, period,
                sharedSources);
            }
          } });
      }
      const sourced = [];
      for (const scheme of schemes) sourced.push(await buildSourcedPreviewForScheme(db, actor, scheme, period));
      return buildPayrollSourcedComparison({ venueId: actor.venueId, currency: schemes[0].currency, period,
        baselineVersionId, versions: schemes, previews: sourced });
    }, { sourceSnapshot: true });
  };

  const listSchemes = async (principal) => {
    return withOwnerRead(pool, principal, async (db, actor) => {
      const result = await db.query(`SELECT s.id,s.name,s.description,s.created_at AS "createdAt",
        COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'versionNo',v.version_no,'mode',v.mode,'status',v.status,
          'payoutRiskAcknowledgement',v.config_json->'payoutRiskAcknowledgement',
          'effectiveFrom',v.effective_from,'effectiveTo',v.effective_to) ORDER BY v.version_no DESC)
          FILTER (WHERE v.id IS NOT NULL),'[]'::jsonb) AS versions
      FROM payroll_schemes s LEFT JOIN payroll_scheme_versions v ON v.venue_id=s.venue_id AND v.scheme_id=s.id
      WHERE s.venue_id=$1 GROUP BY s.id ORDER BY s.created_at DESC,s.id`, [actor.venueId]);
      return result.rows;
    });
  };

  const getVersion = async (principal, versionId) => {
    return withOwnerRead(pool, principal, (db, actor) => loadVersion(db, actor.venueId, versionId));
  };

  const listVersionRevisions = async (principal, versionId) => withOwnerRead(pool, principal, async (db, actor) => {
    const version = await db.query('SELECT 1 FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2', [actor.venueId, versionId]);
    if (!version.rows[0]) fail('payroll_scheme_version_not_found', 404);
    const revisions = await db.query(`SELECT revision_no AS "revisionNo",change_kind AS "changeKind",
        config_snapshot_json AS snapshot,changed_by AS "changedBy",changed_by_name AS "changedByName",changed_at AS "changedAt"
      FROM payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY revision_no`, [actor.venueId, versionId]);
    return revisions.rows;
  });

  const preview = async (principal, versionId, previewInput = {}) => {
    if (!previewInput || typeof previewInput !== 'object' || Array.isArray(previewInput)) fail('preview_input_required');
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      assertPreviewSize(previewInput, scheme);
      const result = calculateScenario(scheme, previewInput);
      return { official: false, persistence: 'none', scenario: true, scheme, result };
    });
  };

  const previewWithApprovedAttendance = async (principal, versionId, previewInput = {}) => {
    if (!previewInput || typeof previewInput !== 'object' || Array.isArray(previewInput)) fail('preview_input_required');
    const periodFrom = String(previewInput.periodFrom || '');
    const periodTo = String(previewInput.periodTo || '');
    const month = periodFrom.slice(0, 7);
    const isDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!isDate(periodFrom) || !isDate(periodTo) || periodFrom > periodTo || periodTo.slice(0, 7) !== month) {
      fail('invalid_single_month_period');
    }
    const attendancePeriod = { periodFrom: `${month}-01`, periodTo };
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      let attendanceSource;
      try {
        attendanceSource = await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db, principal, attendancePeriod);
      } catch (error) {
        const codes = {
          payroll_attendance_source_incomplete: 'payroll_preview_attendance_source_incomplete',
          payroll_attendance_approval_required: 'payroll_preview_attendance_approval_required',
          payroll_attendance_approval_stale: 'payroll_preview_attendance_approval_stale'
        };
        if (Object.hasOwn(codes, error?.code)) fail(codes[error.code], 409);
        throw error;
      }
      const scenarioInput = {
        ...previewInput,
        attendance: attendanceSource.attendance,
        attendanceCoverage: attendanceSource.attendanceCoverage
      };
      assertPreviewSize(scenarioInput, scheme);
      const result = calculateScenario(scheme, scenarioInput);
      return {
        official: false,
        persistence: 'none',
        scenario: true,
        sourceAttendanceApproval: attendanceSource.sourceAttendanceApproval,
        attendanceContext: attendanceSource.attendanceContext,
        scheme,
        result
      };
    });
  };

  const previewWithVenueDailyTurnover = async (principal, versionId, previewInput = {}) => {
    if (!previewInput || typeof previewInput !== 'object' || Array.isArray(previewInput)) fail('preview_input_required');
    return withOwnerRead(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      const venueTurnover = await makePayrollVenueTurnoverSource(db).getVenueDailyTurnover(actor, {
        from: previewInput.coverage?.from,
        through: previewInput.coverage?.through
      });
      const scenarioInput = { ...previewInput, venueDailyTurnover: venueTurnover.venueDailyTurnover };
      assertPreviewSize(scenarioInput, scheme);
      const result = calculateScenario(scheme, scenarioInput);
      return {
        official: false,
        persistence: 'none',
        scenario: true,
        sourceVenueTurnover: venueTurnover,
        scheme,
        result
      };
    });
  };

  const compare = async (principal, versionIds, previewInput = {}, baselineVersionId) => {
    if (!Array.isArray(versionIds) || versionIds.length < 2 || versionIds.length > 8 || new Set(versionIds).size !== versionIds.length) fail('comparison_versions_required');
    if (versionIds.some((versionId) => typeof versionId !== 'string' || !UUID.test(versionId))
        || typeof baselineVersionId !== 'string' || !UUID.test(baselineVersionId)) {
      fail('invalid_payroll_scheme_version_id');
    }
    if (!previewInput || typeof previewInput !== 'object' || Array.isArray(previewInput)) fail('preview_input_required');
    if (!versionIds.includes(baselineVersionId)) fail('comparison_baseline_required');
    return withOwnerRead(pool, principal, async (db, actor) => {
      const orderedIds = [...versionIds].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      const schemes = await Promise.all(orderedIds.map((id) => loadVersion(db, actor.venueId, id)));
      if (new Set(schemes.map((scheme) => scheme.currency)).size > 1) fail('comparison_currency_mismatch', 400);
      for (const scheme of schemes) assertPreviewSize(previewInput, scheme);
      const results = schemes.map((scheme) => ({ scheme, result: calculateScenario(scheme, previewInput) }));
      const baseline = results.find((item) => item.scheme.versionId === baselineVersionId);
      const baselineAmounts = new Map((baseline?.result.employees || []).map((item) => [item.employeeId, item.amountCents]));
      const employeeIds = [...new Set(results.flatMap((item) => item.result.employees.map((employee) => employee.employeeId)))].sort();
      const comparisons = results.map(({ scheme, result }) => {
        const amounts = new Map(result.employees.map((item) => [item.employeeId, item.amountCents]));
        const values = employeeIds.map((employeeId) => amounts.get(employeeId) || 0);
        const totalCents = result.status === 'ready' ? sumCentsSafely(values) : null;
        const deltas = employeeIds.map((employeeId) => ({ employeeId, amountCents: amounts.get(employeeId) || 0,
          deltaCents: (amounts.get(employeeId) || 0) - (baselineAmounts.get(employeeId) || 0) }));
        const deltaToBaselineCents = result.status !== 'ready' || baseline?.result.status !== 'ready' ? null
          : sumCentsSafely(deltas.map((item) => item.deltaCents));
        const aggregateOverflow = totalCents === null && result.status === 'ready'
          || deltaToBaselineCents === null && result.status === 'ready' && baseline?.result.status === 'ready';
        return {
          versionId: scheme.versionId,
          schemeId: scheme.id,
          status: result.status,
          aggregateBlocker: aggregateOverflow ? 'amount_exceeds_safe_integer_cents' : null,
          totalCents,
          deltaToBaselineCents,
          employeeDeltas: result.status !== 'ready' || baseline?.result.status !== 'ready' ? [] : deltas
        };
      });
      return { official: false, persistence: 'none', scenario: true, currency: schemes[0].currency, baselineVersionId, comparisons, results };
    });
  };

  const insertVersion = async (db, actor, schemeId, versionNo, rawDefinition, acknowledgement) => {
    const versionId = randomUUID();
    const definition = ensureDefinition(rawDefinition, schemeId, versionId);
    await requireMilestoneConfigurationSchema(db, definition);
    await requirePersonalDepartmentConfigurationSchema(db, definition);
    const payoutRiskAcknowledgement = await recordPayoutRiskAcknowledgement(db, actor, definition, acknowledgement);
    const configJson = JSON.stringify({ roleParameters: definition.roleParameters, applyMilestones: definition.applyMilestones,
      milestoneEligibility: definition.milestoneEligibility, milestoneCapPolicy: definition.milestoneCapPolicy, sourcePolicies: definition.sourcePolicies, payoutRiskAcknowledgement });
    await db.query(`INSERT INTO payroll_scheme_versions
      (id,venue_id,scheme_id,version_no,mode,currency,effective_from,effective_to,config_json,created_by,created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [versionId, actor.venueId, schemeId, versionNo, definition.mode, definition.currency, definition.effectiveFrom,
      definition.effectiveTo, configJson, actor.userId, actor.name]);
    await persistChildren(db, actor, versionId, definition);
    const scheme = await loadVersion(db, actor.venueId, versionId);
    await recordRevision(db, actor, scheme, 'created');
    return scheme;
  };

  const createScheme = async (principal, input = {}) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const name = cleanText(input.name, 120, 'invalid_scheme_name');
    const description = input.description === undefined ? '' : String(input.description).trim();
    if (description.length > 2000) fail('invalid_scheme_description');
    const schemeId = randomUUID();
    await db.query(`INSERT INTO payroll_schemes (id,venue_id,name,description,created_by,created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6)`, [schemeId, actor.venueId, name, description, actor.userId, actor.name]);
    const version = await insertVersion(db, actor, schemeId, 1, input.definition, input.payoutRiskAcknowledgement);
    return { id: schemeId, name, description, versions: [version] };
  });

  const createVersion = async (principal, schemeId, definitionInput, acknowledgement) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const scheme = await db.query('SELECT id FROM payroll_schemes WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, schemeId]);
    if (!scheme.rows[0]) fail('payroll_scheme_not_found', 404);
    const version = await db.query('SELECT COALESCE(MAX(version_no),0)::int+1 AS next_no FROM payroll_scheme_versions WHERE venue_id=$1 AND scheme_id=$2', [actor.venueId, schemeId]);
    return insertVersion(db, actor, schemeId, version.rows[0].next_no, definitionInput, acknowledgement);
  });

  const replaceDraftVersion = async (principal, versionId, definitionInput, acknowledgement) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const current = await db.query('SELECT id,scheme_id,status FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, versionId]);
    if (!current.rows[0]) fail('payroll_scheme_version_not_found', 404);
    if (current.rows[0].status !== 'draft') fail('payroll_scheme_version_immutable', 409);
    const definition = ensureDefinition(definitionInput, current.rows[0].scheme_id, versionId);
    await requireMilestoneConfigurationSchema(db, definition);
    await requirePersonalDepartmentConfigurationSchema(db, definition);
    const payoutRiskAcknowledgement = await recordPayoutRiskAcknowledgement(db, actor, definition, acknowledgement);
    for (const table of ['payroll_role_assignments', 'payroll_employee_overrides', 'payroll_item_commission_rules']) {
      await db.query(`DELETE FROM ${table} WHERE venue_id=$1 AND scheme_version_id=$2`, [actor.venueId, versionId]);
    }
    await db.query(`UPDATE payroll_scheme_versions SET mode=$3,currency=$4,effective_from=$5,effective_to=$6,
      config_json=$7::jsonb WHERE venue_id=$1 AND id=$2`, [actor.venueId, versionId, definition.mode, definition.currency,
      definition.effectiveFrom, definition.effectiveTo, JSON.stringify({ roleParameters: definition.roleParameters, applyMilestones: definition.applyMilestones,
      milestoneEligibility: definition.milestoneEligibility, milestoneCapPolicy: definition.milestoneCapPolicy, sourcePolicies: definition.sourcePolicies, payoutRiskAcknowledgement })]);
    await persistChildren(db, actor, versionId, definition);
    const scheme = await loadVersion(db, actor.venueId, versionId);
    await recordRevision(db, actor, scheme, 'edited');
    return scheme;
  });

  const activateVersion = async (principal, versionId) => withOwnerTransaction(pool, principal, async (db, actor) => {
    await db.query('SELECT id FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, versionId]);
    const current = await loadVersion(db, actor.venueId, versionId);
    if (current.status !== 'draft') fail('payroll_scheme_version_not_draft', 409);
    if (!current.payoutRiskAcknowledgement?.configDigest) fail('payroll_risk_acknowledgement_required', 409);
    const definition = ensureDefinition(current, current.id, current.versionId);
    await requireMilestoneConfigurationSchema(db, definition);
    await requirePersonalDepartmentConfigurationSchema(db, definition);
    if (current.payoutRiskAcknowledgement.policyCode !== PAYOUT_RISK_ACK_POLICY
        || current.payoutRiskAcknowledgement.configDigest !== payoutConfigurationDigest(definition)) {
      fail('payroll_risk_acknowledgement_required', 409);
    }
    const exceptions = personalCapExceptions(definition, 409);
    if (exceptions.length) {
      const parent = current.payoutRiskAcknowledgement, child = parent.personalCapIncrease;
      if (!child || child.policyCode !== PERSONAL_CAP_ACK_POLICY || child.configDigest !== payoutConfigurationDigest(definition)
        || !Array.isArray(child.exceptions) || canonicalJson(child.exceptions) !== canonicalJson(exceptions)
        || typeof child.acknowledgedBy !== 'string' || !UUID.test(child.acknowledgedBy)
        || child.acknowledgedBy !== parent.acknowledgedBy || typeof child.acknowledgedByName !== 'string'
        || !child.acknowledgedByName.trim() || child.acknowledgedByName !== parent.acknowledgedByName
        || typeof child.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(child.acknowledgedAt))
        || child.acknowledgedAt !== parent.acknowledgedAt) {
        fail('payroll_personal_cap_increase_acknowledgement_required', 409);
      }
    }
    const result = await db.query(`UPDATE payroll_scheme_versions SET status='active',status_changed_by=$3,
      status_changed_by_name=$4,status_changed_at=now() WHERE venue_id=$1 AND id=$2 AND status='draft' RETURNING id`,
    [actor.venueId, versionId, actor.userId, actor.name]);
    if (!result.rows[0]) fail('payroll_scheme_version_not_draft', 409);
    const scheme = await loadVersion(db, actor.venueId, versionId);
    await recordRevision(db, actor, scheme, 'activated');
    return scheme;
  });

  const createRefundReview = async (principal, runId, input) => {
    runId = reviewRequest(runId, input);
    return withOwnerSourceWrite(pool, principal, async (db, actor) => {
      const replay = await refundReviewStore.readRefundReviewAssessmentReplay(db, actor, runId, input);
      if (replay) return replay;
      const assessment = await collectPayrollRefundReviewAssessment(db, actor, runId);
      return refundReviewStore.saveRefundReviewAssessment(db, actor, assessment, input);
    });
  };
  const decideRefundReview = async (principal, caseId, input) => {
    caseId = reviewRequest(caseId, input, true);
    return withOwnerSourceWrite(pool, principal, async (db, actor) => {
      // A lost-response retry returns its immutable outcome even if a later
      // refund arrived. A new request must assess current sources again.
      const replay = await refundReviewStore.readRefundReviewDecisionReplay(db, actor, caseId, input);
      if (replay) return replay;
      const saved = await refundReviewStore.getRefundReview(db, actor, caseId);
      const assessment = await collectPayrollRefundReviewAssessment(db, actor, saved.runId);
      return refundReviewStore.saveRefundReviewDecision(db, actor, caseId, assessment, input);
    });
  };
  const lifecycleServiceError = (error) => {
    if (error instanceof PayrollSchemeServiceError) throw error;
    if (typeof error?.code === 'string' && /^payroll_[a-z0-9_]{1,100}$/.test(error.code)) throw error;
    fail('payroll_entry_lifecycle_unavailable', 503);
  };
  const lifecycleFreshness = (db, actor, runId) =>
    checkPayrollRunSourceFreshnessInTransaction(db, actor, runId, collectSourcedPayrollContext,
      (client, owner, scheme, period) => readPayrollRefundAwareSourceArgsInTransaction(client, owner, scheme, period, attendanceManifest));
  const getCalculationEntryState = async (principal, entryId) => {
    try {
      return await withOwnerSourceWrite(pool, principal, (db, actor) =>
        calculationEntryLifecycle.getPayrollCalculationEntryState(db, actor, entryId,
          (client, owner, runId) => lifecycleFreshness(client, owner, runId)), 'payroll_entry_lifecycle');
    } catch (error) { lifecycleServiceError(error); }
  };
  const transitionCalculationEntry = async (principal, entryId, input) => {
    try {
      return await withOwnerSourceWrite(pool, principal, (db, actor) =>
        calculationEntryLifecycle.transitionPayrollCalculationEntry(db, actor, entryId, input,
          (client, owner, runId) => lifecycleFreshness(client, owner, runId)), 'payroll_entry_lifecycle');
    } catch (error) { lifecycleServiceError(error); }
  };
  const withReviewedCorrection = async (principal, callback) => {
    try { return await withOwnerSourceWrite(pool, principal, callback, 'payroll_correction'); }
    catch (error) {
      if (error instanceof PayrollSchemeServiceError
          || (typeof error?.code === 'string' && /^payroll_[a-z0-9_]{1,100}$/.test(error.code))) throw error;
      fail('payroll_correction_unavailable', 503);
    }
  };
  const getReviewedCorrectionContext = (principal, originalEntryId) => {
    if (typeof originalEntryId !== 'string' || !UUID.test(originalEntryId)) fail('payroll_correction_entry_invalid');
    return withReviewedCorrection(principal, (db, actor) =>
      reviewedCorrectionStore.readReviewedCorrectionContext(db, actor, originalEntryId.toLowerCase()));
  };
  const previewReviewedCorrection = (principal, input) => {
    const request = normalizeReviewedCorrectionPreview(input);
    return withReviewedCorrection(principal, (db, actor) =>
      reviewedCorrectionStore.previewReviewedCorrection(db, actor, request, lifecycleFreshness));
  };
  const applyReviewedCorrection = (principal, input) => {
    const request = normalizeReviewedCorrectionCommand(input);
    return withReviewedCorrection(principal, (db, actor) =>
      reviewedCorrectionStore.applyReviewedCorrection(db, actor, request, lifecycleFreshness));
  };
  // Unrouted preparation: no run, entry, expense or browser-provided source DTO.
  const withRefundAwareSources = async (principal, versionId, input, prepare) => {
    if (!UUID.test(versionId || '') || !input || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).sort().join(',') !== 'periodFrom,periodTo'
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) fail('payroll_refund_aware_request_invalid');
    const period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    return withOwnerSourceWrite(pool, principal, async (db, actor) => {
      const scheme = await loadVersion(db, actor.venueId, versionId);
      if (!['active', 'retired'].includes(scheme.status)) fail('payroll_run_scheme_not_active', 409);
      if (scheme.effectiveFrom > period.from || (scheme.effectiveTo && scheme.effectiveTo < period.to)) fail('payroll_run_scheme_period_outside_version', 409);
      return prepare(db, actor, scheme, period);
    }, 'payroll_refund_aware');
  };
  const prepareRefundAwareCalculation = (principal, versionId, input) => withRefundAwareSources(principal, versionId, input,
    (db, actor, scheme, period) => collectPayrollRefundAwareCalculationInTransaction(db, actor, scheme, period, attendanceManifest));
  const prepareRefundAwareRunEvidence = (principal, versionId, input) => withRefundAwareSources(principal, versionId, input,
    async (db, actor, scheme, period) => {
      const collected = await readPayrollRefundAwareSourceArgsInTransaction(db, actor, scheme, period, attendanceManifest);
      return collected.status === 'source_arguments_collected'
        ? buildPayrollRefundAwareRunProvenance({ ...collected.sourceArgs, runId: randomUUID() }) : collected;
    });
  // Explicit v2 writer; its separate endpoint never upgrades a legacy scheme.
  // Run creation stores evidence only. Entry approval/payment are separate
  // source-verified lifecycle operations with immutable settlement receipts.
  const createRefundAwareRun = async (principal, input) => {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Reflect.ownKeys(input).length !== 4 || Object.keys(input).sort().join(',') !== 'idempotencyKey,periodFrom,periodTo,schemeVersionId'
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
        || !UUID.test(input.schemeVersionId || '') || typeof input.idempotencyKey !== 'string'
        || !/^[\x21-\x7e]{8,120}$/.test(input.idempotencyKey)) fail('payroll_refund_aware_request_invalid');
    const versionId = input.schemeVersionId.toLowerCase(), period = parsePayrollReadinessPeriod({ from: input.periodFrom, to: input.periodTo });
    return withOwnerSourceWrite(pool, principal, async (db, actor) => {
      const venue = (await db.query('SELECT timezone FROM venues WHERE id=$1 FOR SHARE', [actor.venueId])).rows[0];
      const version = (await db.query(`SELECT status,effective_from::text,effective_to::text FROM payroll_scheme_versions
        WHERE venue_id=$1 AND id=$2 FOR SHARE`, [actor.venueId, versionId])).rows[0];
      if (!venue || !version || !['active','retired'].includes(version.status)) fail('payroll_run_version_not_available', 409);
      if (period.from < version.effective_from || (version.effective_to && period.to > version.effective_to)) fail('payroll_run_outside_scheme_version', 409);
      const prior = (await db.query(`SELECT r.id,r.scheme_version_id,r.period_from::text,r.period_to::text,r.status,r.engine_version,
        r.input_checksum,p.evidence_payload,p.evidence_sha256 FROM payroll_calculation_runs r LEFT JOIN payroll_run_provenance p
        ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.idempotency_key=$2`, [actor.venueId,input.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.engine_version !== REFUND_RUN_ENGINE || prior.status !== 'ready' || prior.scheme_version_id !== versionId
            || prior.period_from !== period.from || prior.period_to !== period.to) fail('payroll_run_idempotency_conflict', 409);
        if (typeof prior.evidence_payload !== 'string' || prior.input_checksum !== prior.evidence_sha256
            || createHash('sha256').update(prior.evidence_payload).digest('hex') !== prior.evidence_sha256) fail('payroll_run_evidence_invalid', 409);
        const rebuilt = rebuildPayrollRefundAwareRunProvenance(JSON.parse(prior.evidence_payload));
        if (rebuilt.provenance.run_id !== prior.id || rebuilt.provenance.venue_id !== actor.venueId
            || rebuilt.prepared.verifiedCalculation.schemeVersionId !== versionId) fail('payroll_run_evidence_invalid', 409);
        return { status: 'ready', runId: prior.id, amountCents: rebuilt.provenance.total_amount_cents,
          capabilityVersion: rebuilt.provenance.capability_version, replayed: true, officialReady: false, payoutEligible: false, persistence: 'snapshots' };
      }
      const scheme = await loadVersion(db, actor.venueId, versionId);
      const collected = await readPayrollRefundAwareSourceArgsInTransaction(db, actor, scheme, period, attendanceManifest);
      if (collected.status !== 'source_arguments_collected') return collected;
      if (collected.sourceArgs.periodClosure.timezone !== venue.timezone) fail('payroll_run_timezone_mismatch', 409);
      const runId = randomUUID(), evidence = buildPayrollRefundAwareRunProvenance({ ...collected.sourceArgs, runId });
      if (evidence.status !== 'verified_run_evidence') return evidence;
      const run = { id: runId, venue_id: actor.venueId, scheme_version_id: versionId, period_from: period.from, period_to: period.to,
        status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds',
        eligible_line_count: evidence.prepared.mappedRows.snapshotLines.length, unattributed_line_count: 0, missing_net_line_count: 0,
        input_watermark: evidence.prepared.sourceWatermark, input_checksum: evidence.provenance.evidence_sha256,
        engine_version: REFUND_RUN_ENGINE, blocked_reason: null, idempotency_key: input.idempotencyKey,
        created_by: actor.userId, created_by_name: actor.name, venue_timezone: venue.timezone, currency: scheme.currency };
      await persistPayrollSnapshotBundleInTransaction(db, { run, input: evidence.prepared.snapshotInput, provenance: evidence.provenance });
      return { status: 'ready', runId, amountCents: evidence.provenance.total_amount_cents,
        capabilityVersion: evidence.provenance.capability_version, replayed: false, officialReady: false, payoutEligible: false, persistence: 'snapshots' };
    }, 'payroll_refund_aware');
  };
  const supersessionCallbacks = {
    checkFreshness: lifecycleFreshness,
    buildReplacement: async (db, actor, saved, runId) => {
      const scheme = structuredClone(saved.evidence.schemeSnapshot), period = { ...saved.evidence.period };
      const collected = await readPayrollRefundAwareSourceArgsInTransaction(db, actor, scheme, period, attendanceManifest);
      if (collected.status !== 'source_arguments_collected') fail('payroll_supersession_sources_blocked', 409);
      const built = buildPayrollRefundAwareRunProvenance({ ...collected.sourceArgs, runId });
      if (built.status !== 'verified_run_evidence') fail('payroll_supersession_sources_blocked', 409);
      const run = { id: runId, venue_id: actor.venueId, scheme_version_id: scheme.versionId, period_from: period.from, period_to: period.to,
        status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds',
        eligible_line_count: built.prepared.mappedRows.snapshotLines.length, unattributed_line_count: 0, missing_net_line_count: 0,
        input_watermark: built.prepared.sourceWatermark, input_checksum: built.provenance.evidence_sha256,
        engine_version: REFUND_RUN_ENGINE, blocked_reason: null, idempotency_key: `supersession-run:${runId}`,
        supersedes_run_id: saved.header.runId,
        created_by: actor.userId, created_by_name: actor.name, venue_timezone: collected.sourceArgs.periodClosure.timezone,
        currency: scheme.currency };
      return { run, input: built.prepared.snapshotInput, provenance: built.provenance };
    }
  };
  const previewUnpaidRunSupersession = (principal, runId) => withOwnerSourceWrite(pool, principal, (db, actor) =>
    require('./payroll-unpaid-run-supersession').previewUnpaidRunSupersession(db, actor, runId, supersessionCallbacks), 'payroll_supersession');
  const commitUnpaidRunSupersession = (principal, runId, input) => withOwnerSourceWrite(pool, principal, (db, actor) =>
    require('./payroll-unpaid-run-supersession').commitUnpaidRunSupersession(db, actor, runId, input, supersessionCallbacks), 'payroll_supersession');
  const getRefundAwareCorrectionContext = (principal, originalEntryId) => {
    if (typeof originalEntryId !== 'string' || !UUID.test(originalEntryId)) fail('payroll_correction_entry_invalid');
    return withReviewedCorrection(principal, (db, actor) =>
      require('./payroll-refund-aware-correction-store').readRefundAwareCorrectionContext(db, actor, originalEntryId.toLowerCase()));
  };
  const previewRefundAwareCorrection = (principal, input) => {
    const request = normalizeReviewedCorrectionPreview(input);
    return withReviewedCorrection(principal, (db, actor) =>
      require('./payroll-refund-aware-correction-store').previewRefundAwareCorrection(db, actor, request, lifecycleFreshness));
  };
  const applyRefundAwareCorrection = (principal, input) => {
    const request = normalizeReviewedCorrectionCommand(input);
    return withReviewedCorrection(principal, (db, actor) =>
      require('./payroll-refund-aware-correction-store').applyRefundAwareCorrection(db, actor, request, lifecycleFreshness));
  };
  return { listSchemes, getVersion, listVersionRevisions, createScheme, createVersion, replaceDraftVersion, activateVersion,
    previewUnpaidRunSupersession, commitUnpaidRunSupersession,
    getRefundAwareCorrectionContext, previewRefundAwareCorrection, applyRefundAwareCorrection,
    prepareRefundAwareCalculation,
    prepareRefundAwareRunEvidence,
    createRefundAwareRun,
    createRefundReview, decideRefundReview,
    getReviewedCorrectionContext, previewReviewedCorrection, applyReviewedCorrection,
    getCalculationEntryState, transitionCalculationEntry,
    materializeCalculationEntry: (principal, runId, input) => {
      const request = calculationEntryBridge.normalizeEntryMaterialization(runId, input);
      return withOwnerSourceWrite(pool, principal, (db, actor) => calculationEntryBridge.materializeCalculationEntry(db, actor, request,
        lifecycleFreshness), 'payroll_entry_materialization');
    },
    listCalculationEntries: (principal, runId) => withOwnerRead(pool, principal,
      (db, actor) => calculationEntryBridge.listCalculationEntries(db, actor, runId)),
    listRefundReviews: (principal, query) => withOwnerRead(pool, principal, (db, actor) => refundReviewStore.listRefundReviews(db, actor, query)),
    getRefundReview: (principal, caseId) => withOwnerRead(pool, principal, (db, actor) => refundReviewStore.getRefundReview(db, actor, caseId)),
    listSavedRuns: (principal, query) => withOwnerRead(pool, principal, (db, actor) => savedRunReader.listSavedRuns(db, actor.venueId, query)),
    replaySavedRun: (principal, runId) => withOwnerRead(pool, principal, (db, actor) => savedRunReader.replaySavedRun(db, actor.venueId, runId)),
    checkSavedRunFreshness: (principal, runId) => withOwnerRead(pool, principal,
      (db, actor) => lifecycleFreshness(db, actor, runId), { sourceSnapshot: true }),
    getSavedRun: (principal, runId, query) => withOwnerRead(pool, principal, (db, actor) => savedRunReader.getSavedRun(db, actor.venueId, runId, query)),
    getSavedRunEmployee: (principal, runId, employeeId) => withOwnerRead(pool, principal, (db, actor) => savedRunReader.getSavedRunEmployee(db, actor.venueId, runId, employeeId)),
    getSavedRunLines: (principal, runId, snapshotId, query) => withOwnerRead(pool, principal, (db, actor) => savedRunReader.getSavedRunLines(db, actor.venueId, runId, snapshotId, query)),
    listEmploymentEligibilityEmployees,
    getEmploymentEligibilityHistory, createEmploymentEligibilityRevision,
    getProductDepartmentMappings, getProductDepartmentRevision, writeProductDepartmentRevision,
    preview, previewWithApprovedAttendance, previewWithVenueDailyTurnover, previewSourced, compareSourced, compare, getSourceReadiness,
    prepareVerifiedSnapshotInput, createVerifiedRun,
    getEntryOverlapDiagnostic,
    readAttendanceCoverage: attendanceManifest.readCoverage,
    approveAttendanceCoverage: attendanceManifest.approveCoverage };
};

module.exports = { PayrollSchemeServiceError, makeService };
