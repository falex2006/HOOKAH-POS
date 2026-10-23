'use strict';

// Pure producer arithmetic. Inputs must be captured from the actual depletion
// transaction. This module neither reads current recipes nor writes ledgers.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CENT_SCALE = 100000000n; // decimal6 quantity * decimal4 unit cost -> cents
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
const decimal = (value, scale) => {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) return null;
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
};
const formatted = (value, scale) => {
  const text = value.toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
};
const unavailable = reason => ({ schemaVersion: 1, status: 'incomplete', reasons: [reason], totalCostMinor: null, lines: [] });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

const buildInventoryOrderCostAllocation = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return unavailable('cost_allocation_context_invalid');
  const { lines, components, movements, totalCostMinor } = input;
  if (!Array.isArray(lines) || !Array.isArray(components) || !Array.isArray(movements)
      || lines.length > 20000 || components.length > 100000 || movements.length > 100000
      || !Number.isSafeInteger(totalCostMinor) || totalCostMinor < 0) return unavailable('cost_allocation_context_invalid');
  const byLine = new Map(), byMovement = new Map();
  for (const row of lines) {
    const orderItemId = uuid(row?.orderItemId), productId = uuid(row?.productId), quantity = decimal(row?.quantity, 6);
    if (!orderItemId || !productId || byLine.has(orderItemId) || quantity === null || quantity <= 0n
        || !['tracked', 'non_stock'].includes(row.inventoryMode)) return unavailable('cost_allocation_line_invalid');
    byLine.set(orderItemId, { orderItemId, productId, inventoryMode: row.inventoryMode,
      quantity: formatted(quantity, 6), rawCost: 0n, components: [] });
  }
  for (const row of movements) {
    const movementId = uuid(row?.movementId), ingredientId = uuid(row?.ingredientId), quantity = decimal(row?.quantity, 6);
    if (!movementId || !ingredientId || byMovement.has(movementId) || quantity === null || quantity <= 0n) {
      return unavailable('cost_allocation_movement_invalid');
    }
    byMovement.set(movementId, { ingredientId, quantity, allocatedQuantity: 0n, unitCost: null });
  }
  const componentKeys = new Set();
  for (const row of components) {
    const orderItemId = uuid(row?.orderItemId), ingredientId = uuid(row?.ingredientId), movementId = uuid(row?.movementId);
    const quantity = decimal(row?.quantity, 6), unitCost = decimal(row?.unitCost, 4);
    const line = byLine.get(orderItemId), movement = byMovement.get(movementId);
    const key = `${orderItemId}/${ingredientId}/${movementId}`;
    if (!line || !ingredientId || !movement || movement.ingredientId !== ingredientId
        || componentKeys.has(key) || quantity === null || quantity <= 0n || unitCost === null
        || (movement.unitCost !== null && movement.unitCost !== unitCost)) return unavailable('cost_allocation_component_invalid');
    if (line.inventoryMode === 'non_stock') return unavailable('cost_allocation_non_stock_consumption_ambiguous');
    componentKeys.add(key);
    movement.unitCost = unitCost;
    movement.allocatedQuantity += quantity;
    line.rawCost += quantity * unitCost;
    line.components.push({ ingredientId, movementId, quantity: formatted(quantity, 6), unitCost: formatted(unitCost, 4) });
  }
  if ([...byMovement.values()].some(row => row.quantity !== row.allocatedQuantity)) return unavailable('cost_allocation_movement_coverage_mismatch');
  if ([...byLine.values()].some(row => row.inventoryMode === 'tracked' && !row.components.length)) return unavailable('cost_allocation_tracked_line_unproven');
  const allocated = [...byLine.values()].sort((a, b) => compare(a.orderItemId, b.orderItemId));
  const rawTotal = allocated.reduce((sum, row) => sum + row.rawCost, 0n);
  if ((rawTotal + CENT_SCALE / 2n) / CENT_SCALE !== BigInt(totalCostMinor)) return unavailable('cost_allocation_order_total_mismatch');
  for (const row of allocated) row.minor = row.rawCost / CENT_SCALE;
  let remainder = BigInt(totalCostMinor) - allocated.reduce((sum, row) => sum + row.minor, 0n);
  const ranking = [...allocated].sort((a, b) => compare(b.rawCost % CENT_SCALE, a.rawCost % CENT_SCALE)
    || compare(a.orderItemId, b.orderItemId));
  for (const row of ranking) {
    if (remainder === 0n) break;
    row.minor += 1n; remainder -= 1n;
  }
  if (remainder !== 0n) return unavailable('cost_allocation_rounding_failed');
  return { schemaVersion: 1, status: 'complete', reasons: [], valuationMethod: 'ingredient_cost_at_depletion_v1',
    roundingMethod: 'order_half_up_line_largest_remainder_v1', totalCostMinor,
    lines: allocated.map(row => ({ orderItemId: row.orderItemId, productId: row.productId,
      inventoryMode: row.inventoryMode, quantity: row.quantity, totalCostMinor: Number(row.minor),
      rawCost: formatted(row.rawCost, 10), components: row.components.sort((a, b) => compare(a.ingredientId, b.ingredientId)
        || compare(a.movementId, b.movementId)) })) };
};

module.exports = { buildInventoryOrderCostAllocation };
