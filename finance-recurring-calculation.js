'use strict';

const policies = new Set(['full_months_only', 'calendar_days']);
const policyFor = rule => rule.partial_month_policy || rule.partialMonthPolicy || 'full_months_only';
const minor = value => {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('invalid_recurring_monthly_amount');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
};
const decimal = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const calendarPeriod = (rule, key) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new Error('invalid_recurring_month');
  const calendarFrom = `${key}-01`;
  const next = new Date(`${calendarFrom}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const calendarTo = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
  const startsOn = String(rule.starts_on || rule.startsOn).slice(0, 10);
  const endsOn = String(rule.ends_on || rule.endsOn || '9999-12-31').slice(0, 10);
  const periodFrom = startsOn > calendarFrom ? startsOn : calendarFrom;
  const periodTo = endsOn < calendarTo ? endsOn : calendarTo;
  const coveredDays = periodFrom > periodTo ? 0 : (Date.parse(`${periodTo}T00:00:00Z`) - Date.parse(`${periodFrom}T00:00:00Z`)) / 86400000 + 1;
  const monthDays = Number(calendarTo.slice(8));
  const policy = policyFor(rule);
  if (!policies.has(policy)) throw new Error('invalid_recurring_partial_month_policy');
  const partial = coveredDays > 0 && coveredDays < monthDays;
  const eligible = coveredDays > 0 && (!partial || policy === 'calendar_days');
  const dueDay = Math.min(Number(rule.day_of_month || rule.dayOfMonth || 1), monthDays);
  const contractDueDate = `${key}-${String(dueDay).padStart(2, '0')}`;
  // The first bill cannot be due before service starts. A final bill can be due after service ends.
  const dueDate = eligible && contractDueDate < periodFrom ? periodFrom : contractDueDate;
  return { policy, calendarFrom, calendarTo, periodFrom, periodTo, coveredDays, monthDays, partial, eligible, dueDate };
};

const pricePeriod = (period, version) => {
  if (!period.eligible) throw new Error('recurring_period_excluded');
  const sourceLines = Array.isArray(version.lines) ? version.lines : [];
  if (!sourceLines.length || sourceLines.length > 40) throw new Error('invalid_recurring_monthly_lines');
  const monthlyLines = sourceLines.map(line => ({ description: String(line.description), amount: decimal(minor(line.amount)) }));
  const monthlyTotal = monthlyLines.reduce((sum, line) => sum + minor(line.amount), 0n);
  if (monthlyTotal !== minor(version.amount)) throw new Error('recurring_monthly_lines_total_mismatch');
  const divisor = BigInt(period.monthDays);
  const lines = monthlyLines.map(line => {
    const amount = minor(line.amount);
    // HALF_UP per line, using only integer kopeks and calendar days.
    const rounded = period.partial ? (amount * BigInt(period.coveredDays) * 2n + divisor) / (divisor * 2n) : amount;
    return { description: line.description, amount: decimal(rounded) };
  });
  const amount = decimal(lines.reduce((sum, line) => sum + minor(line.amount), 0n));
  const prorationSnapshot = period.partial ? {
    calculationVersion: 1, policy: period.policy, coveredFrom: period.periodFrom, coveredTo: period.periodTo,
    coveredDays: period.coveredDays, monthDays: period.monthDays, monthlyAmount: decimal(monthlyTotal), monthlyLines,
    calculatedAmount: amount, calculatedLines: lines,
  } : null;
  return { amount, lines, prorationSnapshot };
};

module.exports = { calendarPeriod, pricePeriod, policyFor };
