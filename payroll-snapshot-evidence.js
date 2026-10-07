'use strict';

const { reconcilePayrollSnapshotResult } = require('./payroll-snapshot-reconciliation');
const { validatePayrollSnapshotSourceContext } = require('./payroll-snapshot-source-context');

// One pure entry point for future typed DTO mapping. This only checks supplied
// evidence. It performs no database reads/writes and grants no official status.
const validatePayrollSnapshotEvidence = (input) => {
  const attendance = input && Object.getOwnPropertyDescriptor(input, 'attendance');
  if (attendance && !Object.hasOwn(attendance, 'value')) throw Object.assign(new TypeError('payroll_milestone_evidence_object_invalid'), { code: 'payroll_milestone_evidence_object_invalid' });
  const reconciliation = reconcilePayrollSnapshotResult(input?.result, attendance ? { attendance: attendance.value } : {});
  const context = validatePayrollSnapshotSourceContext(input);
  if (reconciliation.milestoneEvidence !== undefined) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const day of reconciliation.milestoneEvidence) for (const decision of day.milestoneDecisions) {
      if (!uuid.test(decision.employeeId) || decision.employeeId !== decision.employeeId.toLowerCase()
        || !context.employeeById.has(decision.employeeId) || decision.roleId.length > 80) {
        throw Object.assign(new TypeError('payroll_source_milestone_employee_context_mismatch'), { code: 'payroll_source_milestone_employee_context_mismatch' });
      }
    }
    context.milestoneEvidence = reconciliation.milestoneEvidence;
  }
  return context;
};

module.exports = { validatePayrollSnapshotEvidence };
