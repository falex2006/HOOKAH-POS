'use strict';

// Execution is separate from immutable pricing/order-item snapshots.
const STATIONS = ['bar', 'hookah'];
const ACTIVE = ['open', 'in_progress', 'ready'];
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const executionFields = `e.station AS "preparationStation",COALESCE(e.status,'new') AS "preparationStatus",
  e.dispatched_at AS "preparationDispatchedAt",e.started_at AS "preparationStartedAt",e.ready_at AS "preparationReadyAt"`;

function aggregatePreparation(items) {
  if (!items.length) return 'open';
  const statuses = items.map((item) => item.preparationStatus || 'new');
  if (statuses.every((status) => status === 'ready')) return 'ready';
  return statuses.some((status) => status !== 'new') ? 'in_progress' : 'open';
}

function refreshMemoryPreparation(order) {
  if (ACTIVE.includes(order.status)) order.status = aggregatePreparation(order.items || []);
  return order.status;
}

async function refreshPgPreparation(client, orderId, venueId) {
  // Caller holds the parent order lock, shared with payment/item mutations.
  const { rows } = await client.query(`SELECT COALESCE(e.status,'new') AS "preparationStatus"
    FROM order_items oi LEFT JOIN order_item_execution e ON e.order_item_id=oi.id WHERE oi.order_id=$1`, [orderId]);
  const status = aggregatePreparation(rows);
  const updated = await client.query(`UPDATE orders SET status=$1 WHERE id=$2 AND venue_id=$3
    AND status IN ('open','in_progress','ready') RETURNING status`, [status, orderId, venueId]);
  return updated.rows[0]?.status;
}

async function preparationItems(client, orderId) {
  const { rows } = await client.query(`SELECT oi.id,oi.product_id AS "productId",p.name,oi.quantity,
    oi.unit_price AS "unitPrice",oi.station,oi.status,oi.sales_employee_id AS "salesEmployeeId",
    oi.sold_at AS "soldAt",u.full_name AS "salesEmployeeName",${executionFields}
    FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id
    LEFT JOIN users u ON u.id=oi.sales_employee_id
    LEFT JOIN order_item_execution e ON e.order_item_id=oi.id WHERE oi.order_id=$1 ORDER BY oi.id`, [orderId]);
  return rows.map((row) => ({ ...row, quantity: Number(row.quantity), unitPrice: Number(row.unitPrice) }));
}

function dispatchSelection(items, input) {
  if (!STATIONS.includes(input.station)) throw fail(400, 'invalid_preparation_station');
  if (!Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 500
    || input.itemIds.some((id) => typeof id !== 'string' || !id || id.length > 100)
    || new Set(input.itemIds).size !== input.itemIds.length) throw fail(400, 'invalid_item_ids');
  const selected = input.itemIds.map((id) => items.find((item) => String(item.id) === id));
  if (selected.some((item) => !item)) throw fail(404, 'order_item_not_found');
  if (selected.some((item) => item.preparationStation && item.preparationStation !== input.station)) throw fail(409, 'preparation_station_mismatch');
  if (selected.some((item) => !item.preparationStation && !['new', 'queued'].includes(item.preparationStatus || 'new'))) throw fail(409, 'invalid_preparation_transition');
  return selected;
}

function assertPreparationTransition(item, input, stations) {
  if (!stations.includes(item.preparationStation)) throw fail(403, 'preparation_station_forbidden');
  const predecessors = { in_progress: 'queued', ready: 'in_progress' };
  if (!predecessors[input.status] || input.expectedStatus !== predecessors[input.status]) throw fail(400, 'invalid_preparation_status');
  if (item.preparationStatus === input.status) return false; // Lost-response replay.
  if (item.preparationStatus !== input.expectedStatus) throw fail(409, 'preparation_state_changed');
  return true;
}

async function handleOrderPreparation(ctx) {
  const { req, res, pathname, pool, orders, venueId, body, json, hasPermission, requireOpenShift, recordAudit, tableName } = ctx;
  const dispatch = pathname.match(/^\/api\/orders\/([^/]+)\/dispatch$/);
  const prepare = pathname.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/preparation$/);
  const queue = pathname === '/api/preparation/queue';
  if (!dispatch && !prepare && !queue) return false;
  const send = (status, value) => { json(res, status, value); return true; };
  if ((queue && req.method !== 'GET') || (dispatch && req.method !== 'POST') || (prepare && req.method !== 'PATCH')) return send(405, { error: 'method_not_allowed' });
  if (!hasPermission(req, 'orders')) return send(403, { error: 'forbidden', permission: 'orders' });
  const stations = STATIONS.filter((station) => hasPermission(req, 'tasks_manage') || hasPermission(req, `${station}_tasks`));
  if (queue && !stations.length) return send(200, { items: [], stations });
  if (dispatch && await requireOpenShift(req, res)) return true;
  let client;
  try {
    if (queue) {
      if (pool) {
        const { rows } = await pool.query(`SELECT oi.id,oi.order_id AS "orderId",o.table_id AS "tableId",
          t.name AS "tableName",o.status AS "orderStatus",p.name,oi.quantity,${executionFields}
          FROM order_item_execution e JOIN order_items oi ON oi.id=e.order_item_id
          JOIN orders o ON o.id=oi.order_id LEFT JOIN products p ON p.id=oi.product_id LEFT JOIN tables t ON t.id=o.table_id
          WHERE o.venue_id=$1 AND o.status<>'cancelled' AND e.station=ANY($2::text[])
            AND e.status IN ('queued','in_progress') ORDER BY e.dispatched_at NULLS FIRST,oi.id`, [venueId, stations]);
        return send(200, { items: rows.map((row) => ({ ...row, quantity: Number(row.quantity) })), stations });
      }
      const items = orders.filter((order) => order.venueId === venueId && order.status !== 'cancelled').flatMap((order) => (order.items || [])
        .filter((item) => stations.includes(item.preparationStation) && ['queued', 'in_progress'].includes(item.preparationStatus))
        .map((item) => ({ id: item.id, orderId: order.id, tableId: order.tableId, tableName: tableName(order.tableId), orderStatus: order.status,
          name: item.name, quantity: item.quantity, preparationStation: item.preparationStation, preparationStatus: item.preparationStatus,
          preparationDispatchedAt: item.preparationDispatchedAt, preparationStartedAt: item.preparationStartedAt, preparationReadyAt: item.preparationReadyAt })));
      return send(200, { items, stations });
    }
    const orderId = (dispatch || prepare)[1];
    if (pool && (!uuid(orderId) || (prepare && !uuid(prepare[2])))) return send(404, { error: 'order_not_found' });
    const input = await body(req);
    if (input.expectedVenueId !== undefined && String(input.expectedVenueId) !== String(venueId)) return send(409, { error: 'venue_context_changed' });
    let order, items;
    if (pool) {
      client = await pool.connect(); await client.query('BEGIN');
      const result = await client.query('SELECT id,status FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderId, venueId]);
      order = result.rows[0];
      if (!order) throw fail(404, 'order_not_found');
      items = await preparationItems(client, orderId);
    } else {
      order = orders.find((entry) => entry.id === orderId && entry.venueId === venueId);
      if (!order) throw fail(404, 'order_not_found');
      items = order.items || [];
    }
    if (order.status === 'cancelled' || (dispatch && !ACTIVE.includes(order.status))) throw fail(409, 'order_not_preparable');
    const changed = [];
    if (dispatch) {
      const selected = dispatchSelection(items, input);
      for (const item of selected) {
        if (item.preparationStation && item.preparationStatus !== 'new') continue;
        const now = new Date().toISOString();
        if (client) await client.query(`INSERT INTO order_item_execution(order_item_id,station,status,dispatched_at)
          VALUES($1,$2,'queued',now()) ON CONFLICT(order_item_id) DO UPDATE SET station=EXCLUDED.station,
          status='queued',dispatched_at=COALESCE(order_item_execution.dispatched_at,now())`, [item.id, input.station]);
        else Object.assign(item, { preparationStation: input.station, preparationStatus: 'queued', preparationDispatchedAt: item.preparationDispatchedAt || now });
        changed.push(item.id);
      }
    } else {
      const item = items.find((entry) => String(entry.id) === prepare[2]);
      if (!item) throw fail(404, 'order_item_not_found');
      if (assertPreparationTransition(item, input, stations)) {
        if (client) await client.query(`UPDATE order_item_execution SET status=$1,
          started_at=CASE WHEN $1='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,
          ready_at=CASE WHEN $1='ready' THEN COALESCE(ready_at,now()) ELSE ready_at END WHERE order_item_id=$2`, [input.status, item.id]);
        else Object.assign(item, { preparationStatus: input.status, [input.status === 'ready' ? 'preparationReadyAt' : 'preparationStartedAt']: new Date().toISOString() });
        changed.push(item.id);
      }
    }
    let status;
    if (client) {
      status = await refreshPgPreparation(client, orderId, venueId) || order.status;
      items = await preparationItems(client, orderId);
      await client.query('COMMIT');
    } else status = refreshMemoryPreparation(order);
    const result = { orderId, status, items };
    if (changed.length) recordAudit(req, dispatch ? 'order.items_dispatched' : 'order.item_preparation_changed', 'order', orderId, null,
      { station: input.station || items.find((item) => item.id === prepare?.[2])?.preparationStation, status: input.status || 'queued', itemIds: changed });
    return send(200, result);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return send(error.status || 503, { error: error.code && error.status ? error.code : 'preparation_unavailable' });
  } finally { client?.release(); }
}

module.exports = { handleOrderPreparation, aggregatePreparation, refreshMemoryPreparation, refreshPgPreparation, preparationItems, dispatchSelection, assertPreparationTransition };
