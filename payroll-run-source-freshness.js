'use strict';

// Internal prerequisite, not a reusable authorization to post money. The caller
// owns authorization and holds the source fence before starting its RR snapshot.
// Future write transitions must call this again in their own fenced transaction.
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { buildPayrollVerifiedCalculation } = require('./payroll-verified-calculation');
const { buildPayrollRefundAwareCalculation, PAYROLL_REFUND_AWARE_CAPABILITY } = require('./payroll-refund-aware-calculation');
const { isDeepStrictEqual } = require('node:util');
const SHA = /^[a-f0-9]{64}$/;
const safeReasons = reasons => [...new Set((Array.isArray(reasons) ? reasons : [])
  .filter(reason => typeof reason === 'string' && /^[a-zA-Z0-9_]+$/.test(reason)))].sort();

const checkPayrollRunSourceFreshnessInTransaction = async (db, actor, runId, collectContext, collectRefundContext) => {
  const { header, evidence } = await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId);
  // The historical scheme is part of the saved calculation. A current scheme
  // name/status change must not silently replace it while checking its sources.
  const scheme = structuredClone(evidence.schemeSnapshot), period = { ...evidence.period };
  if (evidence.schemaVersion === 2 && evidence.capabilityVersion === PAYROLL_REFUND_AWARE_CAPABILITY) {
    if (typeof collectRefundContext !== 'function') throw Object.assign(new Error('payroll_saved_run_source_collector_required'),
      { code: 'payroll_saved_run_source_collector_required', status: 409 });
    const context = await collectRefundContext(db, actor, scheme, period);
    const current = context.status === 'source_arguments_collected' ? buildPayrollRefundAwareCalculation(context.sourceArgs) : context;
    const closure = context.sourceArgs?.periodClosure;
    const verified = current.status === 'refund_aware_calculated' && current.capabilityVersion === evidence.capabilityVersion
      && current.venueId === actor.venueId && current.schemeVersionId === evidence.schemeVersionId && current.currency === evidence.currency
      && current.period?.from === period.from && current.period?.to === period.to && SHA.test(current.inputWatermark || '');
    const sourceChanged = verified ? current.inputWatermark !== evidence.inputWatermark : null;
    const timezoneChanged = closure ? closure.timezone !== evidence.venueTimezone : false;
    const reasons = safeReasons(current.reasons);
    if (!verified && !reasons.length) reasons.push('payroll_saved_run_source_unverified');
    if (timezoneChanged) reasons.push('payroll_saved_run_timezone_changed');
    if (sourceChanged) reasons.push('payroll_saved_run_source_changed');
    const before = evidence.sourceEvidence, after = current.input?.sourceEvidence || {};
    const changedFacts = verified ? [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .filter(key => !isDeepStrictEqual(before[key] ?? null, after[key] ?? null)) : [];
    // Even a blocked source has a transaction timestamp; never substitute wall
    // clock time or an old saved closure for the current database inspection.
    const checkedAt = closure?.transactionTimestamp || (await db.query('SELECT transaction_timestamp()::text AS "checkedAt"')).rows[0]?.checkedAt;
    return { schemaVersion: 1, runId: header.runId, status: !verified ? 'blocked' : sourceChanged || timezoneChanged ? 'stale' : 'current',
      sourceChanged, checkedAt, validity: 'transaction_snapshot_only', changedFacts, reasons: safeReasons(reasons),
      officialReady: false, payoutEligible: false, persistence: 'none' };
  }
  const context = await collectContext(db, actor, scheme, period);
  const current = buildPayrollVerifiedCalculation({ venueId: actor.venueId, scheme, period,
    readiness: context.evidence.readiness, attestations: context.attestations,
    sourceBundle: context.calculationSourceBundle, periodClosure: context.periodClosure });
  const watermark = context.calculationSourceBundle?.inputWatermark;
  const sourceChanged = SHA.test(watermark || '') ? watermark !== evidence.inputWatermark : null;
  const timezoneChanged = context.venueTimezone !== evidence.venueTimezone;
  const verified = current.status === 'verified_calculation' && current.capabilityVersion === evidence.capabilityVersion
    && current.schemeVersionId === evidence.schemeVersionId && current.currency === evidence.currency
    && current.period?.from === period.from && current.period?.to === period.to
    && SHA.test(current.inputWatermark || '') && current.inputWatermark === watermark;
  const reasons = safeReasons(current.reasons);
  if (!verified && !reasons.length) reasons.push('payroll_saved_run_source_unverified');
  if (timezoneChanged) reasons.push('payroll_saved_run_timezone_changed');
  if (sourceChanged === true) reasons.push('payroll_saved_run_source_changed');
  const status = !verified ? 'blocked' : sourceChanged || timezoneChanged ? 'stale' : 'current';
  const before = evidence.sourceEvidence, after = current.input?.sourceEvidence || {};
  const changedFacts = verified ? [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(key => before[key]?.sourceWatermark !== after[key]?.sourceWatermark
      || before[key]?.watermarkScope !== after[key]?.watermarkScope) : [];
  return { schemaVersion: 1, runId: header.runId, status, sourceChanged,
    checkedAt: context.periodClosure.transactionTimestamp, validity: 'transaction_snapshot_only',
    changedFacts, reasons: safeReasons(reasons), officialReady: false, payoutEligible: false, persistence: 'none' };
};

module.exports = { checkPayrollRunSourceFreshnessInTransaction };
