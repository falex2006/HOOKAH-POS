'use strict';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 500;
const validDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const readPayrollEntryOverlapDiagnostic = async (db, venueId, input) => {
  if (!input || !validDate(input.from) || !validDate(input.to) || input.from > input.to) {
    const error = new TypeError('invalid_payroll_entry_diagnostic_period');
    error.code = 'invalid_payroll_entry_diagnostic_period';
    error.status = 400;
    throw error;
  }
  const entries = await db.query(`WITH scoped AS (
      SELECT pe.id,pe.user_id,pe.period_from::text AS period_from,pe.period_to::text AS period_to,
        pe.amount::text AS amount,pe.status,pe.rule_id,pe.expense_id,pe.payment_date::text AS payment_date,
        u.full_name AS employee_name,
        e.id AS resolved_expense_id,e.source AS expense_source,e.amount::text AS expense_amount,
        e.expense_date::text AS expense_date,
        (SELECT count(*)::int FROM payroll_entries refs WHERE refs.venue_id=pe.venue_id AND refs.expense_id=pe.expense_id) AS expense_reference_count,
        overlap.overlap_count,overlap.exact_duplicate,overlap.contained_overlap
      FROM payroll_entries pe
      LEFT JOIN users u ON u.venue_id=pe.venue_id AND u.id=pe.user_id
      LEFT JOIN expenses e ON e.venue_id=pe.venue_id AND e.id=pe.expense_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS overlap_count,
          coalesce(bool_or(refs.period_from=pe.period_from AND refs.period_to=pe.period_to),false) AS exact_duplicate,
          coalesce(bool_or((refs.period_from>=pe.period_from AND refs.period_to<=pe.period_to)
            OR (pe.period_from>=refs.period_from AND pe.period_to<=refs.period_to)),false) AS contained_overlap
        FROM payroll_entries refs WHERE refs.venue_id=pe.venue_id AND refs.user_id=pe.user_id AND refs.id<>pe.id
          AND refs.period_from<=pe.period_to AND refs.period_to>=pe.period_from
          AND refs.status IN ('draft','approved','paid')
      ) overlap ON true
      WHERE pe.venue_id=$1 AND pe.period_from <= $3::date AND pe.period_to >= $2::date
        AND pe.status IN ('draft','approved','paid')
      ORDER BY pe.user_id,pe.period_from,pe.period_to,pe.id LIMIT $4
    ) SELECT * FROM scoped ORDER BY user_id,period_from,period_to,id`, [venueId, input.from, input.to, MAX_ROWS + 1]);
  const expenses = await db.query(`SELECT e.id,e.amount::text AS amount,e.expense_date::text AS expense_date,
      (SELECT count(*)::int FROM payroll_entries pe WHERE pe.venue_id=e.venue_id AND pe.expense_id=e.id) AS entry_reference_count
    FROM expenses e WHERE e.venue_id=$1 AND e.source='payroll' AND e.expense_date BETWEEN $2::date AND $3::date
    ORDER BY e.expense_date,e.id LIMIT $4`, [venueId, input.from, input.to, MAX_ROWS + 1]);
  const rows = entries.rows.slice(0, MAX_ROWS).map(row => {
    const overlapCount = Number(row.overlap_count) || 0;
    const expenseResolved = row.expense_id && row.resolved_expense_id;
    const amountMismatch = expenseResolved && Number(row.amount) !== Number(row.expense_amount);
    const dateMismatch = expenseResolved && row.payment_date && row.expense_date && row.payment_date !== row.expense_date;
    const flags = [];
    if (row.rule_id === null) flags.push('legacy_without_rule');
    if (row.exact_duplicate) flags.push('exact_period_duplicate');
    else if (row.contained_overlap) flags.push('overlapping_period_contained');
    else if (overlapCount) flags.push('overlapping_period_partial');
    if (row.expense_id && !expenseResolved) flags.push('expense_reference_missing_in_venue');
    if (!row.expense_id) flags.push(row.status === 'paid' ? 'paid_without_explicit_expense_link' : 'no_explicit_expense_link');
    if (expenseResolved && row.expense_source !== 'payroll') flags.push('linked_expense_source_mismatch');
    if (expenseResolved && row.status !== 'paid') flags.push('expense_link_on_nonpaid_entry');
    if (expenseResolved && row.status === 'paid' && row.expense_source !== 'payroll') flags.push('paid_entry_expense_not_payroll_source');
    if (Number(row.expense_reference_count) > 1) flags.push('expense_link_reused');
    if (amountMismatch) flags.push('amount_mismatch');
    if (dateMismatch) flags.push('payment_date_mismatch');
    return { id: row.id, employeeId: row.user_id, employeeName: row.employee_name || null,
      periodFrom: row.period_from, periodTo: row.period_to, amount: row.amount, status: row.status,
      ruleLinked: row.rule_id !== null, expenseLink: !row.expense_id ? 'none' : !expenseResolved ? 'missing_in_venue'
        : Number(row.expense_reference_count) > 1 ? 'ambiguous_reused' : 'linked',
      overlapCount, expenseSource: expenseResolved ? row.expense_source : null, expenseAmount: expenseResolved ? row.expense_amount : null,
      expenseDate: expenseResolved ? row.expense_date : null, flags };
  });
  const expenseRows = expenses.rows.slice(0, MAX_ROWS).map(row => ({ id: row.id, amount: row.amount,
    expenseDate: row.expense_date, entryReferenceCount: row.entry_reference_count,
    linkage: row.entry_reference_count === 0 ? 'unmatched' : row.entry_reference_count === 1 ? 'explicitly_linked' : 'ambiguous_reused',
    provenance: row.entry_reference_count === 0 ? 'unknown' : 'explicit_entry_link' }));
  return { schemaVersion: 1, diagnosticOnly: true, snapshotProvenance: 'unknown', period: { from: input.from, to: input.to },
    entries: rows, payrollExpenses: expenseRows, truncated: entries.rows.length > MAX_ROWS || expenses.rows.length > MAX_ROWS,
    interpretation: { accrual: 'Начисления — данные для P&L; payroll-расходы — денежные выплаты для cash flow. Не складывайте эти списки.',
      linkage: 'Связь подтверждается только явным expense_id в той же площадке. Совпадение суммы или даты не создаёт связь.' } };
};

module.exports = { readPayrollEntryOverlapDiagnostic };
