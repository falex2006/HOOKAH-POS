'use strict';

const { validDate, normalizeProductDepartmentMappings } = require('./payroll-product-department-source');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MAPPINGS = 10000;
const fail = (code, status = 400) => { throw Object.assign(new TypeError(code), { code, status }); };
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clean = (value, max, code, min = 1) => {
  if (typeof value !== 'string') fail(code);
  const result = value.trim();
  if (result.length < min || result.length > max) fail(code);
  return result;
};
const previousDate = value => new Date(Date.parse(`${value}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
const nextDate = value => new Date(Date.parse(`${value}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);

const normalizeAssignments = rows => {
  if (!Array.isArray(rows) || rows.length > MAX_MAPPINGS) fail('payroll_product_department_mappings_invalid');
  const seen = new Set(), names = new Map();
  return rows.map(row => {
    if (!exactKeys(row, ['productId', 'departmentCode', 'departmentName']) || !UUID.test(String(row.productId || ''))) {
      fail('payroll_product_department_assignment_invalid');
    }
    const productId = String(row.productId).toLowerCase();
    if (seen.has(productId)) fail('payroll_product_department_duplicate_product');
    seen.add(productId);
    const departmentCode = clean(row.departmentCode, 64, 'payroll_product_department_code_invalid');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(departmentCode)) fail('payroll_product_department_code_invalid');
    const departmentName = clean(row.departmentName, 160, 'payroll_product_department_name_invalid');
    if (names.has(departmentCode) && names.get(departmentCode) !== departmentName) fail('payroll_product_department_name_conflict');
    names.set(departmentCode, departmentName);
    return { productId, departmentCode, departmentName };
  }).sort((a, b) => a.productId.localeCompare(b.productId, 'en'));
};

const normalRevisionRequest = input => {
  if (!exactKeys(input, ['expectedRevisionId', 'idempotencyKey', 'reason', 'mappings'])
      || (input.expectedRevisionId !== null && !UUID.test(String(input.expectedRevisionId || '')))) fail('invalid_payroll_product_department_revision');
  return { expectedRevisionId: input.expectedRevisionId === null ? null : String(input.expectedRevisionId).toLowerCase(),
    idempotencyKey: clean(input.idempotencyKey, 160, 'payroll_product_department_idempotency_key_invalid', 8),
    reason: clean(input.reason, 1000, 'payroll_product_department_reason_invalid', 8), mappings: normalizeAssignments(input.mappings) };
};

const retroactiveRevisionRequest = input => {
  if (!exactKeys(input, ['expectedRevisionId', 'idempotencyKey', 'reason', 'effectiveFrom', 'retroactiveReason', 'ownerAttestation', 'mappings'])
      || (input.expectedRevisionId !== null && !UUID.test(String(input.expectedRevisionId || '')))
      || !validDate(input.effectiveFrom) || input.ownerAttestation?.confirmed !== true
      || input.ownerAttestation?.action !== 'retroactive_payroll_product_department_mapping'
      || !exactKeys(input.ownerAttestation, ['confirmed', 'action'])) fail('invalid_payroll_product_department_retroactive_revision');
  if (!Array.isArray(input.mappings) || input.mappings.length > MAX_MAPPINGS) fail('payroll_product_department_mappings_invalid');
  if (input.mappings.some(row => !exactKeys(row, ['productId', 'productName', 'departmentCode', 'departmentName', 'effectiveFrom', 'effectiveTo']))) {
    fail('payroll_product_department_mappings_invalid');
  }
  const mappings = normalizeProductDepartmentMappings(input.mappings);
  return { expectedRevisionId: input.expectedRevisionId === null ? null : String(input.expectedRevisionId).toLowerCase(),
    idempotencyKey: clean(input.idempotencyKey, 160, 'payroll_product_department_idempotency_key_invalid', 8),
    reason: clean(input.reason, 1000, 'payroll_product_department_reason_invalid', 8),
    effectiveFrom: input.effectiveFrom,
    retroactiveReason: clean(input.retroactiveReason, 500, 'payroll_product_department_retroactive_reason_invalid', 8), mappings };
};

// Create the next-local-day full snapshot without changing any prior date's
// mapping. Old revisions remain immutable; only this new snapshot closes an
// open interval at the boundary when the owner changes/removes an assignment.
const buildNextDayDepartmentSnapshot = ({ previousMappings, assignments, products, effectiveFrom }) => {
  if (!validDate(effectiveFrom) || !(products instanceof Map)) fail('payroll_product_department_snapshot_context_invalid');
  const previous = normalizeProductDepartmentMappings(previousMappings || []);
  const desired = normalizeAssignments(assignments);
  const desiredByProduct = new Map(desired.map(row => [row.productId, row]));
  const yesterday = previousDate(effectiveFrom), output = [];
  const activeByProduct = new Map();
  const futureByProduct = new Map();
  for (const row of previous) {
    if (row.effectiveFrom <= effectiveFrom && (!row.effectiveTo || row.effectiveTo >= effectiveFrom)) activeByProduct.set(row.productId, row);
    else if (row.effectiveFrom > effectiveFrom) {
      const future = futureByProduct.get(row.productId) || [];
      future.push(row); futureByProduct.set(row.productId, future);
      output.push(row);
    } else output.push(row);
  }
  for (const [productId, row] of activeByProduct) {
    const target = desiredByProduct.get(productId);
    if (target && target.departmentCode === row.departmentCode && target.departmentName === row.departmentName) {
      output.push(row);
      desiredByProduct.delete(productId);
    } else if (row.effectiveFrom < effectiveFrom) {
      output.push({ ...row, effectiveTo: yesterday });
    }
  }
  for (const assignment of desiredByProduct.values()) {
    const oldActive = activeByProduct.get(assignment.productId);
    const catalog = products.get(assignment.productId);
    const preservedArchivedAssignment = oldActive && oldActive.departmentCode === assignment.departmentCode
      && oldActive.departmentName === assignment.departmentName;
    if (!catalog && !preservedArchivedAssignment) fail('payroll_product_department_product_invalid');
    const productName = catalog?.name || oldActive?.productName;
    if (typeof productName !== 'string' || !productName.trim()) fail('payroll_product_department_product_invalid');
    let effectiveTo = oldActive?.effectiveTo || null;
    const nextFutureStart = (futureByProduct.get(assignment.productId) || []).map(row => row.effectiveFrom)
      .filter(date => date > effectiveFrom).sort()[0];
    if (nextFutureStart) {
      const beforeFuture = previousDate(nextFutureStart);
      if (!effectiveTo || beforeFuture < effectiveTo) effectiveTo = beforeFuture;
    }
    output.push({ productId: assignment.productId, productName: productName.trim(), departmentCode: assignment.departmentCode,
      departmentName: assignment.departmentName, effectiveFrom, effectiveTo });
  }
  const result = normalizeProductDepartmentMappings(output);
  if (result.length > MAX_MAPPINGS) fail('payroll_product_department_mappings_invalid');
  return result;
};

const assertHistoryPreserved = (previousMappings, nextMappings, boundary) => {
  const previous = normalizeProductDepartmentMappings(previousMappings || []);
  const next = normalizeProductDepartmentMappings(nextMappings || []);
  const signature = row => JSON.stringify([row.productId,row.productName,row.departmentCode,row.departmentName,row.effectiveFrom,row.effectiveTo]);
  const nextSignatures = new Set(next.map(signature));
  for (const row of previous) {
    if (row.effectiveFrom >= boundary) continue;
    if (row.effectiveTo && row.effectiveTo < boundary) {
      if (!nextSignatures.has(signature(row))) fail('payroll_product_department_history_rewrite', 409);
      continue;
    }
    const retained = next.some(candidate => candidate.productId === row.productId && candidate.productName === row.productName
      && candidate.departmentCode === row.departmentCode && candidate.departmentName === row.departmentName
      && candidate.effectiveFrom === row.effectiveFrom
      && (candidate.effectiveTo === row.effectiveTo || candidate.effectiveTo === previousDate(boundary)));
    if (!retained) fail('payroll_product_department_history_rewrite', 409);
  }
};

module.exports = { MAX_MAPPINGS, normalizeAssignments, normalRevisionRequest, retroactiveRevisionRequest,
  buildNextDayDepartmentSnapshot, assertHistoryPreserved };
