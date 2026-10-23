import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildNextDayDepartmentSnapshot, assertHistoryPreserved } = require('../payroll-product-department-revisions.js');
const productId = '00000000-0000-4000-8000-000000000011';
const row = (effectiveFrom, effectiveTo, departmentCode = 'bar', departmentName = 'Бар') => ({ productId,
  productName: 'Товар', departmentCode, departmentName, effectiveFrom, effectiveTo });
const products = new Map([[productId, { name: 'Товар', active: true }]]);

let result = buildNextDayDepartmentSnapshot({ previousMappings: [row('2026-12-01', null)], assignments: [], products,
  effectiveFrom: '2026-11-01' });
assert.deepEqual(result, [row('2026-12-01', null)], 'future mapping survives an earlier normal revision');
assertHistoryPreserved([row('2026-12-01', null)], result, '2026-11-01');

result = buildNextDayDepartmentSnapshot({ previousMappings: [row('2026-12-01', null)],
  assignments: [{ productId, departmentCode: 'kitchen', departmentName: 'Кухня' }], products, effectiveFrom: '2026-11-01' });
assert.deepEqual(result, [row('2026-11-01', '2026-11-30', 'kitchen', 'Кухня'), row('2026-12-01', null)]);
assertHistoryPreserved([row('2026-12-01', null)], result, '2026-11-01');

result = buildNextDayDepartmentSnapshot({ previousMappings: [row('2026-01-01', null)], assignments: [], products,
  effectiveFrom: '2026-11-01' });
assert.deepEqual(result, [row('2026-01-01', '2026-10-31')], 'removal closes the active mapping at the prior day');
assertHistoryPreserved([row('2026-01-01', null)], result, '2026-11-01');

result = buildNextDayDepartmentSnapshot({ previousMappings: [row('2026-11-01', null)],
  assignments: [{ productId, departmentCode: 'kitchen', departmentName: 'Кухня' }], products, effectiveFrom: '2026-11-01' });
assert.deepEqual(result, [row('2026-11-01', null, 'kitchen', 'Кухня')], 'same-boundary mapping can be replaced without invalid interval');

console.log('PASS payroll-product-department-revisions-contract.mjs');
