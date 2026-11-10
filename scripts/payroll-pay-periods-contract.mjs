import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollHalfMonthPeriod, resolvePayrollPeriodContext } = require('../payroll-pay-periods');
let pairs = 0;
for (let year = 2000; year < 2400; year++) for (let month = 1; month <= 12; month++) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const first = buildPayrollHalfMonthPeriod(key, 1), second = buildPayrollHalfMonthPeriod(key, 2);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  assert.deepEqual(first.earningPeriod, { from: `${key}-01`, to: `${key}-14` });
  assert.deepEqual(second.earningPeriod, { from: `${key}-15`, to: `${key}-${days}` });
  assert.deepEqual(first.monthBasisPeriod, { from: `${key}-01`, to: `${key}-14` });
  assert.deepEqual(second.monthBasisPeriod, { from: `${key}-01`, to: `${key}-${days}` });
  assert.equal(first.scheduledPaymentDate, `${key}-15`);
  assert.equal(second.scheduledPaymentDate, `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`);
  assert.equal(first.settlementAuthorized, false); assert.equal(second.settlementAuthorized, false);
  assert.deepEqual(resolvePayrollPeriodContext(first.earningPeriod), first);
  assert.deepEqual(resolvePayrollPeriodContext(second.earningPeriod), second);
  assert.ok(Object.isFrozen(second) && Object.isFrozen(second.earningPeriod));
  pairs++;
}
for (const month of ['2026-00', '2026-13', '2026-2', 'not-a-month']) assert.throws(() => buildPayrollHalfMonthPeriod(month, 1));
for (const month of ['0000-01', '0000-02']) assert.throws(() => buildPayrollHalfMonthPeriod(month, 1));
assert.equal(buildPayrollHalfMonthPeriod('0001-01', 1).earningPeriod.from, '0001-01-01');
assert.throws(() => buildPayrollHalfMonthPeriod('9999-12', 2), { code: 'invalid_payroll_pay_period' });
assert.equal(buildPayrollHalfMonthPeriod('9999-12', 1).scheduledPaymentDate, '9999-12-15');
for (const half of [0, 3, '1', null]) assert.throws(() => buildPayrollHalfMonthPeriod('2026-02', half));
for (const period of [null, [], { from: '2026-02-15', to: '2026-02-29' },
  { from: '2028-02-15', to: '2028-02-28' }, { from: '2026-02-14', to: '2026-02-28' },
  { from: '2026-12-15', to: '2027-01-01' }, { from: '2026-02-01', to: '2026-02-14', venue: 'override' }]) {
  assert.throws(() => resolvePayrollPeriodContext(period));
}
for (const to of ['01', '13', '15', '28']) {
  const result = resolvePayrollPeriodContext({ from: '2026-02-01', to: `2026-02-${to}` });
  assert.equal(result.kind, 'legacy_month_window'); assert.equal(result.scheduledPaymentDate, null);
}
const originalTimezone = process.env.TZ;
try {
  const expected = buildPayrollHalfMonthPeriod('2028-02', 2);
  for (const timezone of ['UTC', 'Asia/Yekaterinburg', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    process.env.TZ = timezone;
    assert.deepEqual(buildPayrollHalfMonthPeriod('2028-02', 2), expected);
  }
} finally { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; }
console.log(`PASS payroll pay periods: ${pairs} Gregorian month pairs, legacy windows, date-only timezone independence; no settlement authority`);

const validPeriod = { from: '2028-02-15', to: '2028-02-29' };
const symbolExtra = { ...validPeriod, [Symbol('unknown')]: true };
const hiddenExtra = Object.defineProperty({ ...validPeriod }, 'unknown', { value: true });
let getterCalls = 0;
const accessorPeriod = { get from() { getterCalls++; return validPeriod.from; }, to: validPeriod.to };
for (const period of [symbolExtra, hiddenExtra, accessorPeriod]) {
  assert.throws(() => resolvePayrollPeriodContext(period), { code: 'invalid_payroll_pay_period' });
}
assert.equal(getterCalls, 0, 'period accessors must never execute');
assert.deepEqual(resolvePayrollPeriodContext(Object.freeze({ ...validPeriod })), buildPayrollHalfMonthPeriod('2028-02', 2));
console.log('PASS strict period data descriptors: hidden/symbol fields and accessors rejected without execution');
