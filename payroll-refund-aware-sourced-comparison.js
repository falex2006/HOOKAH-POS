'use strict';

// Read-only candidate comparison envelope. It carries no posting authority.
const { createHash } = require('node:crypto');
const { verifyPayrollCandidateSnapshotBundle } = require('./payroll-candidate-snapshot-bundle');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value === undefined ? 'null' : canonical(value)).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const fail = suffix => { throw Object.assign(new TypeError(`payroll_refund_aware_comparison_${suffix}`),
  { code: `payroll_refund_aware_comparison_${suffix}` }); };
const safeAmount = value => Number.isSafeInteger(value) && value >= 0;
const employeeRowsValid = (rows, total) => Array.isArray(rows) && rows.length <= 500
  && rows.every(row => plain(row) && UUID.test(String(row.employeeId || '')) && safeAmount(row.amountCents))
  && new Set(rows.map(row => row.employeeId.toLowerCase())).size === rows.length
  && rows.reduce((sum, row) => sum + BigInt(row.amountCents), 0n) === BigInt(total);

function buildPayrollRefundAwareSourcedComparison({ venueId, currency, period, baselineVersionId, versions, policies,
  calculations, candidateRawBindings = [], commonSource, commonFailure } = {}) {
  if (!UUID.test(venueId || '') || !/^[A-Z]{3}$/.test(currency || '') || !plain(period) || !date(period.from) || !date(period.to)
      || period.from > period.to || period.from.slice(0, 7) !== period.to.slice(0, 7)
      || !Array.isArray(versions) || versions.length < 2 || versions.length > 8
      || !Array.isArray(policies) || policies.length !== versions.length
      || !Array.isArray(calculations) || calculations.length !== versions.length
      || !versions.some(row => row?.versionId === baselineVersionId)) fail('input_invalid');
  const sourceIdentity = commonSource && !commonFailure && commonSource.venueId === venueId && commonSource.currency === currency
    && commonSource.period?.from === period.from && commonSource.period?.to === period.to
    && typeof commonSource.timezone === 'string' && commonSource.timezone.trim()
    && SHA.test(commonSource.recognitionManifestWatermark || '') && SHA.test(commonSource.economicsSourceWatermark || '')
    && SHA.test(commonSource.eligibilityWatermark || '');
  const sharedSourceWatermark = sourceIdentity ? digest({ schemaVersion: 2, venueId, currency, period,
    timezone: commonSource.timezone, recognitionManifestWatermark: commonSource.recognitionManifestWatermark,
    economicsSourceWatermark: commonSource.economicsSourceWatermark, eligibilityWatermark: commonSource.eligibilityWatermark,
    optionalRawWatermarks: commonSource.optionalRawWatermarks || {} }) : null;
  const baselineIndex = versions.findIndex(row => row.versionId === baselineVersionId);
  const baseRows = versions.map((scheme, index) => {
    const policy = policies[index], calc = calculations[index] || {};
    const rawBindings = candidateRawBindings[index] || null;
    const family = policy?.schemaVersion === 2 ? 'refund_aware_v2' : 'legacy_v1';
    const v2Employees = (calc.engineResult?.employees || []).map(row => ({ employeeId: row.employeeId || row.id,
      ...(typeof (row.employeeName || row.name) === 'string' ? { name: row.employeeName || row.name } : {}), amountCents: row.amountCents }));
    const legacyEmployees = (calc.legacyPreview?.candidateCalculation?.employees || []).map(row => ({ employeeId: row.employeeId || row.id,
      ...(typeof (row.employeeName || row.name) === 'string' ? { name: row.employeeName || row.name } : {}), amountCents: row.amountCents }));
    const v2Candidate = family === 'refund_aware_v2' && calc.status === 'refund_aware_calculated'
      && calc.officialReady === false && calc.payoutEligible === false && calc.sourceAttested === false
      && calc.persistence === 'none' && safeAmount(calc.amountCents) && SHA.test(calc.inputWatermark || '')
      && SHA.test(calc.calculationWatermark || '') && calc.venueId === venueId && calc.schemeVersionId === scheme.versionId
      && calc.currency === currency && calc.period?.from === period.from && calc.period?.to === period.to
      && employeeRowsValid(v2Employees, calc.amountCents);
    const legacyCandidate = family === 'legacy_v1' && calc.legacyPreview?.candidateCalculation;
    const legacySnapshot = calc.legacyPreview?.candidateSnapshot;
    const calcCopy = plain(calc) ? { ...calc } : {};
    delete calcCopy.calculationWatermark;
    const commonCalculationBound = sourceIdentity && calc.input?.sourceEvidence?.recognitionManifest?.sourceWatermark
      === commonSource.recognitionManifestWatermark && calc.economics?.sourceWatermark === commonSource.economicsSourceWatermark
      && calc.input?.sourceEvidence?.remainingMerchandise?.sourceWatermark === commonSource.economicsSourceWatermark
      && calc.input?.sourceEvidence?.employmentEligibility?.sourceWatermark === commonSource.eligibilityWatermark
      && (!commonSource.optionalRawWatermarks?.approvedAttendance
        || !calc.input?.sourceEvidence?.approvedAttendance
        || calc.input.sourceEvidence.approvedAttendance.sourceWatermark === commonSource.optionalRawWatermarks.approvedAttendance)
      && (!calc.input?.sourceEvidence?.department || calc.input.sourceEvidence.department.sourceWatermark === calc.department?.sourceWatermark)
      && (!calc.input?.sourceEvidence?.frozenDepletionCost
        || calc.input.sourceEvidence.frozenDepletionCost.sourceWatermark === calc.costs?.sourceWatermark)
      && (policy?.schemaVersion !== 2 || !calc.requiredFacts?.includes('immutableDepartmentAttribution')
        || (rawBindings?.departmentMappingRevision === commonSource.optionalRawWatermarks?.departmentMappingRevision
          && calc.department?.coverage?.mappingSourceWatermark === rawBindings?.departmentMappingRevision))
      && (policy?.schemaVersion !== 2 || !calc.requiredFacts?.includes('marginCosts')
        || (plain(rawBindings?.frozenSaleCostByOrder)
          && canonical(rawBindings.frozenSaleCostByOrder) === canonical(Object.fromEntries(
            calc.costs?.coverage?.producerWatermarks?.map(row => [row.orderId, row.watermark]) || []))
          && Object.entries(rawBindings.frozenSaleCostByOrder).every(([orderId, watermark]) =>
            commonSource.optionalRawWatermarks?.frozenSaleCostByOrder?.[orderId] === watermark)))
      && calc.input?.periodFrom === period.from && calc.input?.periodTo === period.to
      && canonical(calc.input?.scheme) === canonical(scheme)
      && calc.periodClosure?.venueId === venueId && calc.periodClosure?.period?.from === period.from
      && calc.periodClosure?.period?.to === period.to && calc.periodClosure?.timezone === commonSource.timezone;
    const required = Array.isArray(calc.requiredFacts) ? calc.requiredFacts : [];
    let expectedRequired = [];
    try { expectedRequired = buildPayrollModeAvailability({}, {}, scheme, period)[scheme.mode]?.requiredFacts || []; } catch (_) { /* invalid scheme blocks below */ }
    const requiredFactsExact = expectedRequired.length > 0 && canonical(required.slice().sort()) === canonical(expectedRequired.slice().sort());
    const factWatermarks = {
      sourcePolicies: digest(scheme.sourcePolicies),
      canonicalLinePricing: calc.input?.sourceEvidence?.recognitionManifest?.sourceWatermark,
      payrollSaleCredit: calc.input?.sourceEvidence?.recognitionManifest?.sourceWatermark,
      recognitionManifest: calc.input?.sourceEvidence?.recognitionManifest?.sourceWatermark,
      recognizedLineRefunds: calc.input?.sourceEvidence?.remainingMerchandise?.sourceWatermark,
      fullEmployeeNetRevenue: calc.input?.personalRevenueSource?.sourceWatermark,
      employeeEligibility: calc.input?.sourceEvidence?.employmentEligibility?.sourceWatermark,
      employeeRoleCoverage: calc.input?.sourceEvidence?.roleCoverage?.sourceWatermark,
      approvedAttendance: calc.input?.sourceEvidence?.approvedAttendance?.sourceWatermark,
      immutableDepartmentAttribution: calc.department?.sourceWatermark,
      venueDailyTurnover: calc.economics?.sourceWatermark,
      closedMonthCoverage: calc.economics?.sourceWatermark,
      departmentShiftAllocation: calc.team?.departmentShiftAllocation?.sourceWatermark,
      teamMembershipAndWeights: calc.team?.teamMembershipAndWeights?.sourceWatermark,
      marginCosts: calc.costs?.sourceWatermark
    };
    const requiredFactsBound = requiredFactsExact && required.length > 0 && required.every(fact => SHA.test(factWatermarks[fact] || ''));
    const v2Ready = Boolean(v2Candidate && commonCalculationBound && digest(calc.input) === calc.inputWatermark
      && digest(calcCopy) === calc.calculationWatermark && requiredFactsBound);
    const legacyReady = Boolean(legacyCandidate?.status === 'scenario_ready' && legacyCandidate.officialReady === false
      && legacyCandidate.payoutEligible === false && legacyCandidate.candidateOnly === true && legacyCandidate.nonPayable === true
      && legacyCandidate.nonAccrual === true && legacySnapshot?.schemaVersion === 1 && legacySnapshot.candidateOnly === true
      && legacySnapshot.officialReady === false && legacySnapshot.payoutEligible === false && legacySnapshot.persistence === 'none'
      && safeAmount(legacyCandidate.amountCents) && SHA.test(legacyCandidate.inputWatermark || '')
      && SHA.test(legacySnapshot.snapshotWatermark || '') && legacySnapshot.venueId === venueId
      && legacyCandidate.schemeVersionId === scheme.versionId && legacySnapshot.schemeId === scheme.id
      && legacySnapshot.schemeVersionId === scheme.versionId && legacySnapshot.currency === currency
      && legacySnapshot.period?.from === period.from && legacySnapshot.period?.to === period.to
      && legacySnapshot.period?.timezone === commonSource.timezone
      && legacySnapshot.source?.inputWatermark === legacyCandidate.inputWatermark
      && legacySnapshot.source?.recognitionWatermark === commonSource.recognitionManifestWatermark
      && legacySnapshot.amountCents === legacyCandidate.amountCents
      && verifyPayrollCandidateSnapshotBundle({ snapshot: legacySnapshot, candidateCalculation: legacyCandidate })
      && employeeRowsValid(legacyEmployees, legacyCandidate.amountCents));
    const ready = sourceIdentity && (v2Ready || legacyReady);
    const sourceWatermarks = v2Ready ? {
      recognitionManifest: calc.input?.sourceEvidence?.recognitionManifest?.sourceWatermark || null,
      economics: calc.economics?.sourceWatermark || null,
      eligibility: calc.input?.sourceEvidence?.employmentEligibility?.sourceWatermark || null,
      attendance: calc.input?.sourceEvidence?.approvedAttendance?.sourceWatermark || null,
      department: required.includes('immutableDepartmentAttribution')
        ? commonSource.optionalRawWatermarks?.departmentMappingRevision || null : null,
      frozenDepletionCost: required.includes('marginCosts')
        ? commonSource.optionalRawWatermarks?.frozenDepletionCost || null : null,
      team: calc.team?.sourceWatermark || null
    } : legacyReady ? {
      recognitionManifest: calc.legacyPreview.sources?.readiness?.components?.recognitionManifest?.sourceWatermark || null,
      canonicalLinePricing: calc.legacyPreview.sources?.readiness?.components?.canonicalLinePricing?.sourceWatermark || null,
      approvedAttendance: calc.legacyPreview.sources?.readiness?.components?.approvedAttendance?.sourceWatermark || null,
      venueDailyTurnover: calc.legacyPreview.sources?.venueDailyTurnover?.sourceWatermark || null,
      marginCosts: calc.legacyPreview.sources?.readiness?.components?.marginCosts?.sourceWatermark || null,
      department: calc.legacyPreview.sources?.departmentAttribution?.sourceWatermark || null
    } : {};
    const employeeRows = v2Ready ? v2Employees : legacyReady ? legacyEmployees : [];
    let reasons = ready ? [] : [...new Set([...(Array.isArray(calc.reasons) ? calc.reasons : []),
      ...(commonFailure ? [commonFailure] : !sourceIdentity ? ['payroll_refund_aware_common_source_unavailable'] : []),
      ...(!v2Ready && !legacyReady && family === 'legacy_v1' && !calc.reasons?.length ? ['payroll_legacy_candidate_unavailable'] : [])])].sort();
    if (!ready && family === 'refund_aware_v2' && calc.status !== 'blocked' && !calc.reasons?.length) reasons.push('payroll_refund_aware_candidate_unavailable');
    const amountCents = ready ? (v2Ready ? calc.amountCents : legacyCandidate.amountCents) : null;
    const inputWatermark = ready ? (v2Ready ? calc.inputWatermark : legacyCandidate.inputWatermark) : null;
    const calculationWatermark = ready ? digest(v2Ready ? { schemaVersion: 2, schemeVersionId: scheme.versionId,
      inputWatermark: calc.inputWatermark, engineResult: calc.engineResult, sourceWatermarks }
      : { schemaVersion: 1, schemeVersionId: scheme.versionId, inputWatermark: legacyCandidate.inputWatermark,
        snapshotWatermark: legacySnapshot.snapshotWatermark, sourceWatermarks }) : null;
    const candidateEvidence = ready ? v2Ready ? {
      schemaVersion: 2, venueId, schemeVersionId: scheme.versionId,
      period: { from: period.from, to: period.to, timezone: commonSource.timezone }, currency, sharedSourceWatermark,
      amountCents, inputWatermark, calculationWatermark,
      candidateOnly: true, nonPayable: true, nonAccrual: true, officialReady: false, payoutEligible: false,
      sourceAttested: false, persistence: 'none'
    } : {
      schemaVersion: 1, venueId, schemeVersionId: scheme.versionId,
      period: { from: period.from, to: period.to, timezone: commonSource.timezone }, currency, sharedSourceWatermark,
      amountCents, inputWatermark, calculationWatermark, snapshotWatermark: legacySnapshot.snapshotWatermark,
      candidateOnly: true, nonPayable: true, nonAccrual: true, officialReady: false, payoutEligible: false,
      sourceAttested: false, persistence: 'none'
    } : null;
    return { versionId: scheme.versionId, schemeId: scheme.id, name: scheme.name, versionNo: scheme.versionNo,
      mode: scheme.mode, policyFamily: family, status: ready ? 'ready' : 'blocked', reasons,
      amountCents, inputWatermark, sourceWatermarks, employees: employeeRows, candidateEvidence,
      deltaCents: null, employeeDeltas: null };
  });
  const baseline = baseRows[baselineIndex];
  const comparisonBasis = index => {
    const policy = policies[index];
    if (!policy) return null;
    return policy.schemaVersion === 2
      ? { schemaVersion: 2, saleCredit: policy.saleCredit, discountAllocation: policy.discountAllocation,
        refunds: policy.refunds, earnings: policy.earnings }
      : { schemaVersion: 1, saleCredit: policy.saleCredit, discountAllocation: policy.discountAllocation, refunds: policy.refunds };
  };
  const basisByVersion = new Map(versions.map((_, index) => [versions[index].versionId, comparisonBasis(index)]));
  const sourceCompatible = (left, right) => {
    const leftKeys = Object.keys(left.sourceWatermarks || {}).filter(key => left.sourceWatermarks[key] !== null);
    const rightKeys = Object.keys(right.sourceWatermarks || {}).filter(key => right.sourceWatermarks[key] !== null);
    const rawKeys = new Set(['recognitionManifest', 'canonicalLinePricing', 'approvedAttendance',
      'approvedAttendanceSource', 'venueDailyTurnover', 'frozenDepletionCost']);
    const keys = leftKeys.filter(key => rightKeys.includes(key) && rawKeys.has(key));
    return keys.every(key => left.sourceWatermarks[key] === right.sourceWatermarks[key]);
  };
  for (const row of baseRows) {
    if (!row || row.status !== 'ready' || baseline.status !== 'ready'
        || row.policyFamily !== baseline.policyFamily || !sourceIdentity
        || canonical(basisByVersion.get(row.versionId)) !== canonical(basisByVersion.get(baselineVersionId))
        || !sourceCompatible(row, baseline)) continue;
    row.deltaCents = row.amountCents - baseline.amountCents;
    const candidateEmployees = new Map(row.employees.map(item => [item.employeeId, item]));
    const baselineEmployees = new Map(baseline.employees.map(item => [item.employeeId, item]));
    const ids = [...new Set([...candidateEmployees.keys(), ...baselineEmployees.keys()])].sort();
    row.employeeDeltas = ids.map(employeeId => {
      const current = candidateEmployees.get(employeeId), prior = baselineEmployees.get(employeeId);
      if (!current || !prior || !safeAmount(current.amountCents) || !safeAmount(prior.amountCents)) return {
        employeeId, status: 'identity_uncovered', amountCents: current?.amountCents ?? null,
        baselineAmountCents: prior?.amountCents ?? null, deltaCents: null
      };
      return { employeeId, status: 'comparable', amountCents: current.amountCents,
        baselineAmountCents: prior.amountCents, deltaCents: current.amountCents - prior.amountCents };
    });
  }
  const snapshotSize = baseRows.reduce((total, row) => total + row.employees.length, 0);
  if (snapshotSize > 20000) fail('detail_limit_exceeded');
  return { schemaVersion: 2, comparisonKind: 'sourced_candidate_v2', candidateOnly: true, nonPayable: true,
    nonAccrual: true, officialReady: false, payoutEligible: false, persistence: 'none', venueId, currency,
    period: { from: period.from, to: period.to, timezone: sourceIdentity ? commonSource.timezone : null }, baselineVersionId, sharedSourceWatermark,
    sharedSource: sourceIdentity ? { ...commonSource, sourceWatermark: sharedSourceWatermark } : null,
    results: baseRows };
}

module.exports = { buildPayrollRefundAwareSourcedComparison };
