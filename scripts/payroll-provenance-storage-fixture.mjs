// Synthetic storage evidence only: does not attest authenticated source collection.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mapPayrollTypedSnapshotRows } = require('../payroll-typed-snapshot-serializer.js');
const { mapPayrollMilestoneStorageRows } = require('../payroll-milestone-storage-serializer.js');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function addProvenance(bundle) {
  const { run, input } = bundle;
  run.engine_version = 'payroll-verified-no-refund-v1';
  run.input_watermark = 'a'.repeat(64);
  const totalAmountCents = input.result.employees.reduce((sum, employee) => sum + employee.amountCents, 0);
  const period = { from: run.period_from, to: run.period_to };
  const closure = { schemaVersion: 1, venueId: run.venue_id, period, timezone: run.venue_timezone,
    transactionTimestamp: '2026-11-01T12:00:00.000Z', venueLocalDate: '2026-11-01' };
  const calculationWatermark = 'b'.repeat(64);
  const payload = { schemaVersion: 1, capabilityVersion: 'employee_attributed_merchandise_net_no_refund_v1',
    venueId: run.venue_id, runId: run.id, schemeVersionId: run.scheme_version_id, period,
    currency: run.currency, venueTimezone: run.venue_timezone, inputWatermark: run.input_watermark,
    closureWatermark: hash({ periodClosure: closure, inputWatermark: run.input_watermark }),
    calculationWatermark, snapshotInputWatermark: hash({ schemaVersion: 1, sourceWatermark: run.input_watermark,
      calculationWatermark, snapshotInput: input, mappedRows: mapPayrollTypedSnapshotRows(input),
      milestoneRows: mapPayrollMilestoneStorageRows(input) }),
    schemeSnapshot: { versionId: run.scheme_version_id, currency: run.currency },
    periodClosure: closure, sourceEvidence: {}, totalAmountCents };
  const evidence_payload = canonical(payload);
  run.input_checksum = createHash('sha256').update(evidence_payload).digest('hex');
  bundle.provenance = { venue_id: run.venue_id, run_id: run.id, schema_version: 1,
    capability_version: payload.capabilityVersion, evidence_payload, evidence_sha256: run.input_checksum,
    total_amount_cents: totalAmountCents };
  return bundle;
}
