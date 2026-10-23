import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { normalizeEligibilityPeriods, eligibilityPayloadSha256, buildEligibleEmployees } = require(path.join(root, 'payroll-employment-eligibility.js'));

const employeeA = '11111111-1111-4111-8111-111111111111';
const employeeB = '22222222-2222-4222-8222-222222222222';
const periods = [
  { employeeId: employeeA, effectiveFrom: '2026-10-15', effectiveTo: null },
  { employeeId: employeeA, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-10' },
  { employeeId: employeeB, effectiveFrom: '2026-09-01', effectiveTo: '2026-10-02' }
];

const normalized = normalizeEligibilityPeriods(periods);
assert.deepEqual(normalized.map(row => row.effectiveFrom), ['2026-10-01', '2026-10-15', '2026-09-01']);
assert.equal(eligibilityPayloadSha256(periods), eligibilityPayloadSha256([...periods].reverse()),
  'input digest is independent of request array order');
assert.match(eligibilityPayloadSha256(periods), /^[a-f0-9]{64}$/);
assert.notEqual(eligibilityPayloadSha256(periods, 'confirmed', null),
  eligibilityPayloadSha256(periods, 'confirmed', '33333333-3333-4333-8333-333333333333'),
  'a full revision digest binds the exact base revision used for optimistic concurrency');
assert.throws(() => normalizeEligibilityPeriods([
  { employeeId: employeeA, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-10' },
  { employeeId: employeeA, effectiveFrom: '2026-10-10', effectiveTo: null }
]), /payroll_employment_periods_overlap/, 'inclusive same-day rehire intervals cannot overlap');
assert.throws(() => normalizeEligibilityPeriods([{ employeeId: employeeA, effectiveFrom: '2026-02-30', effectiveTo: null }]),
  /invalid_payroll_employment_period/);
assert.throws(() => normalizeEligibilityPeriods([{ employeeId: employeeA, effectiveFrom: '2026-10-01', effectiveTo: null, role: 'bar' }]),
  /invalid_payroll_employment_period/, 'caller cannot smuggle role or name into the employment ledger');
assert.deepEqual(normalizeEligibilityPeriods([]), [], 'an owner-attested empty roster is distinct from a missing revision');

assert.deepEqual(buildEligibleEmployees(periods, '2026-10-01', '2026-10-31'), [
  { id: employeeA, activeIntervals: [
    { from: '2026-10-01', to: '2026-10-10' }, { from: '2026-10-15', to: '2026-10-31' }
  ] },
  { id: employeeB, activeIntervals: [{ from: '2026-10-01', to: '2026-10-02' }] }
]);
assert.deepEqual(buildEligibleEmployees(periods, '2026-11-01', '2026-11-30'), [
  { id: employeeA, activeIntervals: [{ from: '2026-11-01', to: '2026-11-30' }] }
], 'open-ended eligibility remains bounded to the requested source period');
assert.deepEqual(buildEligibleEmployees([], '2026-10-01', '2026-10-31'), []);
console.log('PASS payroll-employment-eligibility-contract');
