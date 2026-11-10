'use strict';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (value) => {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const countInclusiveDays = (from, to) => {
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || to < from) return 0;
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;
};

const proratedMonthlyPayrollAmount = (monthlyRate, from, to) => {
  const rate = Number(monthlyRate);
  if (!Number.isFinite(rate) || rate < 0 || !isValidIsoDate(from) || !isValidIsoDate(to) || to < from) return null;
  // The stored monthly rate is numeric(12,2). Allocate cumulative kopecks
  // so that any adjacent portions add back to the same month's rate.
  const rateCents = Math.round(rate * 100);
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  let totalCents = 0;
  while (cursor <= end) {
    const firstDay = cursor.getUTCDate();
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 0);
    const monthDays = cursor.getUTCDate();
    const lastDay = cursor <= end ? monthDays : end.getUTCDate();
    totalCents += Math.round(rateCents * lastDay / monthDays)
      - Math.round(rateCents * (firstDay - 1) / monthDays);
    cursor.setUTCDate(monthDays + 1);
  }
  return totalCents / 100;
};

const calculatePayrollAmount = ({ ruleType, rate, hours = 0, shifts = 0, revenue = 0, periodFrom, periodTo }) => {
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate) || numericRate < 0) return null;
  let amount;
  if (ruleType === 'hourly') amount = Number(hours) * numericRate;
  else if (ruleType === 'per_shift') amount = Number(shifts) * numericRate;
  else if (ruleType === 'percent_revenue') amount = Number(revenue) * numericRate / 100;
  else if (ruleType === 'monthly') return proratedMonthlyPayrollAmount(numericRate, periodFrom, periodTo);
  else return null;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
};

const canTransitionPayroll = (status, action) => {
  if (action === 'approve') return status === 'draft';
  if (action === 'pay') return status === 'approved';
  if (action === 'cancel') return status === 'draft' || status === 'approved';
  return false;
};

module.exports = { isValidIsoDate, countInclusiveDays, proratedMonthlyPayrollAmount, calculatePayrollAmount, canTransitionPayroll };
