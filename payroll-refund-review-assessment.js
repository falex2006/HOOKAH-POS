'use strict';

// A saved-calculation review, never an accrual, debt or permission to deduct.
// The caller owns owner authorization and the fenced write snapshot throughout.
const { createHash } = require('node:crypto');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { readPayrollRecognitionManifestInTransaction } = require('./payroll-recognition-manifest');
const { executeCalculatorReplay, getCalculatorReplayEngineManifest } = require('./payroll-calculator-replay');
const { resolveRoleParameters } = require('./payroll-schemes');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const POLICY = 'saved-run-refund-review-v1';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('payroll_refund_review_json_invalid');
};
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const safe = value => Number.isSafeInteger(value) && value >= 0;
const integer = value => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) return null;
  const result = BigInt(value); return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
};
const money = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) return null;
  const [whole, fraction] = value.split('.');
  return integer(String(BigInt(whole) * 100n + BigInt(fraction)));
};
const rounded = (amount, rate) => (BigInt(amount) * BigInt(rate) + 5000n) / 10000n;
const sorted = rows => rows.slice().sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
const codes = rows => [...new Set(rows.filter(row => typeof row === 'string' && /^[a-zA-Z0-9_]+$/.test(row)))].sort();

const buildPayrollRefundReviewAssessment = ({ header, evidence, provenanceSha256, manifest, snapshotLines, refundRows }) => {
  if (!header || !evidence || !UUID.test(header.runId || '') || !UUID.test(evidence.venueId || '')
      || header.runId !== evidence.runId || !SHA.test(provenanceSha256 || '')
      || digest(evidence) !== provenanceSha256 || !Array.isArray(snapshotLines) || !Array.isArray(refundRows)) {
    throw new TypeError('payroll_refund_review_saved_context_invalid');
  }
  const reasons = [];
  const add = reason => reasons.push(reason);
  let replay;
  try { replay = executeCalculatorReplay(evidence.calculatorReplay); }
  catch (_) { add('payroll_refund_review_replay_invalid'); }
  if (!replay?.matched) add('payroll_refund_review_replay_unavailable');
  const input = evidence.calculatorReplay?.input, result = replay?.result;
  if (input && (canonical(input.scheme) !== canonical(evidence.schemeSnapshot)
      || input.periodFrom !== evidence.period.from || input.periodTo !== evidence.period.to)) {
    add('payroll_refund_review_replay_context_mismatch');
  }
  const coverage = manifest?.relatedRefundCoverage;
  if (manifest?.status !== 'available' || manifest.venueId !== evidence.venueId || manifest.currency !== evidence.currency
      || manifest.period?.from !== evidence.period.from || manifest.period?.to !== evidence.period.to
      || coverage?.status !== 'complete' || coverage.sourceWatermark !== manifest.watermark || !SHA.test(manifest.watermark || '')) {
    add('payroll_refund_review_source_coverage_incomplete');
    reasons.push(...(manifest?.reasons || []));
  }
  const saleById = new Map((manifest?.saleLines || []).map(line => [line.saleLineEventId, line]));
  const inputSales = new Map((input?.sales || []).map(line => [line.id, line]));
  const calculated = new Map();
  for (const day of result?.daily || []) for (const line of day.lines || []) calculated.set(line.lineId, { day, line });
  const originals = new Map(), identities = new Map();
  for (const row of snapshotLines) {
    const original = saleById.get(row.originalSaleLineEventId), sale = inputSales.get(row.originalSaleLineEventId);
    const calculation = calculated.get(row.originalSaleLineEventId);
    // Historical identity remains independently provable even when the saved
    // engine implementation is unavailable. It never grants numerical proof.
    if (!original || row.venueId !== evidence.venueId || row.runId !== evidence.runId
        || !UUID.test(row.id || '') || !UUID.test(row.snapshotId || '') || identities.has(row.orderItemId)
        || row.orderId !== original.orderId || row.orderItemId !== original.orderItemId
        || row.originalSaleEventId !== original.saleEventId || row.pricingSnapshotId !== original.snapshotId
        || row.pricingLineId !== original.pricingLineId || row.employeeId !== original.sellerId
        || row.localDate !== original.recognizedLocalDate || money(row.commissionBase) !== original.netMinor
        || !coverage?.coveredOrderIds?.includes(row.orderId)) {
      add('payroll_refund_review_original_line_mismatch'); continue;
    }
    identities.set(row.orderItemId, { row, original });
    if (!sale || !calculation || row.employeeId !== sale.employeeId || row.localDate !== sale.date
        || sale.menuItemId !== original.productFacts?.productId
        || money(row.commissionBase) !== sale.commissionBaseCents || original.netMinor !== sale.commissionBaseCents
        || money(row.commissionAmount) !== calculation.line.commissionCents
        || calculation.line.employeeId !== row.employeeId || calculation.line.commissionBaseCents !== sale.commissionBaseCents
        || !coverage?.coveredOrderIds?.includes(row.orderId)) {
      add('payroll_refund_review_original_line_mismatch'); continue;
    }
    originals.set(row.orderItemId, { row, original, sale, ...calculation });
  }
  const periodSales = [...inputSales.values()].filter(row => row.date >= evidence.period.from && row.date <= evidence.period.to);
  if (originals.size !== snapshotLines.length || originals.size !== periodSales.length) add('payroll_refund_review_original_line_coverage_incomplete');
  if (!result || (result.modes || [result.mode]).some(mode => !['stable_percent', 'percent_only'].includes(mode))) {
    add('payroll_refund_review_nonlinear_mode_unsupported');
  }
  for (const day of result?.daily || []) for (const employee of day.employees || []) {
    const params = resolveRoleParameters(evidence.schemeSnapshot, employee.employeeId, employee.roleId, day.date);
    if (!params || !['stable_percent', 'percent_only'].includes(params.mode || evidence.schemeSnapshot.mode)
        || params.cap || employee.capCents !== null || employee.capReductionCents !== 0
        || employee.teamFundCents !== 0 || employee.milestoneBonusCents !== 0
        || (evidence.schemeSnapshot.applyMilestones !== false && Object.values(params.milestoneBonusesCents || {}).some(amount => amount !== 0))) {
      add('payroll_refund_review_nonlinear_components_unsupported');
    }
  }
  const cohort = new Set(snapshotLines.map(row => row.orderId));
  const ids = new Set(), eventIds = new Set(), itemIds = new Set(), eventLineIds = new Set();
  const lines = [];
  for (const row of sorted(refundRows)) {
    ids.add(row.refundId); eventIds.add(row.refundEventId);
    if (row.refundItemId) itemIds.add(row.refundItemId);
    if (row.refundLineEventId) eventLineIds.add(row.refundLineEventId);
  }
  const equalIds = (actual, expected) => Array.isArray(expected) && actual.size === expected.length
    && expected.every(id => UUID.test(id || '') && actual.has(id));
  if (!equalIds(ids, coverage?.relatedRefundHeaderIds) || !equalIds(eventIds, coverage?.relatedRefundEventIds)
      || !equalIds(itemIds, coverage?.relatedRefundItemIds) || !equalIds(eventLineIds, coverage?.relatedRefundLineEventIds)) {
    add('payroll_refund_review_all_time_coverage_mismatch');
  }
  const seenItems = new Set(), seenEventLines = new Set();
  for (const row of sorted(refundRows).filter(row => cohort.has(row.orderId))) {
    const original = identities.get(row.orderItemId);
    const local = [];
    if (row.venueId !== evidence.venueId || !cohort.has(row.orderId) || !UUID.test(row.refundId || '')
        || !UUID.test(row.refundEventId || '') || !coverage?.relatedRefundHeaderIds?.includes(row.refundId)
        || !coverage?.relatedRefundEventIds?.includes(row.refundEventId)) local.push('payroll_refund_review_refund_header_mismatch');
    if (!row.refundItemId) local.push('payroll_refund_review_refund_item_unavailable');
    else {
      if (seenItems.has(row.refundItemId) || seenEventLines.has(row.refundLineEventId)
          || !coverage?.relatedRefundItemIds?.includes(row.refundItemId)
          || !coverage?.relatedRefundLineEventIds?.includes(row.refundLineEventId)) local.push('payroll_refund_review_refund_item_coverage_mismatch');
      seenItems.add(row.refundItemId); seenEventLines.add(row.refundLineEventId);
    }
    if (!original || row.originalSaleLineEventId !== original.row.originalSaleLineEventId
        || row.originalSaleEventId !== original.row.originalSaleEventId || row.orderId !== original.row.orderId
        || row.pricingSnapshotId !== original.row.pricingSnapshotId) local.push('payroll_refund_review_refund_lineage_mismatch');
    const returned = integer(row.returnedItemValueMinor), previous = integer(row.previousReturnedItemValueMinor), cumulative = integer(row.cumulativeReturnedItemValueMinor);
    const sequence = integer(row.producerSequence);
    if (returned === null || previous === null || cumulative === null || sequence === null || sequence < 1
        || BigInt(previous || 0) + BigInt(returned || 0) !== BigInt(cumulative || 0)) local.push('payroll_refund_review_return_amount_invalid');
    lines.push({ sourceSnapshotLineId: original?.row.id || null, sourceSnapshotId: original?.row.snapshotId || null,
      employeeId: original?.row.employeeId || null, employeeName: original?.row.employeeName || null,
      menuItemName: original?.row.menuItemName || null, orderId: row.orderId, orderItemId: row.orderItemId || null,
      originalSaleEventId: row.originalSaleEventId || null, originalSaleLineEventId: row.originalSaleLineEventId || null,
      pricingSnapshotId: row.pricingSnapshotId || null, pricingLineId: original?.row.pricingLineId || null,
      refundId: row.refundId, refundEventId: row.refundEventId || null, refundItemId: row.refundItemId || null,
      refundLineEventId: row.refundLineEventId || null, producerSequence: sequence,
      refundRecognizedDate: row.refundRecognizedDate || null, refundRecognizedAt: row.refundRecognizedAt || null,
      refundTimezone: row.refundTimezone || null, merchandiseDeltaCents: returned === null ? null : -returned,
      returnedQuantity: row.returnedQuantity || null, previousReturnedQuantity: row.previousReturnedQuantity || null,
      cumulativeReturnedQuantity: row.cumulativeReturnedQuantity || null,
      previousReturnedItemValueMinor: previous, cumulativeReturnedItemValueMinor: cumulative,
      salaryImpactCents: null, reasons: codes(local) });
    reasons.push(...local);
  }
  // The manifest may include additional period-refund cohorts; the original
  // run cohort itself is checked against independent raw header/item reads.
  const history = new Map((manifest?.refundHistory || []).map(row => [row.orderItemId, row]));
  const refundsByItem = new Map();
  for (const line of lines) {
    if (!refundsByItem.has(line.orderItemId)) refundsByItem.set(line.orderItemId, []);
    refundsByItem.get(line.orderItemId).push(line);
  }
  let impact = 0n;
  const dayDeltas = new Map();
  for (const [itemId, original] of originals) {
    const related = (refundsByItem.get(itemId) || []).sort((a, b) => a.producerSequence - b.producerSequence);
    let cumulative = 0;
    for (let index = 0; index < related.length; index += 1) {
      const line = related[index], base = original.sale.commissionBaseCents, rate = original.line.appliedRateBps;
      if (line.reasons.length || line.producerSequence !== index + 1 || line.previousReturnedItemValueMinor !== cumulative
          || !safe(line.cumulativeReturnedItemValueMinor) || line.cumulativeReturnedItemValueMinor > base
          || !safe(rate) || rounded(base, rate) !== BigInt(original.line.commissionCents)) {
        add('payroll_refund_review_scalar_lineage_or_amount_unsupported'); continue;
      }
      const delta = rounded(base - line.cumulativeReturnedItemValueMinor, rate) - rounded(base - cumulative, rate);
      cumulative = line.cumulativeReturnedItemValueMinor;
      if (delta < BigInt(Number.MIN_SAFE_INTEGER) || delta > 0n) { add('payroll_refund_review_amount_out_of_range'); continue; }
      line.salaryImpactCents = Number(delta); impact += delta;
      const key = `${original.row.employeeId}/${original.row.localDate}`;
      const day = dayDeltas.get(key) || { salary: 0n, merchandise: 0n };
      day.salary += delta; day.merchandise += BigInt(line.merchandiseDeltaCents); dayDeltas.set(key, day);
    }
    const expected = history.get(itemId);
    if ((expected && (expected.originalSaleLineEventId !== original.row.originalSaleLineEventId
        || expected.cumulativeReturnedItemValueMinor !== cumulative)) || (!expected && related.length)) {
      add('payroll_refund_review_return_history_mismatch');
    }
  }
  for (const day of result?.daily || []) for (const employee of day.employees || []) {
    const delta = dayDeltas.get(`${employee.employeeId}/${day.date}`);
    if (delta && BigInt(employee.amountCents) + delta.salary > BigInt(employee.personalRevenueCents) + delta.merchandise) {
      add('payroll_refund_review_remaining_personal_ceiling_conflict');
    }
  }
  if (impact < BigInt(Number.MIN_SAFE_INTEGER)) add('payroll_refund_review_amount_out_of_range');
  const finalReasons = codes(reasons);
  if (finalReasons.length) for (const line of lines) { line.salaryImpactCents = null; line.reasons = codes([...line.reasons, ...finalReasons]); }
  lines.sort((a, b) => String(a.orderItemId).localeCompare(String(b.orderItemId), 'en')
    || (a.producerSequence || 0) - (b.producerSequence || 0) || a.refundId.localeCompare(b.refundId, 'en'));
  const sourceHash = digest({ policyVersion: POLICY, currentEngineRevision: getCalculatorReplayEngineManifest().engineRevision,
    provenanceSha256, manifest: manifest || null,
    snapshotLines: sorted(snapshotLines), refundRows: sorted(refundRows) });
  return { schemaVersion: 1, policyVersion: POLICY, basis: 'saved_calculation_unposted', runId: evidence.runId,
    venueId: evidence.venueId, currency: evidence.currency, provenanceSha256, sourceHash,
    coverage: finalReasons.length ? 'needs_review' : 'complete', impactCents: finalReasons.length ? null : Number(impact),
    reasons: finalReasons, lines, officialReady: false, payoutEligible: false };
};

const collectPayrollRefundReviewAssessment = async (db, actor, runId) => {
  if (!hasPayrollVerifiedWriteSnapshot(db, actor?.venueId)) throw new TypeError('payroll_refund_review_fenced_write_snapshot_required');
  const { header, evidence } = await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId);
  const manifest = await readPayrollRecognitionManifestInTransaction(db, { venueId: actor.venueId,
    currency: evidence.currency, from: evidence.period.from, to: evidence.period.to });
  const snapshotLines = (await db.query(`SELECT l.id::text,l.venue_id::text AS "venueId",l.run_id::text AS "runId",
      l.snapshot_id::text AS "snapshotId",l.employee_id::text AS "employeeId",l.local_date::text AS "localDate",
      l.employee_name_snapshot AS "employeeName",l.menu_item_name_snapshot AS "menuItemName",
      l.order_id::text AS "orderId",l.order_item_id::text AS "orderItemId",l.commission_base_net::text AS "commissionBase",
      l.commission_amount::text AS "commissionAmount",s.id::text AS "originalSaleLineEventId",s.sale_event_id::text AS "originalSaleEventId",
      s.snapshot_id::text AS "pricingSnapshotId",s.pricing_line_id::text AS "pricingLineId"
    FROM payroll_daily_snapshot_lines l LEFT JOIN pos_payroll_sale_line_events s
      ON s.venue_id=l.venue_id AND s.order_id=l.order_id AND s.order_item_id=l.order_item_id
    WHERE l.venue_id=$1 AND l.run_id=$2 ORDER BY l.order_id,l.order_item_id,l.id`, [actor.venueId, runId])).rows;
  // Read the manifest's entire covered cohort to reconcile raw IDs exactly;
  // the assessment exposes only the original run's credited-order rows.
  const orders = [...new Set([...snapshotLines.map(row => row.orderId), ...(manifest.relatedRefundCoverage?.coveredOrderIds || [])])].sort();
  const refundRows = (await db.query(`SELECT r.venue_id::text AS "venueId",r.id::text AS "refundId",r.order_id::text AS "orderId",
      e.id::text AS "refundEventId",e.original_sale_event_id::text AS "originalSaleEventId",
      e.recognized_local_date::text AS "refundRecognizedDate",to_char(e.recognized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "refundRecognizedAt",e.timezone_snapshot AS "refundTimezone",
      i.id::text AS "refundItemId",i.order_item_id::text AS "orderItemId",i.snapshot_id::text AS "pricingSnapshotId",
      f.id::text AS "refundLineEventId",f.original_sale_line_event_id::text AS "originalSaleLineEventId",
      f.returned_quantity::text AS "returnedQuantity",f.previous_returned_quantity::text AS "previousReturnedQuantity",
      f.cumulative_returned_quantity::text AS "cumulativeReturnedQuantity",
      f.producer_sequence AS "producerSequence",f.returned_item_value_minor::text AS "returnedItemValueMinor",
      f.previous_returned_item_value_minor::text AS "previousReturnedItemValueMinor",
      f.cumulative_returned_item_value_minor::text AS "cumulativeReturnedItemValueMinor"
    FROM order_refunds r LEFT JOIN pos_payroll_refund_events e ON e.venue_id=r.venue_id AND e.refund_id=r.id
    LEFT JOIN order_refund_items i ON i.venue_id=r.venue_id AND i.refund_id=r.id
    LEFT JOIN pos_payroll_refund_line_events f ON f.venue_id=r.venue_id AND f.refund_event_id=e.id AND f.refund_item_id=i.id
    WHERE r.venue_id=$1 AND r.order_id=ANY($2::uuid[]) ORDER BY r.id,i.id`, [actor.venueId, orders])).rows;
  return buildPayrollRefundReviewAssessment({ header, evidence, provenanceSha256: digest(evidence), manifest, snapshotLines, refundRows });
};

module.exports = { collectPayrollRefundReviewAssessment, buildPayrollRefundReviewAssessment };
