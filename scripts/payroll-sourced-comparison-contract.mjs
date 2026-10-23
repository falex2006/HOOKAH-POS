import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { buildPayrollSourcedComparison } = require('../payroll-sourced-comparison.js');
const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const versions = [
  { id: '33333333-3333-4333-8333-333333333333', versionId: '44444444-4444-4444-8444-444444444444', versionNo: 1, name: '10%', mode: 'percent_only' },
  { id: '55555555-5555-4555-8555-555555555555', versionId: '66666666-6666-4666-8666-666666666666', versionNo: 2, name: '15%', mode: 'percent_only' }
];
const period = { from: '2026-10-01', to: '2026-10-19' };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const readiness = {
  canonicalLinePricing: { sourceWatermark: 'a'.repeat(64) },
  recognitionManifest: { sourceWatermark: 'b'.repeat(64) },
  employeeEligibility: { sourceWatermark: 'c'.repeat(64) }
};
const candidate = (amountCents, inputWatermark, rows, status = 'scenario_ready', reasons = []) => ({
  status, amountCents: status === 'scenario_ready' ? amountCents : null, inputWatermark,
  requiredFacts: ['canonicalLinePricing', 'employeeEligibility', 'recognitionManifest'],
  reasons, employees: rows, candidateOnly: true, nonPayable: true, nonAccrual: true,
  payoutEligible: false, officialReady: false
});
const snapshot = (version, calculation) => {
  const value = { schemaVersion: 1, snapshotKind: 'candidate_preview', venueId, currency: 'RUB', schemeId: version.id,
    schemeVersionId: version.versionId, amountCents: calculation.amountCents, candidateOnly: true, nonPayable: true, nonAccrual: true,
    persistence: 'none', officialReady: false, payoutEligible: false, source: { inputWatermark: calculation.inputWatermark },
    period: { ...period, timezone: 'Asia/Yekaterinburg' }, lines: [], days: [], employeeDays: [] };
  value.candidateResultWatermark = digest(calculation);
  value.snapshotWatermark = digest(value);
  return value;
};
const makePreview = (version, amountCents, inputWatermark, projectionWatermark) => {
  const calculation = candidate(amountCents, inputWatermark, [{ employeeId, amountCents }]);
  return { period: { ...period, timezone: 'Asia/Yekaterinburg' }, sources: { readiness: { components: readiness },
    recognitionProjection: { projectionWatermark } }, candidateCalculation: calculation,
  candidateSnapshot: snapshot(version, calculation) };
};
const previews = [makePreview(versions[0], 2010, 'e'.repeat(64), 'd'.repeat(64)),
  makePreview(versions[1], 3015, '1'.repeat(64), 'f'.repeat(64))];
const result = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews });
assert.equal(result.status, 'scenario_ready');
assert.equal(result.candidateOnly, true);
assert.equal(result.officialReady, false);
assert.equal(result.nonPayable, true);
assert.equal(result.nonAccrual, true);
assert.equal(result.payoutEligible, false);
assert.equal(result.persistence, 'none');
assert.match(result.sharedSourceWatermark, /^[a-f0-9]{64}$/);
assert.equal(result.comparisons[1].deltaToBaselineCents, 1005);
assert.equal(result.comparisons[1].employeeDeltas[0].deltaCents, 1005);
assert.notEqual(result.comparisons[0].projectionWatermark, result.comparisons[1].projectionWatermark,
  'policy-derived projections may differ while their shared raw source fingerprint stays equal');
assert.equal(result.results[1].candidateSnapshot.snapshotWatermark, previews[1].candidateSnapshot.snapshotWatermark,
  'per-version snapshot watermark remains separate from shared raw-source watermark');
const tamperedSnapshot = structuredClone(previews);
tamperedSnapshot[1].candidateSnapshot.amountCents += 1;
const tamperedSnapshotComparison = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews: tamperedSnapshot });
assert.equal(tamperedSnapshotComparison.comparisons[1].amountCents, null,
  'well-shaped but invalid snapshot watermark blocks the version result');
assert.equal(tamperedSnapshotComparison.results[1].candidateSnapshot, null);

const blockedPreviews = structuredClone(previews);
blockedPreviews[1].candidateCalculation = candidate(null, null, [], 'blocked', ['unsupported_source']);
const blocked = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews: blockedPreviews });
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.comparisons[1].amountCents, null);
assert.equal(blocked.comparisons[1].deltaToBaselineCents, null,
  'blocked versions never become zero in a comparison');
assert.equal(blocked.comparisons[1].employeeDeltas, null);
assert.equal(blocked.results[1].candidateSnapshot, null, 'blocked candidate never exposes a snapshot');

const mismatchedSources = structuredClone(previews);
mismatchedSources[1].sources.readiness.components = structuredClone(mismatchedSources[1].sources.readiness.components);
mismatchedSources[1].sources.readiness.components.recognitionManifest.sourceWatermark = '9'.repeat(64);
const incomparable = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews: mismatchedSources });
assert.equal(incomparable.status, 'blocked');
assert.equal(incomparable.sharedSourceWatermark, null);
assert.equal(incomparable.comparisons[1].amountCents, null);
assert.equal(incomparable.comparisons[1].deltaToBaselineCents, null);
assert.ok(incomparable.results.every(item => item.candidateSnapshot === null), 'unshared sources suppress all candidate snapshots');
assert.ok(incomparable.comparisons[1].reasons.includes('comparison_common_source_watermark_unavailable'));

const unionSource = structuredClone(previews);
unionSource[1].candidateCalculation.requiredFacts.push('approvedAttendance');
unionSource[1].candidateSnapshot = snapshot(versions[1], unionSource[1].candidateCalculation);
unionSource[0].sources.readiness.components = { ...unionSource[0].sources.readiness.components };
unionSource[1].sources.readiness.components = { ...unionSource[1].sources.readiness.components,
  approvedAttendance: { sourceWatermark: '8'.repeat(64) } };
const unionComparison = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews: unionSource });
assert.equal(unionComparison.status, 'scenario_ready', 'a raw source needed by only one mode can be shared from the same database snapshot');
assert.match(unionComparison.sharedSourceWatermark, /^[a-f0-9]{64}$/);

const modeSpecificInput = structuredClone(previews);
modeSpecificInput[1].candidateCalculation.requiredFacts.push('approvedAttendance');
modeSpecificInput[1].candidateSnapshot = snapshot(versions[1], modeSpecificInput[1].candidateCalculation);
modeSpecificInput[0].sources.readiness.components = { ...modeSpecificInput[0].sources.readiness.components,
  approvedAttendance: { sourceWatermark: '8'.repeat(64) } };
modeSpecificInput[1].sources.readiness.components = { ...modeSpecificInput[1].sources.readiness.components,
  approvedAttendance: { sourceWatermark: '7'.repeat(64) } };
const attendanceMismatch = buildPayrollSourcedComparison({ venueId, currency: 'RUB', period,
  baselineVersionId: versions[0].versionId, versions, previews: modeSpecificInput });
assert.equal(attendanceMismatch.status, 'blocked', 'mode-specific source facts must share the same source watermark');
assert.equal(attendanceMismatch.sharedSourceWatermark, null);

console.log('PASS payroll-sourced-comparison-contract');
