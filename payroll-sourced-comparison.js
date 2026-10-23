'use strict';

const { createHash } = require('node:crypto');
const { verifyPayrollCandidateSnapshotBundle } = require('./payroll-candidate-snapshot-bundle');

const SHA256 = /^[a-f0-9]{64}$/;
const SHARED_RAW_FACTS = new Set(['canonicalLinePricing', 'recognitionManifest', 'employeeEligibility',
  'approvedAttendance', 'immutableDepartmentAttribution', 'venueDailyTurnover',
  'closedMonthCoverage', 'departmentShiftAllocation', 'marginCosts', 'teamMembershipAndWeights']);
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const MAX_COMPARISON_SNAPSHOT_LINES = 20000;

const buildPayrollSourcedComparison = ({ venueId, currency, period, baselineVersionId, versions, previews }) => {
  if (!venueId || !currency || !period || !Array.isArray(versions) || versions.length < 2
      || !Array.isArray(previews) || previews.length !== versions.length) {
    throw new TypeError('payroll_sourced_comparison_input_invalid');
  }
  const factWatermark = (preview, fact) => {
    if (fact === 'venueDailyTurnover') return preview.sources?.venueDailyTurnover?.sourceWatermark || null;
    if (fact === 'immutableDepartmentAttribution') return preview.sources?.departmentAttribution?.sourceWatermark
      || preview.sources?.readiness?.components?.[fact]?.sourceWatermark || null;
    return preview.sources?.readiness?.components?.[fact]?.sourceWatermark || null;
  };
  const rawKeys = [...new Set(previews.flatMap(preview => preview.candidateCalculation?.requiredFacts || [])
    .filter(fact => SHARED_RAW_FACTS.has(fact)))].sort();
  const rawSourcesByVersion = previews.map(preview => Object.fromEntries(rawKeys.map(key => [key, factWatermark(preview, key)])));
  const rawSources = Object.fromEntries(rawKeys.map(key => {
    const provided = rawSourcesByVersion.map(sources => sources[key]).filter(value => value !== null);
    return [key, provided[0] || null];
  }));
  const timezone = previews[0]?.period?.timezone || null;
  const commonSourceAvailable = Boolean(timezone)
    && rawKeys.length > 0 && rawKeys.every(key => SHA256.test(rawSources[key] || '')
      && rawSourcesByVersion.every(sources => sources[key] === null || sources[key] === rawSources[key]))
    && previews.every(preview => preview.period?.timezone === timezone
      && preview.period?.from === period.from && preview.period?.to === period.to);
  const sharedSourceWatermark = commonSourceAvailable ? digest({ schemaVersion: 1, venueId, currency, period, timezone, rawSources }) : null;
  const baselineIndex = versions.findIndex(version => version.versionId === baselineVersionId);
  if (baselineIndex < 0) throw new TypeError('payroll_sourced_comparison_baseline_invalid');
  const comparisonSnapshotLines = previews.reduce((sum, preview) => sum
    + (preview?.candidateSnapshot?.lines?.length || 0)
    + (preview?.candidateSnapshot?.employeeDays?.length || 0)
    + (preview?.candidateSnapshot?.days?.length || 0), 0);
  const comparisonSnapshotWithinBudget = comparisonSnapshotLines <= MAX_COMPARISON_SNAPSHOT_LINES;
  const hasBoundCandidateSnapshot = (preview, version, candidate) => {
    const snapshot = preview?.candidateSnapshot;
    return snapshot?.schemaVersion === 1 && snapshot.snapshotKind === 'candidate_preview'
      && snapshot.candidateOnly === true && snapshot.officialReady === false && snapshot.payoutEligible === false
      && snapshot.nonPayable === true && snapshot.nonAccrual === true && snapshot.persistence === 'none'
      && snapshot.venueId === venueId && snapshot.currency === currency
      && snapshot.schemeVersionId === version.versionId && snapshot.schemeId === version.id
      && snapshot.amountCents === candidate?.amountCents && snapshot.source?.inputWatermark === candidate?.inputWatermark
      && verifyPayrollCandidateSnapshotBundle({ snapshot, candidateCalculation: candidate })
      && snapshot.period?.from === period.from && snapshot.period?.to === period.to
      && snapshot.period?.timezone === preview?.period?.timezone;
  };
  const baseline = previews[baselineIndex]?.candidateCalculation;
  const baselineReady = commonSourceAvailable && comparisonSnapshotWithinBudget && baseline?.status === 'scenario_ready'
    && hasBoundCandidateSnapshot(previews[baselineIndex], versions[baselineIndex], baseline);
  const baselineEmployees = new Map((baseline?.employees || []).map(row => [row.employeeId, row.amountCents]));
  const comparisons = versions.map((version, index) => {
    const preview = previews[index];
    const candidate = preview?.candidateCalculation;
    const ready = commonSourceAvailable && comparisonSnapshotWithinBudget && candidate?.status === 'scenario_ready'
      && hasBoundCandidateSnapshot(preview, version, candidate);
    const employees = new Map((candidate?.employees || []).map(row => [row.employeeId, row.amountCents]));
    const employeeIds = [...new Set([...employees.keys(), ...baselineEmployees.keys()])].sort();
    const employeeDeltas = ready && baselineReady ? employeeIds.map(employeeId => {
      const hasCurrent = employees.has(employeeId), hasBaseline = baselineEmployees.has(employeeId);
      return { employeeId, status: hasCurrent && hasBaseline ? 'comparable' : 'identity_uncovered',
        amountCents: hasCurrent ? employees.get(employeeId) : null,
        baselineAmountCents: hasBaseline ? baselineEmployees.get(employeeId) : null,
        deltaCents: hasCurrent && hasBaseline ? employees.get(employeeId) - baselineEmployees.get(employeeId) : null };
    }) : null;
    return { versionId: version.versionId, schemeId: version.id, versionNo: version.versionNo,
      name: version.name, mode: version.mode, status: ready ? 'scenario_ready' : 'blocked',
      candidateStatus: candidate?.status || 'blocked', amountCents: ready ? candidate.amountCents : null,
      deltaToBaselineCents: ready && baselineReady ? candidate.amountCents - baseline.amountCents : null,
      inputWatermark: candidate?.inputWatermark || null,
      projectionWatermark: preview?.sources?.recognitionProjection?.projectionWatermark || null,
      reasons: [...new Set([...(candidate?.reasons || []), ...(!commonSourceAvailable ? ['comparison_common_source_watermark_unavailable'] : []),
        ...(commonSourceAvailable && candidate?.status === 'scenario_ready' && !hasBoundCandidateSnapshot(preview, version, candidate)
          ? ['comparison_candidate_snapshot_unavailable'] : []),
        ...(!comparisonSnapshotWithinBudget ? ['comparison_candidate_snapshot_line_limit_exceeded'] : [])])].sort(),
      employeeDeltas };
  });
  const results = versions.map((version, index) => {
    const preview = previews[index];
    const candidate = preview?.candidateCalculation;
    const candidateSnapshot = commonSourceAvailable && comparisonSnapshotWithinBudget && candidate?.status === 'scenario_ready'
      && hasBoundCandidateSnapshot(preview, version, candidate)
      ? preview.candidateSnapshot : null;
    return { versionId: version.versionId, candidateSnapshot };
  });
  return { schemaVersion: 1, comparisonKind: 'sourced_candidate', status: commonSourceAvailable
    && comparisons.every(item => item.status === 'scenario_ready') ? 'scenario_ready' : 'blocked',
  candidateOnly: true, nonPayable: true, nonAccrual: true, payoutEligible: false, officialReady: false,
  persistence: 'none', period: { ...period, timezone }, currency,
  baselineVersionId, sharedSourceWatermark, comparisons, results };
};

module.exports = { buildPayrollSourcedComparison };
