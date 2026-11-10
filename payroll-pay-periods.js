'use strict';

// Date-only scheduling from the owner's specification. These dates never
// authorize an accrual or replace the actual settlement date.
const fail = () => { throw Object.assign(new TypeError('invalid_payroll_pay_period'), {
  code: 'invalid_payroll_pay_period', status: 400 }); };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0, 4)) >= 1
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const monthEnd = month => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
};
const nextDate = value => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const result = date.toISOString().slice(0, 10);
  if (!validDate(result)) fail();
  return result;
};
const freeze = value => { Object.values(value).forEach(item => {
  if (item && typeof item === 'object') freeze(item);
}); return Object.freeze(value); };

function buildPayrollHalfMonthPeriod(month, half) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)
      || !validDate(`${month}-01`) || ![1, 2].includes(half)) fail();
  const from = `${month}-${half === 1 ? '01' : '15'}`;
  const to = half === 1 ? `${month}-14` : monthEnd(month);
  return freeze({ schemaVersion: 1, kind: 'half_month', half,
    // The turnover basis starts on day 1, but only extends through the
    // selected earning window. H1 cannot depend on future H2 source facts.
    earningPeriod: { from, to }, monthBasisPeriod: { from: `${month}-01`, to },
    scheduledPaymentDate: nextDate(to), settlementAuthorized: false });
}

// Preserve all existing month-to-date/full-month windows. Only the exact
// second half is the new source-context extension; arbitrary slices are not.
function resolvePayrollPeriodContext(period) {
  if (!period || Object.getPrototypeOf(period) !== Object.prototype
      || Reflect.ownKeys(period).length !== 2) fail();
  const fromDescriptor = Object.getOwnPropertyDescriptor(period, 'from');
  const toDescriptor = Object.getOwnPropertyDescriptor(period, 'to');
  if (!fromDescriptor || !toDescriptor || !Object.hasOwn(fromDescriptor, 'value')
      || !Object.hasOwn(toDescriptor, 'value')) fail();
  const from = fromDescriptor.value, to = toDescriptor.value;
  if (!validDate(from) || !validDate(to) || from > to
      || from.slice(0, 7) !== to.slice(0, 7)) fail();
  period = { from, to };
  const month = period.from.slice(0, 7);
  if (period.from === `${month}-01` && period.to === `${month}-14`) return buildPayrollHalfMonthPeriod(month, 1);
  if (period.from === `${month}-15` && period.to === monthEnd(month)) return buildPayrollHalfMonthPeriod(month, 2);
  if (period.from !== `${month}-01`) fail();
  return freeze({ schemaVersion: 1, kind: 'legacy_month_window', half: null,
    earningPeriod: { ...period }, monthBasisPeriod: { ...period },
    scheduledPaymentDate: null, settlementAuthorized: false });
}

module.exports = { buildPayrollHalfMonthPeriod, resolvePayrollPeriodContext };
