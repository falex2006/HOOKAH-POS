'use strict';
const { sanitizeAuditEvent } = require('./audit-privacy');
const crypto = require('crypto');

const PURCHASE_UNIT_FACTORS = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };

const decimalToScaledInteger = (value, scale) => {
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
  if (!match) return null;
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) return null;
  const fraction = match[3] || '';
  const power = scale - fraction.length + exponent;
  if (power < 0 || power > 30) return null;
  const digits = BigInt(`${match[2]}${fraction}` || '0');
  const scaled = digits * (10n ** BigInt(power));
  return match[1] === '-' ? -scaled : scaled;
};

const divideHalfUp = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
const scaledIntegerToNumber = (value, scale) => Number(value) / (10 ** scale);

// Allocate new stock issues against tracked premix lots. Unallocated legacy
// stock is consumed first because its production date cannot be reconstructed.
// Callers hold the ingredient row lock and have inserted the aggregate stock
// movement in the same transaction before invoking this helper.
async function allocatePremixBatchConsumption(client, input) {
  const { venueId, ingredientId, stockMovementId, quantity, onHandBefore, createdBy, reason } = input;
  const { rows } = await client.query(`
    SELECT b.id, b.output_quantity,
      COALESCE((SELECT SUM(m.quantity_delta) FROM inventory_premix_batch_movements m WHERE m.batch_id=b.id),0)::numeric AS allocated_delta,
      b.expires_at, (b.expires_at IS NOT NULL AND b.expires_at<=now()) AS expired, b.created_at
    FROM inventory_premix_batches b
    WHERE b.venue_id=$1 AND b.output_ingredient_id=$2 AND b.status='produced'
    ORDER BY b.expires_at ASC NULLS LAST, b.created_at ASC, b.id ASC
    FOR UPDATE OF b`, [venueId, ingredientId]);
  const lots = rows.map((row) => ({
    id: row.id,
    remaining: Math.max(0, Number(row.output_quantity) + Number(row.allocated_delta || 0)),
    expired: Boolean(row.expired),
  })).filter((lot) => lot.remaining > 0.0000001);
  const trackedBefore = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  let legacyRemaining = Math.max(0, Number(onHandBefore || 0) - trackedBefore);
  let toAllocate = Number(quantity);
  const fromLegacy = Math.min(legacyRemaining, toAllocate);
  toAllocate -= fromLegacy;
  for (const lot of lots.filter((entry) => !entry.expired)) {
    if (toAllocate <= 0.0000001) break;
    const allocated = Math.min(lot.remaining, toAllocate);
    await client.query(`INSERT INTO inventory_premix_batch_movements
      (venue_id,batch_id,stock_movement_id,movement_type,quantity_delta,reason,created_by)
      VALUES ($1,$2,$3,'consumption',$4,$5,$6)`,
    [venueId, lot.id, stockMovementId, -allocated, reason || 'Списание со склада', createdBy || null]);
    toAllocate -= allocated;
  }
  if (toAllocate > 0.0000001) {
    const error = new Error(lots.some((lot) => lot.expired) ? 'expired_premix_stock' : 'premix_batch_balance_mismatch');
    error.available = Number(quantity) - toAllocate;
    throw error;
  }
}

/** PostgreSQL repositories. They are optional so the local demo can run without a database. */
class OrderRepository {
  constructor(pool) { this.pool = pool; }
  async listOpen(venueId, includeClosed = false) {
    const { rows } = await this.pool.query(`SELECT o.id, o.table_id AS "tableId", o.reservation_id AS "reservationId", CASE WHEN z.id IS NOT NULL THEN t.name END AS "tableName", o.status, o.vip_minimum AS "minimumOrderTotal", o.notes, o.created_at AS "createdAt", o.guest_id AS "guestId", g.full_name AS "guestName", g.phone AS "guestPhone", o.group_discount_group_id AS "groupDiscountGroupId", o.group_discount_name AS "groupDiscountName", o.group_discount_percent AS "groupDiscountPercent", o.group_discount_base AS "groupDiscountBase", o.group_discount_amount AS "groupDiscountAmount", o.effective_discount_source AS "effectiveDiscountSource", o.subtotal_snapshot AS "subtotalSnapshot", o.discount_total_snapshot AS "discountTotalSnapshot", o.minimum_adjustment_snapshot AS "minimumAdjustmentSnapshot", o.final_total_snapshot AS "finalTotalSnapshot", o.pricing_version AS "pricingVersion",
      o.closed_at AS "closedAt", (SELECT s.id FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) AS "pricingSnapshotId", CASE WHEN EXISTS(SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) THEN 'complete' WHEN o.pricing_locked_at IS NULL THEN 'pending' ELSE 'unknown' END AS "lineSnapshotStatus", COALESCE(o.final_total_snapshot,(SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id=o.id AND pay.status IN ('paid','partially_paid')),0) AS "finalTotal",
      CASE WHEN o.final_total_snapshot IS NOT NULL THEN GREATEST(0, o.final_total_snapshot - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id=o.id AND pay.status IN ('paid','partially_paid')),0)) END AS "attentionPaymentDue",
      COALESCE(json_agg(json_build_object('id', oi.id, 'productId', oi.product_id, 'name', CASE WHEN sl.id IS NULL THEN p.name ELSE sl.product_facts->>'productName' END, 'quantity', CASE WHEN sl.id IS NULL THEN oi.quantity ELSE sl.quantity END, 'unitPrice', CASE WHEN sl.id IS NULL THEN oi.unit_price ELSE sl.unit_price END, 'station', CASE WHEN sl.id IS NULL THEN oi.station ELSE sl.product_facts->>'station' END, 'status', oi.status, 'salesEmployeeId', CASE WHEN sl.id IS NULL THEN oi.sales_employee_id ELSE sl.seller_id END, 'salesEmployeeName', sales_employee.full_name, 'soldAt', CASE WHEN sl.id IS NULL THEN oi.sold_at ELSE sl.sold_at END, 'grossMinor',sl.gross_minor,'discountMinor',sl.discount_minor,'netMinor',sl.net_minor,'pricingSnapshotStatus',CASE WHEN sl.id IS NOT NULL THEN 'complete' WHEN o.pricing_locked_at IS NULL THEN 'pending' ELSE 'unknown' END)) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o LEFT JOIN guests g ON g.id=o.guest_id LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN zones z ON z.id=t.zone_id AND z.venue_id=o.venue_id LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN pos_order_pricing_snapshot_lines sl ON sl.order_id=o.id AND sl.order_item_id=oi.id LEFT JOIN products p ON p.id=oi.product_id LEFT JOIN users sales_employee ON sales_employee.id=CASE WHEN sl.id IS NULL THEN oi.sales_employee_id ELSE sl.seller_id END AND (sales_employee.venue_id=o.venue_id OR sales_employee.organization_id=(SELECT organization_id FROM venues WHERE id=o.venue_id) OR EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=(SELECT organization_id FROM venues WHERE id=o.venue_id) AND m.user_id=sales_employee.id AND m.status='active'))
      WHERE o.venue_id=$1 ${includeClosed ? '' : "AND o.status IN ('open','in_progress','ready')"} GROUP BY o.id, g.full_name, g.phone, t.name, z.id ORDER BY o.created_at DESC`, [venueId]);
    return rows.map((row) => ({ ...row, finalTotal: Number(row.finalTotal || 0), attentionPaymentDue: row.attentionPaymentDue === null ? null : Number(row.attentionPaymentDue) }));
  }
  async create(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [input.venueId]);
      const { rows: loyaltyRows } = await client.query('SELECT version,bonus_ruble_rate AS "rate",max_redemption_percent AS "capPercent",min_redemption_points AS "minimumPoints" FROM loyalty_program_settings WHERE venue_id=$1 ORDER BY version DESC LIMIT 1', [input.venueId]);
      const loyaltyPolicy = loyaltyRows[0] || { version: 0, rate: 1, capPercent: 100, minimumPoints: 1 };
      let tableMinimum = 0;
      if (input.tableId) { const target = await client.query("SELECT t.id,t.min_order_total FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 AND t.status <> 'blocked' AND t.archived_at IS NULL FOR UPDATE OF t", [input.tableId, input.venueId]); if (!target.rows[0]) throw new Error('table_not_found_or_unavailable'); tableMinimum = Number(target.rows[0].min_order_total || 0); const active = await client.query(`SELECT id FROM orders WHERE venue_id=$1 AND table_id=$2 AND status IN ('open','in_progress','ready') LIMIT 1`, [input.venueId, input.tableId]); if (active.rows[0]) { if(input.reservationId){const linked=await client.query('SELECT 1 FROM orders WHERE venue_id=$1 AND reservation_id=$2 LIMIT 1',[input.venueId,input.reservationId]);if(linked.rows[0])throw new Error('reservation_already_linked');} throw new Error('table_has_active_order'); } }
      let reservationId = null, guestId = input.guestId || null;
      if (input.reservationId) {
        const reservation = await client.query('SELECT id,status,table_id AS "tableId",guest_id AS "guestId",deposit_paid AS "legacyDepositPaid" FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE', [input.reservationId,input.venueId]);
        if (!reservation.rows[0]) throw new Error('reservation_not_found');
        if (reservation.rows[0].status !== 'confirmed') throw new Error('reservation_not_confirmed');
        if (String(reservation.rows[0].tableId || '') !== String(input.tableId || '')) throw new Error('reservation_table_mismatch');
        if (guestId && String(guestId) !== String(reservation.rows[0].guestId || '')) throw new Error('reservation_guest_mismatch');
        const linked = await client.query("SELECT id FROM orders WHERE venue_id=$1 AND reservation_id=$2 LIMIT 1",[input.venueId,input.reservationId]);
        if (linked.rows[0]) throw new Error('reservation_already_linked');
        reservationId = input.reservationId; guestId = reservation.rows[0].guestId;
      }
      let guestDiscountGroup = null;
      if (guestId) {
        const { rows } = await client.query(`SELECT dg.id AS "groupId",dg.name AS "groupName",dg.discount_percent AS "discountPercent"
          FROM guests g LEFT JOIN guest_discount_groups dg ON dg.id=g.discount_group_id AND dg.venue_id=g.venue_id AND dg.active=true
          WHERE g.id=$1 AND g.venue_id=$2`, [guestId,input.venueId]);
        guestDiscountGroup = rows[0] || null;
      }
      const vipMinimum = Math.max(Number(input.vipMinimum || 0), tableMinimum);
      const { rows } = await client.query('INSERT INTO orders (venue_id, table_id, opened_by, reservation_id, guest_id, group_discount_group_id, group_discount_name, group_discount_percent, vip_minimum, notes,loyalty_redemption_policy_version,loyalty_redemption_rate,loyalty_redemption_cap_percent,loyalty_redemption_min_points) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, table_id AS "tableId", reservation_id AS "reservationId", guest_id AS "guestId", group_discount_group_id AS "groupDiscountGroupId", group_discount_name AS "groupDiscountName", group_discount_percent AS "groupDiscountPercent", status, vip_minimum AS "minimumOrderTotal", notes, created_at AS "createdAt",loyalty_redemption_policy_version AS "redemptionPolicyVersion",loyalty_redemption_rate AS "redemptionRate",loyalty_redemption_cap_percent AS "redemptionCapPercent",loyalty_redemption_min_points AS "redemptionMinPoints"', [input.venueId, input.tableId || null, input.openedBy, reservationId, guestId, guestDiscountGroup?.groupId || null, guestDiscountGroup?.groupName || null, guestDiscountGroup?.discountPercent ?? null, vipMinimum, input.notes || null,Number(loyaltyPolicy.version),Number(loyaltyPolicy.rate),Number(loyaltyPolicy.capPercent),Number(loyaltyPolicy.minimumPoints)]);
      if (input.tableId) await client.query(`UPDATE tables t SET status='occupied'::table_status FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked'`, [input.tableId, input.venueId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

class InventoryRepository {
  constructor(pool) { this.pool = pool; }
  async list(venueId) {
    const { rows } = await this.pool.query(`SELECT i.id, i.name, i.short_name AS "shortName", i.department, i.subdepartment, i.category, i.category_id AS "categoryId", i.tobacco_catalog_item_id AS "tobaccoCatalogItemId", i.item_type AS "itemType", i.unit, i.purchase_unit AS "purchaseUnit", i.pack_multiplier AS "packMultiplier", i.cost, i.supplier, i.barcode, i.note, i.min_stock AS "minLevel", i.alcohol_catalog_item_id AS "alcoholCatalogItemId",
      (SELECT jsonb_build_object('id',ac.id,'brand',ac.brand,'productLine',ac.product_line,'name',ac.name,'spiritType',ac.spirit_type,'spiritSubtype',ac.spirit_subtype,'country',ac.country,'abv',ac.abv,'bottleMl',ac.bottle_ml,'ageYears',ac.age_years,'barcode',ac.barcode,'active',ac.is_active) FROM alcohol_catalog_items ac WHERE ac.id=i.alcohol_catalog_item_id AND ac.organization_id=i.organization_id) AS "alcoholCatalogItem",
      (SELECT jsonb_build_object('id',tc.id,'brand',tc.brand,'productLine',tc.product_line,'flavor',tc.flavor,'productType',tc.product_type,'packageGrams',tc.package_grams,'strength',tc.strength,'active',tc.is_active) FROM tobacco_catalog_items tc WHERE tc.id=i.tobacco_catalog_item_id AND tc.organization_id=i.organization_id) AS "tobaccoCatalogItem",
      COALESCE(SUM(CASE WHEN sm.direction IN ('in','transfer','adjustment') THEN sm.quantity WHEN sm.direction IN ('out','waste') THEN -sm.quantity ELSE 0 END),0) AS "onHand"
      FROM ingredients i LEFT JOIN stock_movements sm ON sm.ingredient_id=i.id AND sm.venue_id=i.venue_id
      WHERE i.venue_id=$1 AND i.is_marked=true GROUP BY i.id ORDER BY i.department,i.name`, [venueId]);
    const movements = await this.pool.query(`SELECT sm.id, sm.ingredient_id AS "itemId", i.name AS "itemName", sm.quantity, sm.direction, sm.reason, sm.created_at AS "createdAt"
      FROM stock_movements sm JOIN ingredients i ON i.id=sm.ingredient_id WHERE sm.venue_id=$1 ORDER BY sm.created_at DESC LIMIT 20`, [venueId]);
    return { items: rows.map((row) => ({ ...row, onHand: Number(row.onHand), minLevel: Number(row.minLevel), cost: Number(row.cost || 0), packMultiplier: Number(row.packMultiplier || 1) })), movements: movements.rows };
  }
  async create(venueId, input, client = this.pool) {
    const { rows } = await client.query(`INSERT INTO ingredients (venue_id,name,short_name,department,subdepartment,category,category_id,tobacco_catalog_item_id,item_type,unit,purchase_unit,pack_multiplier,cost,min_stock,supplier,barcode,note,alcohol_catalog_item_id,is_marked)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true)
      RETURNING id,name,short_name AS "shortName",department,subdepartment,category,category_id AS "categoryId",tobacco_catalog_item_id AS "tobaccoCatalogItemId",item_type AS "itemType",unit,purchase_unit AS "purchaseUnit",pack_multiplier AS "packMultiplier",cost,min_stock AS "minLevel",supplier,barcode,note,alcohol_catalog_item_id AS "alcoholCatalogItemId"`, [venueId, input.name, input.shortName || null, input.department || 'inventory', input.subdepartment || '', input.category || 'Без категории', input.categoryId || null, input.tobaccoCatalogItemId || null, input.itemType || 'ingredient', input.unit, input.purchaseUnit || null, input.packMultiplier || 1, input.cost || 0, input.minLevel || 0, input.supplier || null, input.barcode || null, input.note || null, input.alcoholCatalogItemId || null]);
    return rows[0];
  }
  async update(venueId, id, input, client = this.pool) {
    if (input.unit !== undefined) {
      const existing = await client.query('SELECT unit FROM ingredients WHERE id=$1 AND venue_id=$2', [id, venueId]);
      if (existing.rows[0] && existing.rows[0].unit !== input.unit) {
        const history = await client.query('SELECT 1 FROM stock_movements WHERE ingredient_id=$1 AND venue_id=$2 LIMIT 1', [id, venueId]);
        if (history.rowCount) throw new Error('inventory_unit_has_movements');
      }
    }
    const fields = []; const values = [id, venueId]; const allowed = [['name','name'],['shortName','short_name'],['department','department'],['subdepartment','subdepartment'],['category','category'],['categoryId','category_id'],['tobaccoCatalogItemId','tobacco_catalog_item_id'],['itemType','item_type'],['unit','unit'],['purchaseUnit','purchase_unit'],['packMultiplier','pack_multiplier'],['cost','cost'],['minLevel','min_stock'],['supplier','supplier'],['barcode','barcode'],['note','note'],['alcoholCatalogItemId','alcohol_catalog_item_id']];
    for (const [key, column] of allowed) if (input[key] !== undefined) { values.push(input[key]); fields.push(`${column}=$${values.length}`); }
    if (!fields.length) return null;
    const { rows } = await client.query(`UPDATE ingredients SET ${fields.join(',')} WHERE id=$1 AND venue_id=$2 AND is_marked=true RETURNING id,name,short_name AS "shortName",department,subdepartment,category,category_id AS "categoryId",tobacco_catalog_item_id AS "tobaccoCatalogItemId",item_type AS "itemType",unit,purchase_unit AS "purchaseUnit",pack_multiplier AS "packMultiplier",cost,min_stock AS "minLevel",supplier,barcode,note,alcohol_catalog_item_id AS "alcoholCatalogItemId"`, values);
    return rows[0] || null;
  }
  async archive(venueId, id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const item = await client.query('SELECT id,name FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true FOR UPDATE', [id, venueId]);
      if (!item.rows[0]) { await client.query('ROLLBACK'); return null; }
      const balance = await client.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS on_hand FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, id]);
      if (Number(balance.rows[0]?.on_hand || 0) > 0.000001) { const error = new Error('inventory_item_has_stock'); error.code = 'inventory_item_has_stock'; throw error; }
      const archived = await client.query('UPDATE ingredients SET is_marked=false WHERE id=$1 AND venue_id=$2 AND is_marked=true RETURNING id,name', [id, venueId]);
      await client.query('COMMIT');
      return archived.rows[0] || null;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async move(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: itemRows } = await client.query('SELECT id,name,unit FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true FOR UPDATE', [input.ingredientId, input.venueId]);
      const item = itemRows[0];
      if (!item) throw new Error('inventory_item_not_found');
      if (input.unit && item.unit !== input.unit) throw new Error('inventory_unit_changed');
      const { rows: balanceRows } = await client.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS value FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [input.venueId, input.ingredientId]);
      const onHandBefore = Number(balanceRows[0]?.value || 0);
      const quantity = Number(input.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('invalid_movement_quantity');
      if (['out','waste'].includes(input.direction) && onHandBefore + 0.000001 < quantity) {
        const error = new Error('insufficient_stock'); error.code = 'insufficient_stock'; error.onHand = onHandBefore; throw error;
      }
      const { rows } = await client.query(`INSERT INTO stock_movements (venue_id, ingredient_id, direction, quantity, reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ingredient_id AS "itemId", quantity, direction, reason, created_at AS "createdAt"`, [input.venueId, input.ingredientId, input.direction, quantity, input.reason || null, input.createdBy || null]);
      if (['out','waste'].includes(input.direction)) await allocatePremixBatchConsumption(client, {
        venueId: input.venueId, ingredientId: input.ingredientId, stockMovementId: rows[0].id,
        quantity, onHandBefore, createdBy: input.createdBy,
        reason: input.reason || (input.direction === 'waste' ? 'Списание порчи' : 'Списание со склада'),
      });
      const sign = ['out','waste'].includes(input.direction) ? -1 : 1;
      const result = { ...rows[0], itemName: item.name, unit: item.unit, onHandBefore, onHandAfter: Number((onHandBefore + sign * quantity).toFixed(6)) };
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async receive(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: itemRows } = await client.query('SELECT id,name,unit,cost FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true FOR UPDATE', [input.ingredientId, input.venueId]);
      const item = itemRows[0];
      if (!item) throw new Error('inventory_item_not_found');
      if (item.unit !== input.stockUnit) throw new Error('inventory_unit_changed');
      const quantity = Number(input.quantity);
      const factor = Number(input.conversionFactor);
      const unitCost = Number(input.unitCost);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(unitCost) || unitCost < 0) throw new Error('invalid_supply');
      const { rows: balanceRows } = await client.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS value FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [input.venueId, input.ingredientId]);
      const onHandBefore = Number(balanceRows[0]?.value || 0);
      const onHandAfter = onHandBefore + quantity;
      const normalizedUnitCost = unitCost / factor;
      const weightedCost = onHandAfter > 0 ? (Math.max(0, onHandBefore) * Number(item.cost || 0) + quantity * normalizedUnitCost) / onHandAfter : normalizedUnitCost;
      const { rows } = await client.query(`INSERT INTO stock_movements (venue_id, ingredient_id, direction, quantity, reason, created_by)
        VALUES ($1,$2,'in',$3,$4,$5) RETURNING id,ingredient_id AS "itemId",quantity,direction,reason,created_at AS "createdAt"`, [input.venueId, input.ingredientId, quantity, input.reason || null, input.createdBy || null]);
      const preciseWeightedCost = Number(weightedCost.toFixed(4));
      await client.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [preciseWeightedCost, input.ingredientId, input.venueId]);
      const result = { ...rows[0], itemName: item.name, unit: item.unit, onHandBefore, onHandAfter: Number(onHandAfter.toFixed(6)), weightedCost: preciseWeightedCost };
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async setProductImage(venueId, productId, imageUrl) {
    const { rows } = await this.pool.query('UPDATE products SET image_url=$1 WHERE id=$2 AND venue_id=$3 RETURNING id,name,image_url AS "imageUrl"', [imageUrl, productId, venueId]);
    return rows[0] || null;
  }
}

class PurchaseDocumentRepository {
  constructor(pool) { this.pool = pool; }
  async getReversalPolicy(venueId) {
    const { rows } = await this.pool.query(`SELECT version,mode,enabled,created_by AS "createdBy",created_at AS "createdAt"
      FROM inventory_purchase_reversal_policies WHERE venue_id=$1 ORDER BY version DESC LIMIT 1`, [venueId]);
    return rows[0] ? { ...rows[0], version: Number(rows[0].version), enabled: Boolean(rows[0].enabled) } : null;
  }
  async updateReversalPolicy(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const venue = await client.query('SELECT id FROM venues WHERE id=$1 AND is_active=true FOR UPDATE', [input.venueId]);
      if (!venue.rows[0]) throw new Error('venue_not_found');
      const current = await client.query(`SELECT version,mode,enabled FROM inventory_purchase_reversal_policies
        WHERE venue_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [input.venueId]);
      if (!current.rows[0]) throw new Error('purchase_reversal_policy_unavailable');
      const currentVersion = Number(current.rows[0].version);
      if (currentVersion !== input.expectedVersion) throw new Error('purchase_reversal_policy_version_conflict');
      const created = await client.query(`INSERT INTO inventory_purchase_reversal_policies (venue_id,version,mode,enabled,created_by)
        VALUES ($1,$2,'safe_full_unpaid_unused',$3,$4)
        RETURNING version,mode,enabled,created_by AS "createdBy",created_at AS "createdAt"`, [input.venueId,currentVersion + 1,input.enabled,input.actorId]);
      const beforeData = { version: currentVersion, mode: current.rows[0].mode, enabled: Boolean(current.rows[0].enabled) };
      const afterData = { version: Number(created.rows[0].version), mode: created.rows[0].mode, enabled: Boolean(created.rows[0].enabled) };
      await client.query(`INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES ($1,$2,'inventory.purchase_reversal_policy_changed','venue_purchase_reversal_policy',$1,$3::jsonb,$4::jsonb)`, [input.venueId,input.actorId,JSON.stringify(beforeData),JSON.stringify(afterData)]);
      await client.query('COMMIT');
      return { ...created.rows[0], version: Number(created.rows[0].version), enabled: Boolean(created.rows[0].enabled) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  static async assertSourceAutoOrder(client, venueId, sourceAutoOrderId) {
    if (!sourceAutoOrderId) return;
    const { rows } = await client.query('SELECT id,status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [sourceAutoOrderId, venueId]);
    if (!rows[0]) throw new Error('invalid_source_auto_order');
    if (!['sent', 'partially_received'].includes(rows[0].status)) throw new Error('source_auto_order_not_open');
    return rows[0];
  }
  static async assertAutoOrderAllocation(client, order, venueId, documentId, lines) {
    if (!order) return;
    const orderLines = Array.isArray(order.lines) ? order.lines : [];
    const orderedByItem = new Map(orderLines.map((line) => [String(line.itemId), line]));
    const requested = new Map();
    for (const line of lines) {
      const itemId = String(line.ingredientId);
      const ordered = orderedByItem.get(itemId);
      if (!ordered) throw new Error('purchase_item_not_in_auto_order');
      if (String(line.stockUnit) !== String(ordered.unit)) throw new Error('auto_order_unit_mismatch');
      requested.set(itemId, (requested.get(itemId) || 0) + Number(line.stockQuantity || 0));
    }
    const { rows } = await client.query(`SELECT l.ingredient_id AS "ingredientId",COALESCE(SUM(l.stock_quantity),0)::numeric AS reserved
      FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id
      WHERE d.source_auto_order_id=$1 AND d.venue_id=$2 AND d.status='draft' AND d.id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      GROUP BY l.ingredient_id`, [order.id, venueId, documentId || null]);
    const reservedByItem = new Map(rows.map((row) => [String(row.ingredientId), Number(row.reserved || 0)]));
    for (const [itemId, quantity] of requested) {
      const ordered = orderedByItem.get(itemId);
      const remaining = Number(ordered.quantity || 0) - Number(ordered.receivedQuantity || 0) - Number(reservedByItem.get(itemId) || 0);
      if (quantity > remaining + 0.000001) {
        const error = new Error('purchase_quantity_exceeds_auto_order');
        error.ingredientId = itemId;
        error.remaining = Math.max(0, remaining);
        throw error;
      }
    }
  }
  static lineForItem(line, item) {
    const purchaseUnit = String(item.purchaseUnit || '').trim().toLocaleLowerCase('ru-RU');
    const sourceUnit = String(line.unit || '').trim();
    const packageFactor = purchaseUnit && sourceUnit.toLocaleLowerCase('ru-RU') === purchaseUnit ? Number(item.packMultiplier || 1) : null;
    const factor = packageFactor || PURCHASE_UNIT_FACTORS[sourceUnit]?.[item.unit];
    if (!factor) { const error = new Error('invalid_purchase_unit'); error.ingredientId = line.ingredientId; error.sourceUnit = line.unit; error.targetUnit = item.unit; throw error; }
    const quantity = decimalToScaledInteger(line.quantity, 6);
    const unitCost = decimalToScaledInteger(line.unitCost, 4);
    const scaledFactor = decimalToScaledInteger(factor, 6);
    if (quantity === null || quantity <= 0n || unitCost === null || unitCost < 0n || scaledFactor === null || scaledFactor <= 0n) {
      const error = new Error('invalid_purchase_line'); error.ingredientId = line.ingredientId; throw error;
    }
    const stockQuantity = scaledIntegerToNumber(divideHalfUp(quantity * scaledFactor, 1_000_000n), 6);
    const receiptUnitCost = scaledIntegerToNumber(divideHalfUp(unitCost * 100_000_000n, scaledFactor), 6);
    const lineTotal = scaledIntegerToNumber(divideHalfUp(quantity * unitCost, 100_000_000n), 2);
    return { ...line, quantity: scaledIntegerToNumber(quantity, 6), unitCost: scaledIntegerToNumber(unitCost, 4), stockUnit: item.unit, packMultiplier: factor, stockQuantity, receiptUnitCost, lineTotal };
  }
  static mapDocument(row) {
    if (!row) return null;
    const totalCost = Number(row.totalCost || 0);
    return { ...row, lineCount: Number(row.lineCount || 0), totalCost, lines: (row.lines || []).map((line) => ({ ...line, quantity: Number(line.quantity), packMultiplier: Number(line.packMultiplier), stockQuantity: Number(line.stockQuantity), unitCost: Number(line.unitCost), receiptUnitCost: Number(line.receiptUnitCost), lineTotal: Number(line.lineTotal) })) };
  }
  async list(venueId, status, dateFilter = {}) {
    const params = [venueId];
    const statusClause = status ? ` AND d.status=$${params.push(status)}` : '';
    const dateRange = [];
    if (dateFilter.documentDateFrom) dateRange.push(`d.document_date >= $${params.push(dateFilter.documentDateFrom)}::date`);
    if (dateFilter.documentDateTo) dateRange.push(`d.document_date <= $${params.push(dateFilter.documentDateTo)}::date`);
    const dateClause = dateRange.length
      ? ` AND (${dateRange.join(' AND ')}${dateFilter.includeUndated ? ' OR d.document_date IS NULL' : ''})`
      : '';
    const { rows } = await this.pool.query(`SELECT d.id,d.venue_id AS "venueId",d.supplier_name AS "supplierName",d.document_number AS "documentNumber",d.document_date AS "documentDate",d.recorded_at AS "recordedAt",d.status,d.note,d.source_auto_order_id AS "sourceAutoOrderId",d.created_by AS "createdBy",d.posted_by AS "postedBy",d.posted_at AS "postedAt",d.reversal_policy_version AS "reversalPolicyVersion",d.reversal_policy_mode AS "reversalPolicyMode",d.reversal_policy_enabled AS "reversalPolicyEnabled",CASE WHEN r.id IS NOT NULL THEN json_build_object('id',r.id,'occurredAt',r.occurred_at,'businessDate',r.business_date,'reason',r.reason,'actorId',r.actor_id,'policyVersion',r.policy_version) END AS reversal,COUNT(l.id)::int AS "lineCount",COALESCE(SUM(l.line_total),0) AS "totalCost",COALESCE(json_agg(json_build_object('id',l.id,'ingredientId',l.ingredient_id,'ingredientName',l.ingredient_name_snapshot,'stockUnit',l.stock_unit,'quantity',l.quantity,'unit',l.unit,'packMultiplier',l.pack_multiplier,'stockQuantity',l.stock_quantity,'unitCost',l.unit_cost,'receiptUnitCost',l.receipt_unit_cost,'lineTotal',l.line_total,'sourceMovementId',l.source_movement_id) ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS lines
      FROM inventory_purchase_documents d LEFT JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
      LEFT JOIN inventory_purchase_reversals r ON r.source_document_id=d.id AND r.venue_id=d.venue_id
      WHERE d.venue_id=$1${statusClause}${dateClause} GROUP BY d.id,r.id ORDER BY d.document_date DESC NULLS LAST,d.recorded_at DESC,d.id DESC`, params);
    return rows.map(PurchaseDocumentRepository.mapDocument);
  }
  async get(venueId, id, client = this.pool) {
    const { rows } = await client.query(`SELECT d.id,d.venue_id AS "venueId",d.supplier_name AS "supplierName",d.document_number AS "documentNumber",d.document_date AS "documentDate",d.recorded_at AS "recordedAt",d.status,d.note,d.source_auto_order_id AS "sourceAutoOrderId",d.created_by AS "createdBy",d.posted_by AS "postedBy",d.posted_at AS "postedAt",d.reversal_policy_version AS "reversalPolicyVersion",d.reversal_policy_mode AS "reversalPolicyMode",d.reversal_policy_enabled AS "reversalPolicyEnabled",CASE WHEN r.id IS NOT NULL THEN json_build_object('id',r.id,'occurredAt',r.occurred_at,'businessDate',r.business_date,'reason',r.reason,'actorId',r.actor_id,'policyVersion',r.policy_version) END AS reversal,COUNT(l.id)::int AS "lineCount",COALESCE(SUM(l.line_total),0) AS "totalCost",COALESCE(json_agg(json_build_object('id',l.id,'ingredientId',l.ingredient_id,'ingredientName',l.ingredient_name_snapshot,'stockUnit',l.stock_unit,'quantity',l.quantity,'unit',l.unit,'packMultiplier',l.pack_multiplier,'stockQuantity',l.stock_quantity,'unitCost',l.unit_cost,'receiptUnitCost',l.receipt_unit_cost,'lineTotal',l.line_total,'sourceMovementId',l.source_movement_id) ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS lines
      FROM inventory_purchase_documents d LEFT JOIN inventory_purchase_document_lines l ON l.document_id=d.id LEFT JOIN inventory_purchase_reversals r ON r.source_document_id=d.id AND r.venue_id=d.venue_id WHERE d.id=$1 AND d.venue_id=$2 GROUP BY d.id,r.id`, [id, venueId]);
    return PurchaseDocumentRepository.mapDocument(rows[0]);
  }
  async listPayables(venueId, dateFilter = {}) {
    const params = [venueId];
    const dateRange = [];
    if (dateFilter.documentDateFrom) dateRange.push(`d.document_date >= $${params.push(dateFilter.documentDateFrom)}::date`);
    if (dateFilter.documentDateTo) dateRange.push(`d.document_date <= $${params.push(dateFilter.documentDateTo)}::date`);
    const dateClause = dateRange.length
      ? ` AND (${dateRange.join(' AND ')}${dateFilter.includeUndated ? ' OR d.document_date IS NULL' : ''})`
      : '';
    const { rows } = await this.pool.query(`SELECT d.id,d.supplier_name AS "supplierName",d.document_number AS "documentNumber",d.document_date AS "documentDate",
      COALESCE(SUM(l.line_total),0)::numeric AS "totalCost",
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.venue_id=d.venue_id AND e.purchase_document_id=d.id AND e.source='purchase'),0)::numeric AS "totalPaid"
      FROM inventory_purchase_documents d
      LEFT JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
      WHERE d.venue_id=$1 AND d.status='posted'${dateClause}
      GROUP BY d.id ORDER BY d.document_date DESC NULLS LAST,d.recorded_at DESC,d.id DESC`, params);
    const items = rows.map((row) => {
      const totalCost = Number(row.totalCost || 0);
      const totalPaid = Number(row.totalPaid || 0);
      const balanceDue = Math.max(0, Number((totalCost - totalPaid).toFixed(2)));
      return { ...row, totalCost, totalPaid, balanceDue, paymentStatus: balanceDue <= 0.005 ? 'paid' : totalPaid > 0 ? 'partially_paid' : 'unpaid' };
    });
    return dateFilter.paymentStatus ? items.filter((item) => item.paymentStatus === dateFilter.paymentStatus) : items;
  }
  async listPayments(venueId, documentId) {
    const document = await this.pool.query("SELECT id FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 AND status='posted'", [documentId, venueId]);
    if (!document.rows[0]) return null;
    const { rows } = await this.pool.query(`SELECT e.id,e.amount,to_char(e.expense_date,'YYYY-MM-DD') AS "paymentDate",e.payment_method AS "paymentMethod",e.document_url AS "documentUrl"
      FROM expenses e
      WHERE e.venue_id=$1 AND e.purchase_document_id=$2 AND e.source='purchase'
      ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC`, [venueId, documentId]);
    return rows.map((row) => ({ ...row, amount: Number(row.amount || 0) }));
  }
  async addPayment(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT id,supplier_name AS "supplierName",document_number AS "documentNumber",status
        FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 FOR UPDATE`, [input.id, input.venueId]);
      const document = locked.rows[0];
      if (!document) throw new Error('purchase_document_not_found');
      if (document.status !== 'posted') throw new Error('purchase_document_not_posted');

      const priorResult = await client.query(`SELECT id,purchase_document_id AS "purchaseDocumentId",amount,to_char(expense_date,'YYYY-MM-DD') AS "expenseDate",payment_method AS "paymentMethod",document_url AS "documentUrl"
        FROM expenses WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.venueId, input.idempotencyKey]);
      const prior = priorResult.rows[0];
      if (prior) {
        const samePayload = String(prior.purchaseDocumentId) === String(input.id)
          && Math.round(Number(prior.amount) * 100) === Math.round(input.amount * 100)
          && String(prior.expenseDate).slice(0, 10) === input.paymentDate
          && String(prior.paymentMethod || '') === input.paymentMethod
          && String(prior.documentUrl || '') === String(input.documentUrl || '');
        if (!samePayload) throw new Error('purchase_payment_idempotency_conflict');
        const totals = await client.query(`SELECT COALESCE((SELECT SUM(line_total) FROM inventory_purchase_document_lines WHERE document_id=$1 AND venue_id=$2),0)::numeric AS "totalCost",
          COALESCE((SELECT SUM(amount) FROM expenses WHERE purchase_document_id=$1 AND venue_id=$2 AND source='purchase'),0)::numeric AS "totalPaid"`, [input.id, input.venueId]);
        const totalCost = Number(totals.rows[0].totalCost || 0); const totalPaid = Number(totals.rows[0].totalPaid || 0);
        await client.query('COMMIT');
        return { expenseId: prior.id, amount: Number(prior.amount), paymentDate: input.paymentDate, paymentMethod: prior.paymentMethod, totalCost, totalPaid, balanceDue: Math.max(0, Number((totalCost - totalPaid).toFixed(2))), idempotent: true };
      }

      const totals = await client.query(`SELECT COALESCE((SELECT SUM(line_total) FROM inventory_purchase_document_lines WHERE document_id=$1 AND venue_id=$2),0)::numeric AS "totalCost",
        COALESCE((SELECT SUM(amount) FROM expenses WHERE purchase_document_id=$1 AND venue_id=$2 AND source='purchase'),0)::numeric AS "totalPaid"`, [input.id, input.venueId]);
      const totalCost = Number(totals.rows[0].totalCost || 0); const previousPaid = Number(totals.rows[0].totalPaid || 0);
      const balanceDue = Math.max(0, Number((totalCost - previousPaid).toFixed(2)));
      if (input.amount > balanceDue + 0.005) throw new Error('purchase_payment_exceeds_balance');
      const description = `Оплата поставки «${document.supplierName}»${document.documentNumber ? ` · № ${document.documentNumber}` : ''}`;
      const inserted = await client.query(`INSERT INTO expenses (venue_id,category,amount,expense_date,description,source,document_url,created_by,purchase_document_id,idempotency_key,payment_method)
        VALUES ($1,'Закупка',$2,$3,$4,'purchase',$5,$6,$7,$8,$9)
        RETURNING id`, [input.venueId, input.amount, input.paymentDate, description, input.documentUrl || null, input.createdBy || null, input.id, input.idempotencyKey, input.paymentMethod]);
      const totalPaid = Number((previousPaid + input.amount).toFixed(2));
      await client.query('COMMIT');
      return { expenseId: inserted.rows[0].id, amount: input.amount, paymentDate: input.paymentDate, paymentMethod: input.paymentMethod, totalCost, totalPaid, balanceDue: Math.max(0, Number((totalCost - totalPaid).toFixed(2))), idempotent: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async saveDraft(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sourceOrder = await PurchaseDocumentRepository.assertSourceAutoOrder(client, input.venueId, input.sourceAutoOrderId);
      const { rows } = await client.query(`INSERT INTO inventory_purchase_documents (venue_id,supplier_name,document_number,document_date,note,source_auto_order_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [input.venueId, input.supplierName, input.documentNumber || null, input.documentDate, input.note || null, input.sourceAutoOrderId || null, input.createdBy || null]);
      const documentId = rows[0].id;
      const normalizedLines = [];
      for (const line of input.lines || []) {
        const item = await client.query('SELECT id,name,unit,purchase_unit AS "purchaseUnit",pack_multiplier AS "packMultiplier" FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true', [line.ingredientId, input.venueId]);
        if (!item.rows[0]) { const error = new Error('purchase_ingredient_not_found'); error.ingredientId = line.ingredientId; throw error; }
        const normalized = PurchaseDocumentRepository.lineForItem(line, item.rows[0]);
        normalizedLines.push({ ...normalized, ingredientId: item.rows[0].id, stockUnit: item.rows[0].unit });
        await client.query(`INSERT INTO inventory_purchase_document_lines (document_id,venue_id,ingredient_id,ingredient_name_snapshot,stock_unit,quantity,unit,pack_multiplier,stock_quantity,unit_cost,receipt_unit_cost,line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [documentId, input.venueId, item.rows[0].id, item.rows[0].name, normalized.stockUnit, normalized.quantity, normalized.unit, normalized.packMultiplier, normalized.stockQuantity, normalized.unitCost, normalized.receiptUnitCost, normalized.lineTotal]);
      }
      await PurchaseDocumentRepository.assertAutoOrderAllocation(client, sourceOrder, input.venueId, documentId, normalizedLines);
      const document = await this.get(input.venueId, documentId, client);
      await client.query('COMMIT');
      return document;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async updateDraft(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 FOR UPDATE', [input.id, input.venueId]);
      if (!current.rows[0]) { const error = new Error('purchase_document_not_found'); throw error; }
      if (current.rows[0].status !== 'draft') { const error = new Error('purchase_document_not_draft'); throw error; }
      const sourceOrder = await PurchaseDocumentRepository.assertSourceAutoOrder(client, input.venueId, input.sourceAutoOrderId);
      await client.query('UPDATE inventory_purchase_documents SET supplier_name=$1,document_number=$2,document_date=$3,note=$4,source_auto_order_id=$5 WHERE id=$6 AND venue_id=$7', [input.supplierName, input.documentNumber || null, input.documentDate, input.note || null, input.sourceAutoOrderId || null, input.id, input.venueId]);
      await client.query('DELETE FROM inventory_purchase_document_lines WHERE document_id=$1', [input.id]);
      const normalizedLines = [];
      for (const line of input.lines || []) {
        const item = await client.query('SELECT id,name,unit,purchase_unit AS "purchaseUnit",pack_multiplier AS "packMultiplier" FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true', [line.ingredientId, input.venueId]);
        if (!item.rows[0]) { const error = new Error('purchase_ingredient_not_found'); error.ingredientId = line.ingredientId; throw error; }
        const normalized = PurchaseDocumentRepository.lineForItem(line, item.rows[0]);
        normalizedLines.push({ ...normalized, ingredientId: item.rows[0].id, stockUnit: item.rows[0].unit });
        await client.query(`INSERT INTO inventory_purchase_document_lines (document_id,venue_id,ingredient_id,ingredient_name_snapshot,stock_unit,quantity,unit,pack_multiplier,stock_quantity,unit_cost,receipt_unit_cost,line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [input.id, input.venueId, item.rows[0].id, item.rows[0].name, normalized.stockUnit, normalized.quantity, normalized.unit, normalized.packMultiplier, normalized.stockQuantity, normalized.unitCost, normalized.receiptUnitCost, normalized.lineTotal]);
      }
      await PurchaseDocumentRepository.assertAutoOrderAllocation(client, sourceOrder, input.venueId, input.id, normalizedLines);
      const document = await this.get(input.venueId, input.id, client);
      await client.query('COMMIT');
      return document;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async voidDraft(venueId, id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 FOR UPDATE', [id, venueId]);
      if (!current.rows[0]) throw new Error('purchase_document_not_found');
      if (current.rows[0].status !== 'draft') {
        const error = new Error('purchase_document_not_voidable');
        error.status = current.rows[0].status;
        throw error;
      }
      await client.query("UPDATE inventory_purchase_documents SET status='voided' WHERE id=$1 AND venue_id=$2", [id, venueId]);
      const document = await this.get(venueId, id, client);
      await client.query('COMMIT');
      return document;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async post(venueId, id, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const docResult = await client.query('SELECT id,status,supplier_name AS "supplierName",document_number AS "documentNumber",source_auto_order_id AS "sourceAutoOrderId" FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 FOR UPDATE', [id, venueId]);
      const doc = docResult.rows[0];
      if (!doc) { const error = new Error('purchase_document_not_found'); throw error; }
      if (doc.status !== 'draft') { const error = new Error('purchase_document_not_postable'); error.status = doc.status; throw error; }
      const policyResult = await client.query(`SELECT version,mode,enabled FROM inventory_purchase_reversal_policies
        WHERE venue_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [venueId]);
      const reversalPolicy = policyResult.rows[0];
      if (!reversalPolicy) throw new Error('purchase_reversal_policy_unavailable');
      const sourceOrder = await PurchaseDocumentRepository.assertSourceAutoOrder(client, venueId, doc.sourceAutoOrderId);
      const lines = await client.query(`SELECT l.*,i.is_marked AS ingredient_active,i.cost AS current_cost,i.stock_movement_version AS current_movement_version,i.unit AS current_stock_unit,i.purchase_unit AS current_purchase_unit,i.pack_multiplier AS current_pack_multiplier FROM inventory_purchase_document_lines l JOIN ingredients i ON i.id=l.ingredient_id AND i.venue_id=l.venue_id WHERE l.document_id=$1 AND l.venue_id=$2 ORDER BY l.ingredient_id,l.id FOR UPDATE OF l,i`, [id, venueId]);
      if (!lines.rowCount) { const error = new Error('purchase_document_empty'); throw error; }
      const archivedLine = lines.rows.find((line) => line.ingredient_active !== true);
      if (archivedLine) { const error = new Error('purchase_ingredient_archived'); error.ingredientId = archivedLine.ingredient_id; throw error; }
      const staleUnit = lines.rows.find((line) => {
        const purchaseUnit = String(line.current_purchase_unit || '').trim().toLocaleLowerCase('ru-RU');
        const sourceUnit = String(line.unit || '').trim();
        const factor = purchaseUnit && sourceUnit.toLocaleLowerCase('ru-RU') === purchaseUnit
          ? Number(line.current_pack_multiplier || 1)
          : PURCHASE_UNIT_FACTORS[sourceUnit]?.[line.current_stock_unit];
        return line.stock_unit !== line.current_stock_unit || !factor || Number(line.pack_multiplier) !== Number(factor);
      });
      if (staleUnit) { const error = new Error('purchase_item_unit_changed'); error.ingredientId = staleUnit.ingredient_id; throw error; }
      if (sourceOrder) {
        await PurchaseDocumentRepository.assertAutoOrderAllocation(client, sourceOrder, venueId, id, lines.rows.map((line) => ({ ingredientId: line.ingredient_id, stockUnit: line.stock_unit, stockQuantity: line.stock_quantity })));
      }
      const movementIds = [];
      let totalCost = 0;
      const currentCosts = new Map(lines.rows.map((line) => [line.ingredient_id, Number(line.current_cost || 0)]));
      const currentVersions = new Map(lines.rows.map((line) => [line.ingredient_id, Number(line.current_movement_version || 0)]));
      for (const line of lines.rows) {
        const beforeOnHandResult = await client.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS value
          FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [venueId, line.ingredient_id]);
        const beforeOnHand = Number(beforeOnHandResult.rows[0]?.value || 0);
        const beforeCost = Number(currentCosts.get(line.ingredient_id) || 0);
        const beforeMovementVersion = Number(currentVersions.get(line.ingredient_id) || 0);
        if (!Number.isFinite(beforeOnHand) || beforeOnHand < 0) throw new Error('purchase_reversal_snapshot_unavailable');
        const movement = await client.query(`INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by) VALUES ($1,$2,'in',$3,$4,$5) RETURNING id`, [venueId, line.ingredient_id, line.stock_quantity, `Поставка по документу ${doc.document_number || id}`, actorId || null]);
        const newOnHand = Number((beforeOnHand + Number(line.stock_quantity)).toFixed(6));
        const nextCost = newOnHand > 0 ? ((beforeOnHand * beforeCost) + (Number(line.stock_quantity) * Number(line.receipt_unit_cost))) / newOnHand : Number(line.receipt_unit_cost);
        const preciseNextCost = Number(nextCost.toFixed(4));
        await client.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [preciseNextCost, line.ingredient_id, venueId]);
        const versionCheck = await client.query('SELECT stock_movement_version FROM ingredients WHERE id=$1 AND venue_id=$2', [line.ingredient_id, venueId]);
        const afterMovementVersion = Number(versionCheck.rows[0]?.stock_movement_version);
        if (afterMovementVersion !== beforeMovementVersion + 1) throw new Error('purchase_reversal_snapshot_unavailable');
        currentCosts.set(line.ingredient_id, preciseNextCost);
        currentVersions.set(line.ingredient_id, afterMovementVersion);
        await client.query(`UPDATE inventory_purchase_document_lines SET source_movement_id=$1,on_hand_before_snapshot=$2,cost_before_snapshot=$3,
          on_hand_after_snapshot=$4,cost_after_snapshot=$5,movement_version_before_snapshot=$6,movement_version_after_snapshot=$7 WHERE id=$8 AND venue_id=$9`,
        [movement.rows[0].id,beforeOnHand,beforeCost,newOnHand,preciseNextCost,beforeMovementVersion,afterMovementVersion,line.id,venueId]);
        movementIds.push(movement.rows[0].id); totalCost += Number(line.line_total || 0);
      }
      let nextOrderLines = null; let nextOrderStatus = null;
      if (sourceOrder) {
        const receivedByItem = new Map();
        for (const line of lines.rows) receivedByItem.set(String(line.ingredient_id), (receivedByItem.get(String(line.ingredient_id)) || 0) + Number(line.stock_quantity || 0));
        nextOrderLines = (Array.isArray(sourceOrder.lines) ? sourceOrder.lines : []).map((line) => ({ ...line, receivedQuantity: Number((Number(line.receivedQuantity || 0) + (receivedByItem.get(String(line.itemId)) || 0)).toFixed(6)) }));
        const fullyReceived = nextOrderLines.length > 0 && nextOrderLines.every((line) => Number(line.receivedQuantity || 0) >= Number(line.quantity || 0) - 0.000001);
        nextOrderStatus = fullyReceived ? 'received' : 'partially_received';
        await client.query('UPDATE inventory_auto_orders SET status=$1,lines=$2::jsonb,updated_at=now() WHERE id=$3 AND venue_id=$4', [nextOrderStatus, JSON.stringify(nextOrderLines), sourceOrder.id, venueId]);
      }
      await client.query(`UPDATE inventory_purchase_documents SET status='posted',posted_by=$1,posted_at=now(),reversal_policy_version=$2,
        reversal_policy_mode=$3,reversal_policy_enabled=$4,source_auto_order_status_before=$5,source_auto_order_lines_before=$6::jsonb,
        source_auto_order_status_after=$7,source_auto_order_lines_after=$8::jsonb WHERE id=$9 AND venue_id=$10`,
      [actorId || null,Number(reversalPolicy.version),reversalPolicy.mode,Boolean(reversalPolicy.enabled),sourceOrder?.status || null,
        sourceOrder ? JSON.stringify(sourceOrder.lines || []) : null,nextOrderStatus,sourceOrder ? JSON.stringify(nextOrderLines || []) : null,id,venueId]);
      const document = await this.get(venueId, id, client);
      await client.query('COMMIT');
      return { document, movementIds, totalCost: Math.round(totalCost * 100) / 100 };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async reverse(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const documentResult = await client.query(`SELECT d.id,d.status,d.venue_id AS "venueId",d.document_number AS "documentNumber",
          d.source_auto_order_id AS "sourceAutoOrderId",d.reversal_policy_version AS "policyVersion",
          d.reversal_policy_mode AS "policyMode",d.reversal_policy_enabled AS "policyEnabled",
          d.source_auto_order_status_before AS "orderStatusBefore",d.source_auto_order_lines_before AS "orderLinesBefore",
          d.source_auto_order_status_after AS "orderStatusAfter",d.source_auto_order_lines_after AS "orderLinesAfter",
          v.timezone AS "venueTimezone",org.timezone AS "organizationTimezone"
        FROM inventory_purchase_documents d JOIN venues v ON v.id=d.venue_id
        LEFT JOIN organizations org ON org.id=v.organization_id
        WHERE d.id=$1 AND d.venue_id=$2 AND v.organization_id=$3 AND v.is_active=true FOR UPDATE OF d,v`, [input.documentId,input.venueId,input.organizationId]);
      const document = documentResult.rows[0];
      if (!document) throw new Error('purchase_document_not_found');
      const actor = await client.query(`SELECT u.id FROM users u WHERE u.id=$1 AND u.organization_id=$2 AND u.is_active=true
        AND (u.venue_id=$3 OR EXISTS (SELECT 1 FROM organization_memberships om WHERE om.organization_id=$2 AND om.user_id=u.id AND om.status='active')) FOR SHARE`, [input.actorId,input.organizationId,input.venueId]);
      if (!actor.rows[0]) throw new Error('purchase_document_reversal_actor_invalid');
      const policyVersion = Number(document.policyVersion || 0);
      const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify({
        action: 'purchase_document_reverse', venueId: input.venueId, documentId: input.documentId,
        reason: input.reason, policyVersion
      })).digest('hex');
      const prior = await client.query(`SELECT id,source_document_id AS "sourceDocumentId",payload_sha256 AS "payloadSha256",result_snapshot AS result
        FROM inventory_purchase_reversals WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.venueId,input.idempotencyKey]);
      if (prior.rows[0]) {
        if (String(prior.rows[0].sourceDocumentId) !== String(input.documentId) || prior.rows[0].payloadSha256 !== payloadSha256) throw new Error('purchase_document_reversal_idempotency_conflict');
        await client.query('COMMIT');
        return { reversal: prior.rows[0].result, idempotent: true };
      }
      if (document.status !== 'posted') throw new Error('purchase_document_not_reversible');
      if (document.policyMode !== 'safe_full_unpaid_unused' || document.policyEnabled !== true || policyVersion < 1) throw new Error('purchase_document_reversal_policy_unavailable');
      const savedPolicy = await client.query(`SELECT version,mode,enabled FROM inventory_purchase_reversal_policies WHERE venue_id=$1 AND version=$2`, [input.venueId,policyVersion]);
      if (!savedPolicy.rows[0] || savedPolicy.rows[0].mode !== document.policyMode) throw new Error('purchase_document_reversal_policy_unavailable');
      const alreadyReversed = await client.query(`SELECT id FROM inventory_purchase_reversals WHERE venue_id=$1 AND source_document_id=$2 FOR UPDATE`, [input.venueId,input.documentId]);
      if (alreadyReversed.rows[0]) throw new Error('purchase_document_already_reversed');

      const openShifts = await client.query(`SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC FOR UPDATE`, [input.venueId]);
      if (openShifts.rowCount !== 1) throw new Error('purchase_document_reversal_open_shift_required');
      const businessContext = await client.query(`SELECT (now() AT TIME ZONE COALESCE(NULLIF($1,''),NULLIF($2,''),'Asia/Yekaterinburg'))::date::text AS "businessDate",now() AS "occurredAt"`, [document.venueTimezone,document.organizationTimezone]);
      const businessDate = businessContext.rows[0]?.businessDate;
      const occurredAt = businessContext.rows[0]?.occurredAt;
      if (!businessDate || !occurredAt) throw new Error('purchase_document_reversal_date_unavailable');

      const unlinkedPurchasePayment = await client.query(`SELECT id FROM expenses WHERE venue_id=$1 AND source='purchase' AND purchase_document_id IS NULL LIMIT 1 FOR KEY SHARE`, [input.venueId]);
      if (unlinkedPurchasePayment.rowCount) throw new Error('purchase_document_reversal_payment_coverage_unavailable');
      const paymentRows = await client.query(`SELECT id FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase' FOR UPDATE`, [input.venueId,input.documentId]);
      if (paymentRows.rowCount) throw new Error('purchase_document_reversal_paid');
      const linesResult = await client.query(`SELECT l.id,l.ingredient_id AS "ingredientId",l.stock_unit AS "stockUnit",l.stock_quantity AS "stockQuantity",
          l.source_movement_id AS "sourceMovementId",l.on_hand_before_snapshot AS "onHandBefore",l.cost_before_snapshot AS "costBefore",
          l.on_hand_after_snapshot AS "onHandAfter",l.cost_after_snapshot AS "costAfter",
          l.movement_version_before_snapshot AS "versionBefore",l.movement_version_after_snapshot AS "versionAfter",
          m.direction AS "sourceDirection",m.quantity AS "sourceMovementQuantity",i.cost AS "currentCost",i.stock_movement_version AS "currentMovementVersion"
        FROM inventory_purchase_document_lines l
        JOIN stock_movements m ON m.id=l.source_movement_id AND m.venue_id=l.venue_id AND m.ingredient_id=l.ingredient_id
        JOIN ingredients i ON i.id=l.ingredient_id AND i.venue_id=l.venue_id
        WHERE l.document_id=$1 AND l.venue_id=$2
        ORDER BY l.ingredient_id,l.movement_version_after_snapshot DESC,l.id DESC
        FOR UPDATE OF l,m,i`, [input.documentId,input.venueId]);
      if (!linesResult.rowCount) throw new Error('purchase_document_reversal_snapshot_unavailable');
      const lines = linesResult.rows;
      for (const line of lines) {
        if (line.sourceDirection !== 'in' || Number(line.sourceMovementQuantity) !== Number(line.stockQuantity)
          || line.onHandBefore === null || line.costBefore === null || line.onHandAfter === null || line.costAfter === null
          || line.versionBefore === null || line.versionAfter === null) throw new Error('purchase_document_reversal_snapshot_unavailable');
      }
      const newestByIngredient = new Map();
      for (const line of lines) {
        const key = String(line.ingredientId);
        if (!newestByIngredient.has(key) || Number(newestByIngredient.get(key).versionAfter) < Number(line.versionAfter)) newestByIngredient.set(key,line);
      }
      for (const [ingredientId,line] of newestByIngredient) {
        const stock = await client.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS value
          FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [input.venueId,ingredientId]);
        if (Number(stock.rows[0]?.value || 0).toFixed(6) !== Number(line.onHandAfter).toFixed(6)
          || Number(line.currentCost).toFixed(4) !== Number(line.costAfter).toFixed(4)
          || Number(line.currentMovementVersion) !== Number(line.versionAfter)) throw new Error('purchase_document_reversal_stock_changed');
      }

      let autoOrder = null;
      if (document.sourceAutoOrderId) {
        if (!document.orderStatusBefore || !document.orderLinesBefore || !document.orderStatusAfter || !document.orderLinesAfter) throw new Error('purchase_document_reversal_auto_order_unavailable');
        const order = await client.query(`SELECT id,status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2 FOR UPDATE`, [document.sourceAutoOrderId,input.venueId]);
        if (!order.rows[0]) throw new Error('purchase_document_reversal_auto_order_unavailable');
        const draft = await client.query(`SELECT 1 FROM inventory_purchase_documents WHERE venue_id=$1 AND source_auto_order_id=$2 AND status='draft' LIMIT 1`, [input.venueId,document.sourceAutoOrderId]);
        if (draft.rowCount) throw new Error('purchase_document_reversal_auto_order_changed');
        const matches = await client.query(`SELECT ($1::text=$2::text AND $3::jsonb=$4::jsonb) AS matches`, [order.rows[0].status,document.orderStatusAfter,JSON.stringify(order.rows[0].lines || []),JSON.stringify(document.orderLinesAfter)]);
        if (!matches.rows[0]?.matches) throw new Error('purchase_document_reversal_auto_order_changed');
        autoOrder = { id: order.rows[0].id, status: order.rows[0].status, lines: order.rows[0].lines };
      }

      const reversalId = crypto.randomUUID();
      const reversalLines = lines.map((line) => ({ ...line, reversalLineId: crypto.randomUUID(), reversalMovementId: crypto.randomUUID() }));
      const resultSnapshot = {
        id: reversalId, sourceDocumentId: input.documentId, policyVersion, policyMode: document.policyMode,
        businessDate, occurredAt, reason: input.reason, shiftId: openShifts.rows[0].id, actorId: input.actorId,
        movements: reversalLines.map((line) => ({ id: line.reversalMovementId, sourceMovementId: line.sourceMovementId, ingredientId: line.ingredientId, quantity: Number(line.stockQuantity), unit: line.stockUnit }))
      };
      await client.query(`INSERT INTO inventory_purchase_reversals (id,venue_id,source_document_id,policy_version,policy_mode,source_auto_order_id,shift_id,actor_id,reason,idempotency_key,payload_sha256,business_date,occurred_at,result_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [reversalId,input.venueId,input.documentId,policyVersion,document.policyMode,document.sourceAutoOrderId,openShifts.rows[0].id,input.actorId,input.reason,input.idempotencyKey,payloadSha256,businessDate,occurredAt,JSON.stringify(resultSnapshot)]);

      const runningState = new Map();
      for (const line of reversalLines) {
        const key = String(line.ingredientId);
        let state = runningState.get(key);
        if (!state) {
          state = { onHand: Number(line.onHandAfter), cost: Number(line.costAfter), version: Number(line.versionAfter) };
          runningState.set(key,state);
        }
        if (state.onHand.toFixed(6) !== Number(line.onHandAfter).toFixed(6) || state.cost.toFixed(4) !== Number(line.costAfter).toFixed(4)) throw new Error('purchase_document_reversal_valuation_changed');
        const versionBeforeReverse = state.version;
        await client.query(`INSERT INTO inventory_purchase_reversal_lines (id,venue_id,reversal_id,source_line_id,ingredient_id,source_movement_id,reversal_movement_id,quantity,stock_unit,restored_on_hand,restored_cost,source_movement_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [line.reversalLineId,input.venueId,reversalId,line.id,line.ingredientId,line.sourceMovementId,line.reversalMovementId,line.stockQuantity,line.stockUnit,line.onHandBefore,line.costBefore,line.versionAfter]);
        await client.query(`INSERT INTO stock_movements (id,venue_id,ingredient_id,direction,quantity,reason,created_by,purchase_reversal_id,purchase_reversal_line_id)
          VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8)`, [line.reversalMovementId,input.venueId,line.ingredientId,line.stockQuantity,`Сторно прихода ${document.documentNumber || input.documentId}`,input.actorId,reversalId,line.reversalLineId]);
        await client.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [line.costBefore,line.ingredientId,input.venueId]);
        const restoredStock = await client.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS value FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [input.venueId,line.ingredientId]);
        const updatedVersion = await client.query('SELECT stock_movement_version FROM ingredients WHERE id=$1 AND venue_id=$2', [line.ingredientId,input.venueId]);
        state.onHand = Number(restoredStock.rows[0]?.value || 0);
        state.cost = Number(line.costBefore);
        state.version = Number(updatedVersion.rows[0]?.stock_movement_version);
        if (state.onHand.toFixed(6) !== Number(line.onHandBefore).toFixed(6) || state.version !== versionBeforeReverse + 1) throw new Error('purchase_document_reversal_stock_changed');
      }
      if (autoOrder) await client.query(`UPDATE inventory_auto_orders SET status=$1,lines=$2::jsonb,updated_at=now() WHERE id=$3 AND venue_id=$4`, [document.orderStatusBefore,JSON.stringify(document.orderLinesBefore),autoOrder.id,input.venueId]);
      await client.query(`INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES ($1,$2,'inventory.purchase_document_reversed','purchase_document_reversal',$3,$4::jsonb,$5::jsonb)`,
      [input.venueId,input.actorId,reversalId,JSON.stringify({ sourceDocumentId: input.documentId, sourceStatus: 'posted', sourceAutoOrderId: document.sourceAutoOrderId || null, sourceAutoOrderStatus: autoOrder?.status || null }),JSON.stringify(resultSnapshot)]);
      await client.query('COMMIT');
      return { reversal: resultSnapshot, idempotent: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
}

class ProductRepository {
  constructor(pool) { this.pool = pool; }
  async list(venueId) {
    const { rows } = await this.pool.query(`SELECT id,name,category,sale_price AS price,category AS station,search_aliases AS aliases,image_url AS "imageUrl",inventory_mode AS "inventoryMode"
      FROM products WHERE venue_id=$1 AND is_active=true ORDER BY name`, [venueId]);
    return rows.map((row) => ({ ...row, price: Number(row.price), aliases: row.aliases || [] }));
  }
  async create(input) {
    const { rows } = await this.pool.query(`INSERT INTO products (venue_id,name,category,sale_price,search_aliases,image_url,inventory_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,category,sale_price AS price,category AS station,search_aliases AS aliases,image_url AS "imageUrl",inventory_mode AS "inventoryMode"`,
      [input.venueId, input.name, input.category, input.price, input.aliases, input.imageUrl || null, input.inventoryMode || 'tracked']);
    return rows[0] ? { ...rows[0], price: Number(rows[0].price), aliases: rows[0].aliases || [] } : null;
  }
  async update(venueId, id, input, client = this.pool) {
    const fields = []; const values = [id, venueId];
    for (const [column, value] of [['name', input.name], ['category', input.category], ['sale_price', input.price], ['search_aliases', input.aliases], ['image_url', input.imageUrl], ['inventory_mode', input.inventoryMode]]) {
      if (value !== undefined) { values.push(value); fields.push(`${column}=$${values.length}`); }
    }
    if (!fields.length) return null;
    const { rows } = await client.query(`UPDATE products SET ${fields.join(',')} WHERE id=$1 AND venue_id=$2 AND is_active=true
      RETURNING id,name,category,sale_price AS price,category AS station,search_aliases AS aliases,image_url AS "imageUrl",inventory_mode AS "inventoryMode"`, values);
    return rows[0] ? { ...rows[0], price: Number(rows[0].price), aliases: rows[0].aliases || [] } : null;
  }
  async deactivate(venueId, id) {
    const { rows } = await this.pool.query('UPDATE products SET is_active=false WHERE id=$1 AND venue_id=$2 AND is_active=true RETURNING id,name', [id, venueId]);
    return rows[0] || null;
  }
}

class TobaccoCatalogRepository {
  constructor(pool) { this.pool = pool; }
  static map(row) {
    if (!row) return null;
    return { ...row, packageGrams: row.packageGrams == null ? null : Number(row.packageGrams), aliases: Array.isArray(row.aliases) ? row.aliases : [], active: Boolean(row.active) };
  }
  async list(organizationId, venueId, filters = {}) {
    const params = [organizationId, venueId];
    let state = "(scope='organization' OR (scope='venue' AND venue_id=$2))";
    if (filters.status === 'archived') state += ' AND is_active=false';
    else if (filters.status !== 'all') state += ' AND is_active=true';
    if (filters.scope === 'organization') state += " AND scope='organization'";
    if (filters.scope === 'venue') state += " AND scope='venue'";
    if (filters.query) { params.push(`%${filters.query}%`); const q = `$${params.length}`; state += ` AND (brand ILIKE ${q} OR COALESCE(product_line,'') ILIKE ${q} OR flavor ILIKE ${q} OR barcode ILIKE ${q} OR array_to_string(aliases,' ') ILIKE ${q})`; }
    const { rows } = await this.pool.query(`SELECT id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",flavor,product_type AS "productType",package_grams AS "packageGrams",strength,country,leaf_type AS "leafType",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM tobacco_catalog_items WHERE organization_id=$1 AND ${state} ORDER BY lower(brand),lower(product_line),lower(flavor),package_grams NULLS LAST`, params);
    return rows.map(TobaccoCatalogRepository.map);
  }
  async get(organizationId, venueId, id) {
    const { rows } = await this.pool.query(`SELECT id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",flavor,product_type AS "productType",package_grams AS "packageGrams",strength,country,leaf_type AS "leafType",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM tobacco_catalog_items WHERE id=$1 AND organization_id=$2 AND (scope='organization' OR (scope='venue' AND venue_id=$3))`, [id, organizationId, venueId]);
    return TobaccoCatalogRepository.map(rows[0]);
  }
  async create(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.scope === 'venue') {
        const venue = await client.query('SELECT id FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true FOR SHARE', [input.venueId, input.organizationId]);
        if (!venue.rows[0]) throw new Error('tobacco_catalog_venue_not_found');
      }
      const { rows } = await client.query(`INSERT INTO tobacco_catalog_items (organization_id,scope,venue_id,brand,product_line,flavor,product_type,package_grams,strength,country,leaf_type,barcode,aliases,description,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
        RETURNING id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",flavor,product_type AS "productType",package_grams AS "packageGrams",strength,country,leaf_type AS "leafType",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"`, [input.organizationId,input.scope,input.scope === 'venue' ? input.venueId : null,input.brand,input.productLine,input.flavor,input.productType,input.packageGrams,input.strength,input.country,input.leafType,input.barcode,input.aliases,input.description,input.actorId]);
      await client.query('COMMIT');
      return TobaccoCatalogRepository.map(rows[0]);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async update(organizationId, venueId, id, input, actorId) {
    const fields = []; const values = [id, organizationId, venueId];
    const allowed = [['brand','brand'],['productLine','product_line'],['flavor','flavor'],['productType','product_type'],['packageGrams','package_grams'],['strength','strength'],['country','country'],['leafType','leaf_type'],['barcode','barcode'],['aliases','aliases'],['description','description'],['active','is_active']];
    for (const [key,column] of allowed) if (input[key] !== undefined) { values.push(input[key]); fields.push(`${column}=$${values.length}`); }
    if (!fields.length) return this.get(organizationId, venueId, id);
    values.push(actorId); fields.push(`updated_by=$${values.length}`, 'updated_at=now()');
    const { rows } = await this.pool.query(`UPDATE tobacco_catalog_items SET ${fields.join(',')} WHERE id=$1 AND organization_id=$2 AND (scope='organization' OR (scope='venue' AND venue_id=$3)) RETURNING id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",flavor,product_type AS "productType",package_grams AS "packageGrams",strength,country,leaf_type AS "leafType",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"`, values);
    return TobaccoCatalogRepository.map(rows[0]);
  }
}

class AlcoholCatalogRepository {
  constructor(pool) { this.pool = pool; }
  static map(row) {
    if (!row) return null;
    return { ...row, abv: row.abv == null ? null : Number(row.abv), bottleMl: row.bottleMl == null ? null : Number(row.bottleMl), ageYears: row.ageYears == null ? null : Number(row.ageYears), aliases: Array.isArray(row.aliases) ? row.aliases : [], active: Boolean(row.active) };
  }
  async list(organizationId, venueId, filters = {}) {
    const params = [organizationId, venueId];
    let state = "(scope='organization' OR (scope='venue' AND venue_id=$2))";
    if (filters.status === 'archived') state += ' AND is_active=false';
    else if (filters.status !== 'all') state += ' AND is_active=true';
    if (filters.scope === 'organization') state += " AND scope='organization'";
    if (filters.scope === 'venue') state += " AND scope='venue'";
    if (filters.query) { params.push(`%${filters.query}%`); const q = `$${params.length}`; state += ` AND (brand ILIKE ${q} OR COALESCE(product_line,'') ILIKE ${q} OR name ILIKE ${q} OR spirit_type ILIKE ${q} OR COALESCE(spirit_subtype,'') ILIKE ${q} OR country ILIKE ${q} OR barcode ILIKE ${q} OR array_to_string(aliases,' ') ILIKE ${q})`; }
    const { rows } = await this.pool.query(`SELECT id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",name,spirit_type AS "spiritType",spirit_subtype AS "spiritSubtype",country,abv,bottle_ml AS "bottleMl",age_years AS "ageYears",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM alcohol_catalog_items WHERE organization_id=$1 AND ${state} ORDER BY lower(brand),lower(product_line),lower(name),bottle_ml NULLS LAST`, params);
    return rows.map(AlcoholCatalogRepository.map);
  }
  async get(organizationId, venueId, id) {
    const { rows } = await this.pool.query(`SELECT id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",name,spirit_type AS "spiritType",spirit_subtype AS "spiritSubtype",country,abv,bottle_ml AS "bottleMl",age_years AS "ageYears",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM alcohol_catalog_items WHERE id=$1 AND organization_id=$2 AND (scope='organization' OR (scope='venue' AND venue_id=$3))`, [id, organizationId, venueId]);
    return AlcoholCatalogRepository.map(rows[0]);
  }
  async create(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.scope === 'venue') { const venue = await client.query('SELECT id FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true FOR SHARE', [input.venueId, input.organizationId]); if (!venue.rows[0]) throw new Error('alcohol_catalog_venue_not_found'); }
      const { rows } = await client.query(`INSERT INTO alcohol_catalog_items (organization_id,scope,venue_id,brand,product_line,name,spirit_type,spirit_subtype,country,abv,bottle_ml,age_years,barcode,aliases,description,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
        RETURNING id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",name,spirit_type AS "spiritType",spirit_subtype AS "spiritSubtype",country,abv,bottle_ml AS "bottleMl",age_years AS "ageYears",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"`, [input.organizationId,input.scope,input.scope === 'venue' ? input.venueId : null,input.brand,input.productLine,input.name,input.spiritType,input.spiritSubtype,input.country,input.abv,input.bottleMl,input.ageYears,input.barcode,input.aliases,input.description,input.actorId]);
      await client.query('COMMIT'); return AlcoholCatalogRepository.map(rows[0]);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async update(organizationId, venueId, id, input, actorId) {
    const fields = []; const values = [id, organizationId, venueId];
    const allowed = [['brand','brand'],['productLine','product_line'],['name','name'],['spiritType','spirit_type'],['spiritSubtype','spirit_subtype'],['country','country'],['abv','abv'],['bottleMl','bottle_ml'],['ageYears','age_years'],['barcode','barcode'],['aliases','aliases'],['description','description'],['active','is_active']];
    for (const [key,column] of allowed) if (input[key] !== undefined) { values.push(input[key]); fields.push(`${column}=$${values.length}`); }
    if (!fields.length) return this.get(organizationId, venueId, id);
    values.push(actorId); fields.push(`updated_by=$${values.length}`, 'updated_at=now()');
    const { rows } = await this.pool.query(`UPDATE alcohol_catalog_items SET ${fields.join(',')} WHERE id=$1 AND organization_id=$2 AND (scope='organization' OR (scope='venue' AND venue_id=$3)) RETURNING id,organization_id AS "organizationId",scope,venue_id AS "venueId",brand,product_line AS "productLine",name,spirit_type AS "spiritType",spirit_subtype AS "spiritSubtype",country,abv,bottle_ml AS "bottleMl",age_years AS "ageYears",barcode,aliases,description,is_active AS active,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"`, values);
    return AlcoholCatalogRepository.map(rows[0]);
  }
}

class ReservationRepository {
  constructor(pool) { this.pool = pool; }
  async list(venueId, date) {
    const params = [venueId];
    const venueTimezone = `COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg')`;
    const localStartsAt = `(r.starts_at AT TIME ZONE ${venueTimezone})`;
    const dateClause = date ? ` AND ${localStartsAt}::date=$2::date` : '';
    if (date) params.push(date);
    const { rows } = await this.pool.query(`SELECT r.id, g.full_name AS "guestName", g.phone, to_char(${localStartsAt},'YYYY-MM-DD') AS date, to_char(${localStartsAt},'HH24:MI') AS time,
      r.table_id AS "tableId", r.guest_id AS "guestId", t.name AS "tableName", z.name AS "zoneName", r.guests_count AS guests, r.deposit_required AS "depositRequired", r.deposit_paid AS deposit, r.deposit_paid AS "depositPaid", r.deposit_paid AS "legacyDepositPaid", r.verified_deposit_paid AS "verifiedDepositPaid", r.status, r.notes, linked_order.id AS "linkedOrderId", COALESCE(prepayments.receipts,'[]'::jsonb) AS "prepaymentReceipts",COALESCE(allocations.items,'[]'::jsonb) AS "prepaymentAllocations"
      FROM reservations r LEFT JOIN venues v ON v.id=r.venue_id LEFT JOIN guests g ON g.id=r.guest_id LEFT JOIN tables t ON t.id=r.table_id LEFT JOIN zones z ON z.id=t.zone_id
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'available',GREATEST(0,p.amount-COALESCE(a.amount,0)+COALESCE(ar.amount,0)-COALESCE(rr.amount,0)),'method',p.payment_method,'reason',p.reason,'shiftId',p.shift_id,'createdAt',p.created_at,'actorName',u.full_name,'reversals',COALESCE(rr.items,'[]'::jsonb)) ORDER BY p.created_at,p.id) AS receipts FROM reservation_pre_payment_receipts p LEFT JOIN users u ON u.id=p.actor_id
        LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocations x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) a ON true
        LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocation_reversals x JOIN reservation_pre_payment_allocations ax ON ax.venue_id=x.venue_id AND ax.id=x.allocation_id WHERE x.venue_id=p.venue_id AND ax.receipt_id=p.id) ar ON true
        LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount,jsonb_agg(jsonb_build_object('id',x.id,'amount',x.amount,'method',x.payout_method,'reason',x.reason,'shiftId',x.shift_id,'createdAt',x.created_at,'actorName',ru.full_name) ORDER BY x.created_at,x.id) AS items FROM reservation_pre_payment_receipt_reversals x LEFT JOIN users ru ON ru.id=x.actor_id WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) rr ON true
        WHERE p.venue_id=r.venue_id AND p.reservation_id=r.id) prepayments ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',a.id,'receiptId',a.receipt_id,'orderId',a.order_id,'paymentId',a.payment_id,'amount',a.amount,'orderStatus',o.status,'reversalId',ar.id,'reversalReason',ar.reason,'reversedAt',ar.created_at) ORDER BY a.created_at,a.id) AS items FROM reservation_pre_payment_allocations a JOIN orders o ON o.venue_id=a.venue_id AND o.id=a.order_id LEFT JOIN reservation_pre_payment_allocation_reversals ar ON ar.venue_id=a.venue_id AND ar.allocation_id=a.id WHERE a.venue_id=r.venue_id AND a.reservation_id=r.id) allocations ON true
      LEFT JOIN LATERAL (SELECT o.id FROM orders o WHERE o.venue_id=r.venue_id AND o.reservation_id=r.id ORDER BY o.created_at LIMIT 1) linked_order ON true
      WHERE r.venue_id=$1${dateClause} ORDER BY r.starts_at`, params);
    return rows;
  }
  async create(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [input.venueId]);
      const table = await client.query("SELECT t.id,t.status::text AS status FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 AND t.archived_at IS NULL FOR UPDATE OF t", [input.tableId, input.venueId]);
      if (!table.rows[0] || table.rows[0].status === 'blocked') throw new Error('table_not_found_or_unavailable');
      const guest = input.clientId ? await client.query('SELECT id FROM guests WHERE id=$1 AND venue_id=$2', [input.clientId, input.venueId]) : await client.query(`INSERT INTO guests (venue_id, phone, full_name) VALUES ($1,$2,$3) ON CONFLICT (venue_id, phone) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`, [input.venueId, input.phone || null, input.guestName]); if (!guest.rows[0]) throw new Error('guest_not_found');
      const { rows } = await client.query(`INSERT INTO reservations (venue_id, table_id, guest_id, starts_at, guests_count, deposit_required, deposit_paid, status, notes)
        VALUES ($1,$2,$3,($4::timestamp AT TIME ZONE COALESCE((SELECT NULLIF(timezone,'') FROM venues WHERE id=$1),'Asia/Yekaterinburg')),$5,$6,0,'confirmed',$7) RETURNING id`, [input.venueId, input.tableId, guest.rows[0].id, `${input.date}T${input.time}:00`, input.guests || 1, input.deposit || 0, input.notes || null]);
      await client.query('COMMIT');
      return { ...input, id: rows[0].id, depositRequired: Number(input.deposit || 0), depositPaid: 0, legacyDepositPaid: 0, verifiedDepositPaid: 0, prepaymentReceipts: [], deposit: 0, status: 'confirmed' };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

class AuditRepository {
  constructor(pool) { this.pool = pool; }
  async list(venueId, filters = {}) {
    const params = [venueId];
    const clauses = ['a.venue_id=$1'];
    if (filters.action) { params.push(filters.action); clauses.push(`a.action=$${params.length}`); }
    if (filters.entityType) { params.push(filters.entityType); clauses.push(`a.entity_type=$${params.length}`); }
    if (filters.from) { params.push(filters.from); clauses.push(`a.created_at >= $${params.length}::date`); }
    if (filters.to) { params.push(filters.to); clauses.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 300);
    params.push(limit);
    const { rows } = await this.pool.query(`SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.actor_id AS "actorId", COALESCE(u.full_name, 'система') AS actor, a.before_data AS "beforeData", a.after_data AS "afterData", a.created_at AS "createdAt" FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE ${clauses.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length}`, params);
    return rows.map(sanitizeAuditEvent);
  }
  async record(input, client = this.pool) {
    const safe = sanitizeAuditEvent(input);
    await client.query(`INSERT INTO audit_events (venue_id, actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.venueId, input.actorId || null, input.action, input.entityType, input.entityId || null, safe.beforeData, safe.afterData]);
  }
}

class SessionRepository {
  constructor(pool) { this.pool = pool; }
  async create(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Share the user lock with login changes so an in-flight old login cannot
      // create a surviving session after the rename transaction revokes access.
      if (input.expectedLogin !== undefined) {
        const { rows } = await client.query('SELECT login FROM users WHERE id=$1 AND is_active=true AND deleted_at IS NULL FOR UPDATE', [input.userId]);
        if (!rows[0] || rows[0].login !== input.expectedLogin) {
          const error = new Error('authentication_identity_changed');
          error.code = 'AUTH_IDENTITY_CHANGED';
          throw error;
        }
      }
      await client.query(`INSERT INTO auth_sessions (user_id,device_id,token_hash,expires_at,active_venue_id) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id,device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,active_venue_id=COALESCE(EXCLUDED.active_venue_id,auth_sessions.active_venue_id),created_at=now()`, [input.userId, input.deviceId, input.tokenHash, input.expiresAt, input.activeVenueId || null]);
      await client.query(`WITH ranked AS (SELECT token_hash,row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS position FROM auth_sessions WHERE user_id=$1 AND expires_at>now()) DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM ranked WHERE position>2)`, [input.userId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async get(tokenHash) {
    const { rows } = await this.pool.query(`SELECT s.id,s.created_at AS "createdAt",s.expires_at AS "expiresAt",u.id AS "userId",u.organization_id AS "organizationId",COALESCE(s.active_venue_id,u.venue_id) AS "venueId",u.full_name AS name,u.role,u.custom_role_id AS "customRoleId",cr.permission_scopes AS "customRolePermissionScopes",u.avatar_url AS "avatarUrl",u.telegram_url AS telegram,u.phone_numbers AS "phoneNumbers",u.permission_scopes AS "permissionScopes",u.preferences,u.pin_updated_at AS "pinUpdatedAt"
      FROM auth_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN custom_staff_roles cr ON cr.id=u.custom_role_id AND cr.venue_id=COALESCE(s.active_venue_id,u.venue_id) AND cr.is_active=true JOIN organizations o ON o.id=u.organization_id
      JOIN organization_subscriptions os ON os.organization_id=o.id JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=u.id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true AND o.is_active=true AND os.status <> 'cancelled' AND m.status='active'`, [tokenHash]);
    return rows[0] || null;
  }
  async setActiveVenue(tokenHash, venueId, client = this.pool) {
    const { rowCount } = await client.query('UPDATE auth_sessions SET active_venue_id=$1 WHERE token_hash=$2 AND expires_at>now() RETURNING id', [venueId, tokenHash]);
    return rowCount === 1;
  }
  async remove(tokenHash) { await this.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash]); }
}

function createRepositories(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) return null;
  let pg;
  try { pg = require('pg'); } catch { return null; }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30000 });
  return { pool, orders: new OrderRepository(pool), inventory: new InventoryRepository(pool), purchaseDocuments: new PurchaseDocumentRepository(pool), products: new ProductRepository(pool), tobaccoCatalog: new TobaccoCatalogRepository(pool), alcoholCatalog: new AlcoholCatalogRepository(pool), reservations: new ReservationRepository(pool), audit: new AuditRepository(pool), sessions: new SessionRepository(pool) };
}

function createOrderRepository(databaseUrl = process.env.DATABASE_URL) { return createRepositories(databaseUrl)?.orders || null; }

module.exports = { OrderRepository, InventoryRepository, PurchaseDocumentRepository, ProductRepository, TobaccoCatalogRepository, AlcoholCatalogRepository, ReservationRepository, AuditRepository, SessionRepository, createRepositories, createOrderRepository, allocatePremixBatchConsumption };
