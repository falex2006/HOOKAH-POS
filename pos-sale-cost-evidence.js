'use strict';

const { createHash } = require('node:crypto');
const { buildInventoryOrderCostAllocation } = require('./inventory-order-cost-allocation');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = payload => createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
const validId = value => typeof value === 'string' && UUID.test(value);

/** capture is createInventoryOrderCostCapture.snapshot(); totalCostMinor is the
 * PostgreSQL-rounded existing order valuation, never a recomputed current cost.
 * Capture and persistence run inside the existing source transaction. No own
 * transaction, stock mutation, recognition or financial posting occurs here. */
function buildSaleCostEvidence({ venueId, orderId, capture, totalCostMinor } = {}) {
  if (!validId(venueId) || !validId(orderId)) throw new Error('sale_cost_context_invalid');
  const source = capture && typeof capture === 'object' ? structuredClone(capture) : null;
  const allocation = buildInventoryOrderCostAllocation({ lines: source?.lines,
    components: source?.components, movements: source?.movements, totalCostMinor });
  const reasons = new Set(allocation.reasons);
  if (source?.captureVersion !== 1 || source?.status !== 'captured') reasons.add('depletion_capture_incomplete');
  if (!Array.isArray(source?.reasons)) reasons.add('depletion_capture_reasons_invalid');
  for (const reason of Array.isArray(source?.reasons) ? source.reasons : []) reasons.add(String(reason));
  // Inventory defaults to zero; absence of an attestation cannot prove free COGS.
  if (Array.isArray(source?.components) && source.components.some(row => /^0+(?:\.0+)?$/.test(String(row?.unitCost)))) {
    reasons.add('valuation_zero_unattested');
  }
  const complete = reasons.size === 0;
  return { schemaVersion: 1, policyVersion: 1, scope: 'sale_depletion_cost', venueId: venueId.toLowerCase(),
    orderId: orderId.toLowerCase(), currency: 'RUB', valuationMethod: 'ingredient_cost_at_depletion_v1',
    status: complete ? 'complete' : 'incomplete', reasons: [...reasons].sort(),
    totalCostMinor: complete ? allocation.totalCostMinor : null,
    observedOrderCostMinor: Number.isSafeInteger(totalCostMinor) && totalCostMinor >= 0 ? totalCostMinor : null,
    refundAdjustedReady: false, capture: source, allocation };
}

async function persistSaleCostEvidence(client, input) {
  if (!validId(input?.venueId) || !validId(input?.orderId)) throw new Error('sale_cost_context_invalid');
  // Caller holds the order lock. Return frozen evidence before touching current
  // valuation or the INSERT guard (which intentionally allows only fresh closes).
  const previous = await client.query('SELECT payload,watermark FROM pos_sale_cost_evidence WHERE venue_id=$1 AND order_id=$2',
    [input.venueId, input.orderId]);
  if (previous.rows[0]) {
    const row = previous.rows[0];
    if (row.watermark !== fingerprint(row.payload) || row.payload?.venueId !== input.venueId.toLowerCase()
        || row.payload?.orderId !== input.orderId.toLowerCase()) throw new Error('sale_cost_evidence_integrity_invalid');
    const rebuilt = { ...buildSaleCostEvidence({ venueId: input.venueId, orderId: input.orderId,
      capture: row.payload.capture, totalCostMinor: row.payload.observedOrderCostMinor }), epochActivatedAt: row.payload.epochActivatedAt };
    if (fingerprint(rebuilt) !== row.watermark) throw new Error('sale_cost_evidence_integrity_invalid');
    return row;
  }
  const observed = await client.query(`SELECT c.cost::text AS cost,
    to_char(x.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "epochActivatedAt"
    FROM order_costs c JOIN pos_sale_cost_epochs x ON x.venue_id=c.venue_id WHERE c.venue_id=$1 AND c.order_id=$2`,
  [input.venueId, input.orderId]);
  const cost = observed.rows[0]?.cost;
  if (typeof cost !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(cost)) throw new Error('sale_cost_order_valuation_missing');
  const [whole, fraction = ''] = cost.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('sale_cost_order_valuation_overflow');
  const payload = { ...buildSaleCostEvidence({ ...input, totalCostMinor: Number(minor) }),
    epochActivatedAt: observed.rows[0].epochActivatedAt };
  const watermark = fingerprint(payload);
  // Database guards own source/tenant validation, sealing and append-only rules.
  // A retry returns existing evidence and never reconstructs its historical facts.
  const result = await client.query(`INSERT INTO pos_sale_cost_evidence (venue_id,order_id,payload,watermark)
    VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (venue_id,order_id) DO NOTHING RETURNING payload,watermark`,
  [payload.venueId, payload.orderId, JSON.stringify(payload), watermark]);
  if (result.rows[0]) return result.rows[0];
  const existing = await client.query('SELECT payload,watermark FROM pos_sale_cost_evidence WHERE venue_id=$1 AND order_id=$2',
    [payload.venueId, payload.orderId]);
  const row = existing.rows[0];
  if (!row || row.watermark !== fingerprint(row.payload)) throw new Error('sale_cost_evidence_integrity_invalid');
  return row;
}

async function readSaleCostEvidence(client, { venueId, orderId } = {}) {
  if (!validId(venueId) || !validId(orderId)) throw new Error('sale_cost_context_invalid');
  const result = await client.query(`SELECT e.payload,e.watermark,
    to_char(x.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "epochActivatedAt"
    FROM orders o LEFT JOIN pos_sale_cost_evidence e ON e.venue_id=o.venue_id AND e.order_id=o.id
    LEFT JOIN pos_sale_cost_epochs x ON x.venue_id=o.venue_id
    WHERE o.venue_id=$1 AND o.id=$2 AND o.status='closed'`, [venueId, orderId]);
  const row = result.rows[0];
  if (!row) return { status: 'unavailable', reasons: ['closed_sale_not_found'], totalCostMinor: null, refundAdjustedReady: false };
  if (!row.payload || !row.epochActivatedAt) return { status: 'incomplete', reasons: ['historical_sale_cost_unavailable'], totalCostMinor: null, refundAdjustedReady: false };
  const payload = row.payload;
  if (row.watermark !== fingerprint(payload) || payload.venueId !== venueId.toLowerCase() || payload.orderId !== orderId.toLowerCase()
      || payload.schemaVersion !== 1 || payload.scope !== 'sale_depletion_cost') {
    return { status: 'incomplete', reasons: ['sale_cost_evidence_integrity_invalid'], totalCostMinor: null, refundAdjustedReady: false };
  }
  const rebuilt = { ...buildSaleCostEvidence({ venueId, orderId, capture: payload.capture, totalCostMinor: payload.observedOrderCostMinor }),
    epochActivatedAt: row.epochActivatedAt };
  if (fingerprint(rebuilt) !== row.watermark) return { status: 'incomplete', reasons: ['sale_cost_evidence_validation_failed'], totalCostMinor: null, refundAdjustedReady: false };
  return { ...payload, watermark: row.watermark, epochActivatedAt: row.epochActivatedAt };
}

module.exports = { buildSaleCostEvidence, persistSaleCostEvidence, readSaleCostEvidence, saleCostEvidenceFingerprint: fingerprint };
