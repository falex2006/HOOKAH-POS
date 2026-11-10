'use strict';
const { randomUUID } = require('node:crypto');
const { calculatePayrollDeferredMonthEvidence } = require('./payroll-deferred-month-evidence');

function isHalfMonthSettlementCandidate(detail) {
  const { from, to } = detail.period;
  if (detail.capabilityVersion !== 'employee_attributed_remaining_net_refund_v2'
      || !/^\d{4}-\d{2}-01$/.test(from) || !detail.employees.length) return false;
  const monthEnd = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return to === monthEnd;
}

async function explainMonthlyEntries(db, actor, runId, detail, { loadEvidence, checkFreshness, readH1 }) {
  if (!isHalfMonthSettlementCandidate(detail)) return detail;
  const { from, to } = detail.period;
  const month = from.slice(0, 7);
  const { evidence } = await loadEvidence();
  const schema = (await db.query(`SELECT to_regclass('payroll_h1_claim_slots') IS NOT NULL AS h1,
    to_regclass('payroll_h2_claim_slots') IS NOT NULL AS h2`)).rows[0];
  if (!schema.h1) return detail;
  const ids = detail.employees.map(row => row.employeeId);
  const states = (await db.query(`SELECT employee_id,
    EXISTS(SELECT 1 FROM payroll_h1_claim_slots s WHERE s.venue_id=$1 AND s.employee_id=u.employee_id
      AND s.month_from=$3::date AND s.claim_id IS NOT NULL) AS has_claim,
    COALESCE((SELECT sum(final_amount) FROM payroll_daily_snapshots d WHERE d.venue_id=$1 AND d.run_id=$2
      AND d.employee_id=u.employee_id AND d.local_date BETWEEN $3::date AND $3::date+13),0)=0 AS zero_first_half,
    EXISTS(SELECT 1 FROM payroll_entries e WHERE e.venue_id=$1 AND e.user_id=u.employee_id
      AND e.status IN ('draft','approved','paid') AND e.period_from<=$3::date+13 AND e.period_to>=$3::date) AS h1_overlap,
    EXISTS(SELECT 1 FROM payroll_entries e WHERE e.venue_id=$1 AND e.user_id=u.employee_id
      AND e.status IN ('draft','approved','paid') AND e.period_from<=$4::date AND e.period_to>=$3::date+14) AS h2_overlap
    FROM unnest($5::uuid[]) u(employee_id)`, [actor.venueId, runId, from, to, ids])).rows;
  const byEmployee = new Map(states.map(row => [row.employee_id, row]));
  const slots = schema.h2 ? (await db.query(`SELECT c.employee_id,c.monthly_run_id,c.h2_entry_id FROM payroll_h2_claim_slots s
    JOIN payroll_h2_settlement_claims c ON c.venue_id=s.venue_id AND c.employee_id=s.employee_id AND c.month_from=s.month_from AND c.id=s.claim_id
    WHERE s.venue_id=$1 AND s.month_from=$2::date AND s.employee_id=ANY($3::uuid[])`, [actor.venueId, from, ids])).rows : [];
  const reserved = new Map(slots.map(row => [row.employee_id, row]));
  let current;
  const savedEmployees = new Map(evidence.calculatorReplay.result.employees.map(e => [e.employeeId, e]));
  const employees = [];
  for (const row of detail.employees) {
    const state = byEmployee.get(row.employeeId), slot = reserved.get(row.employeeId);
    const required = Boolean(state?.has_claim || slot);
    if (!required && (!state?.zero_first_half || state.h1_overlap || state.h2_overlap)) { employees.push(row); continue; }
    const decision = { ...row, h2Required: required, h2EntryAvailable: false };
    employees.push(decision);
    if (!schema.h2) { decision.h2EntryBlockReason = 'payroll_half_month_settlement_schema_required'; continue; }
    if (slot || state.h2_overlap) { decision.h2EntryBlockReason = 'payroll_entry_period_overlap'; continue; }
    if (evidence.periodClosure?.timezone !== detail.venueTimezone || !(evidence.periodClosure?.venueLocalDate > to)) {
      decision.h2EntryBlockReason = 'payroll_half_month_month_context_unverified'; continue;
    }
    current ??= await checkFreshness();
    if (current.status !== 'current') { decision.h2EntryBlockReason = 'payroll_half_month_month_context_unverified'; continue; }
    const employee = savedEmployees.get(row.employeeId);
    if (!employee) { decision.h2EntryBlockReason = 'payroll_entry_employee_not_in_calculation'; continue; }
    let h1;
    try { [h1] = await readH1(month, evidence, employee); }
    catch (error) {
      if (!error.code?.startsWith('payroll_')) throw error;
      decision.h2EntryBlockReason = error.code; continue;
    }
    if (!h1?.usableForH2) { decision.h2EntryBlockReason = 'payroll_half_month_h1_not_finalized'; continue; }
    let proof;
    try {
      proof = calculatePayrollDeferredMonthEvidence(evidence, { venueId: actor.venueId, employeeId: row.employeeId,
        month, monthlyRunId: runId, h2RunId: randomUUID(), h1State: h1 });
    } catch (error) {
      if (!error.code?.startsWith('payroll_')) throw error;
      decision.h2EntryBlockReason = error.code; continue;
    }
    if (proof.h2GrossAccruedMinor <= 0) { decision.h2EntryBlockReason = 'payroll_half_month_zero_residual_requires_review'; continue; }
    decision.h2EntryAvailable = true;
    decision.h2Reconciliation = { monthlyGrossMinor: proof.monthlyGrossMinor, h1GrossAccruedMinor: proof.h1GrossAccruedMinor,
      h2GrossAccruedMinor: proof.h2GrossAccruedMinor };
  }
  return { ...detail, employees };
}
module.exports = { isHalfMonthSettlementCandidate, explainMonthlyEntries };
