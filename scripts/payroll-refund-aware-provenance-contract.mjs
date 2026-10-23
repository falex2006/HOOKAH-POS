import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';
const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareRunProvenance: build, rebuildPayrollRefundAwareRunProvenance: rebuild } = require('../payroll-refund-aware-provenance');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000999';
let checks = 0;
for (const mode of payrollRefundAwareModes) for (const options of [{}, { noRefunds: true }, { fullReturn: true }]) {
  const args = { ...makePayrollRefundAwareFixture(mode, options), runId }, before = structuredClone(args), result = build(args);
  assert.equal(result.status, 'verified_run_evidence', `${mode}: ${result.reasons}`); checks++;
  assert.equal(result.provenance.schema_version, 2); checks++;
  const persisted = JSON.parse(result.provenance.evidence_payload);
  assert.equal(rebuild(persisted).provenance.evidence_payload, result.provenance.evidence_payload); checks++;
  assert.equal(rebuild(persisted).provenance.evidence_sha256, result.provenance.evidence_sha256); checks++;
  assert.deepEqual(args, before); checks++;
  assert.equal(result.payoutEligible, false); checks++;
  for (const mutate of [
    p => { p.totalAmountCents++; },
    p => { p.sourceBundle.employmentEligibility.periods[0].employeeName += ' changed'; },
    p => { p.sourceBundle.recognitionEvidence.payload += ' '; },
    p => { p.refundQuantityEvidence.lines[0].remainingQuantity = '999.000'; },
    p => { p.calculatorReplay.result.employees[0].amountCents++; },
    p => { p.schemeSnapshot.sourcePolicies.schemaVersion = 1; }
  ]) {
    const changed = structuredClone(persisted); mutate(changed);
    changed.sourceBundleWatermark = hash(changed.sourceBundle);
    assert.throws(() => rebuild(changed), /payroll_/); checks++;
  }
}
console.log(`payroll-refund-aware-provenance-contract: PASS ${checks} checks (pure all-mode canonical rebuild and tamper rejection)`);
