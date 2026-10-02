'use strict';

// Persistence API for payroll-owned version configuration. Route callers must
// build the principal from authenticated server session state. preview/compare
// use owner-supplied scenario data and never attest POS source data or persist it.
const { randomUUID } = require('node:crypto');
const { calculatePayrollScheme, validateScheme } = require('./payroll-schemes');

// Preview is owner-only and scenario-only, but a privileged caller can still
// submit oversized collections. Bound work before entering the calculator's
// employee × day and sales-line loops.
const MAX_PREVIEW_EMPLOYEES = 500;
const MAX_PREVIEW_SALES_LINES = 20000;
const MAX_PREVIEW_ASSIGNMENTS = 5000;
const MAX_SCHEME_CHILD_ROWS = 15000;

class PayrollSchemeServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PayrollSchemeServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new PayrollSchemeServiceError(code, status); };
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
  const engineScheme = {
    id: schemeId,
    versionId,
    mode: definition.mode,
    currency,
    roleParameters: definition.roleParameters,
    applyMilestones: definition.applyMilestones,
    milestoneCapPolicy: definition.milestoneCapPolicy,
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
  return { ...engineScheme, effectiveFrom, effectiveTo, roleAssignments: assignments };
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
    roleParameters: config.roleParameters || {},
    applyMilestones: config.applyMilestones,
    milestoneCapPolicy: config.milestoneCapPolicy,
    roleAssignments: assignments.rows,
    employeeOverrides: overrides.rows.map((row) => ({ ...row, value: row.mode === 'override' ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : undefined })),
    itemRules: itemRules.rows
  };
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

const withOwnerTransaction = async (pool, principal, callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await assertOwner(client, principal, true);
    const result = await callback(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof PayrollSchemeServiceError) throw error;
    if (error?.code === '23505') fail('payroll_scheme_conflict', 409);
    if (error?.code === '23P01') fail('payroll_scheme_effective_window_conflict', 409);
    if (error?.code === '23503') fail('payroll_scheme_reference_invalid', 400);
    if (error?.code === '23514') fail('payroll_scheme_configuration_rejected', 400);
    if (error?.code === '22P02' || error?.code === '22003') fail('payroll_scheme_reference_invalid', 400);
    throw error;
  } finally {
    client.release();
  }
};

const withOwnerRead = async (pool, principal, callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor = await assertOwner(client, principal, false);
    const result = await callback(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const calculateScenario = (scheme, previewInput) => calculatePayrollScheme({
  ...previewInput,
  roleAssignments: scheme.roleAssignments,
  scheme: {
    id: scheme.id,
    versionId: scheme.versionId,
    mode: scheme.mode,
    currency: scheme.currency,
    roleParameters: scheme.roleParameters,
    applyMilestones: scheme.applyMilestones,
    milestoneCapPolicy: scheme.milestoneCapPolicy,
    employeeOverrides: scheme.employeeOverrides,
    itemRules: scheme.itemRules
  }
});

const assertPreviewSize = (input, scheme) => {
  if ((Array.isArray(input.employees) && input.employees.length > MAX_PREVIEW_EMPLOYEES)
      || (Array.isArray(input.sales) && input.sales.length > MAX_PREVIEW_SALES_LINES)) {
    fail('preview_input_too_large', 413);
  }
  if ((scheme.roleAssignments?.length || 0) > MAX_PREVIEW_ASSIGNMENTS
      || (scheme.employeeOverrides?.length || 0) > MAX_PREVIEW_ASSIGNMENTS
      || (scheme.itemRules?.length || 0) > MAX_PREVIEW_ASSIGNMENTS) fail('scheme_definition_too_large', 413);
};

const sumCentsSafely = (values) => {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
};

const makeService = (pool) => {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('payroll_scheme_pool_required');

  const listSchemes = async (principal) => {
    return withOwnerRead(pool, principal, async (db, actor) => {
      const result = await db.query(`SELECT s.id,s.name,s.description,s.created_at AS "createdAt",
        COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'versionNo',v.version_no,'mode',v.mode,'status',v.status,
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

  const compare = async (principal, versionIds, previewInput = {}, baselineVersionId) => {
    if (!Array.isArray(versionIds) || versionIds.length < 2 || versionIds.length > 8 || new Set(versionIds).size !== versionIds.length) fail('comparison_versions_required');
    if (!previewInput || typeof previewInput !== 'object' || Array.isArray(previewInput)) fail('preview_input_required');
    if (!versionIds.includes(baselineVersionId)) fail('comparison_baseline_required');
    return withOwnerRead(pool, principal, async (db, actor) => {
      const orderedIds = [...versionIds].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      const schemes = await Promise.all(orderedIds.map((id) => loadVersion(db, actor.venueId, id)));
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
      return { official: false, persistence: 'none', scenario: true, baselineVersionId, comparisons, results };
    });
  };

  const insertVersion = async (db, actor, schemeId, versionNo, rawDefinition) => {
    const versionId = randomUUID();
    const definition = ensureDefinition(rawDefinition, schemeId, versionId);
    const configJson = JSON.stringify({ roleParameters: definition.roleParameters, applyMilestones: definition.applyMilestones, milestoneCapPolicy: definition.milestoneCapPolicy });
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
    const version = await insertVersion(db, actor, schemeId, 1, input.definition);
    return { id: schemeId, name, description, versions: [version] };
  });

  const createVersion = async (principal, schemeId, definitionInput) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const scheme = await db.query('SELECT id FROM payroll_schemes WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, schemeId]);
    if (!scheme.rows[0]) fail('payroll_scheme_not_found', 404);
    const version = await db.query('SELECT COALESCE(MAX(version_no),0)::int+1 AS next_no FROM payroll_scheme_versions WHERE venue_id=$1 AND scheme_id=$2', [actor.venueId, schemeId]);
    return insertVersion(db, actor, schemeId, version.rows[0].next_no, definitionInput);
  });

  const replaceDraftVersion = async (principal, versionId, definitionInput) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const current = await db.query('SELECT id,scheme_id,status FROM payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, versionId]);
    if (!current.rows[0]) fail('payroll_scheme_version_not_found', 404);
    if (current.rows[0].status !== 'draft') fail('payroll_scheme_version_immutable', 409);
    const definition = ensureDefinition(definitionInput, current.rows[0].scheme_id, versionId);
    for (const table of ['payroll_role_assignments', 'payroll_employee_overrides', 'payroll_item_commission_rules']) {
      await db.query(`DELETE FROM ${table} WHERE venue_id=$1 AND scheme_version_id=$2`, [actor.venueId, versionId]);
    }
    await db.query(`UPDATE payroll_scheme_versions SET mode=$3,currency=$4,effective_from=$5,effective_to=$6,
      config_json=$7::jsonb WHERE venue_id=$1 AND id=$2`, [actor.venueId, versionId, definition.mode, definition.currency,
      definition.effectiveFrom, definition.effectiveTo, JSON.stringify({ roleParameters: definition.roleParameters, applyMilestones: definition.applyMilestones, milestoneCapPolicy: definition.milestoneCapPolicy })]);
    await persistChildren(db, actor, versionId, definition);
    const scheme = await loadVersion(db, actor.venueId, versionId);
    await recordRevision(db, actor, scheme, 'edited');
    return scheme;
  });

  const activateVersion = async (principal, versionId) => withOwnerTransaction(pool, principal, async (db, actor) => {
    const current = await loadVersion(db, actor.venueId, versionId);
    if (current.status !== 'draft') fail('payroll_scheme_version_not_draft', 409);
    ensureDefinition(current, current.id, current.versionId);
    const result = await db.query(`UPDATE payroll_scheme_versions SET status='active',status_changed_by=$3,
      status_changed_by_name=$4,status_changed_at=now() WHERE venue_id=$1 AND id=$2 AND status='draft' RETURNING id`,
    [actor.venueId, versionId, actor.userId, actor.name]);
    if (!result.rows[0]) fail('payroll_scheme_version_not_draft', 409);
    const scheme = await loadVersion(db, actor.venueId, versionId);
    await recordRevision(db, actor, scheme, 'activated');
    return scheme;
  });

  return { listSchemes, getVersion, listVersionRevisions, createScheme, createVersion, replaceDraftVersion, activateVersion, preview, compare };
};

module.exports = { PayrollSchemeServiceError, makeService };
