'use strict';

// Read-only, tenant-scoped source for venue-day turnover scenarios. It matches
// Finance's closed-order total and approved-discount fallback, but cannot attest
// line attribution, commissions, refunds, attendance, or create official runs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DAYS = 31;
const DAY_MS = 86400000;

class PayrollVenueTurnoverSourceError extends Error {
  constructor(code, status = 400, details = undefined) {
    super(code);
    this.name = 'PayrollVenueTurnoverSourceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, status, details) => { throw new PayrollVenueTurnoverSourceError(code, status, details); };
const parseDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
};
const dateCount = (from, through) => Math.floor((Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;

const makeService = (db) => {
  if (!db || typeof db.query !== 'function') throw new TypeError('payroll_venue_turnover_query_required');

  const getVenueDailyTurnover = async (principal, input = {}) => {
    const venueId = String(principal?.venueId || '').toLowerCase();
    const userId = String(principal?.userId || '').toLowerCase();
    if (!UUID.test(venueId) || !UUID.test(userId)) fail('payroll_venue_turnover_owner_required', 403);

    const from = parseDate(input.from);
    const through = parseDate(input.through);
    if (!from || !through || from > through || from !== `${from.slice(0, 7)}-01`
        || from.slice(0, 7) !== through.slice(0, 7) || dateCount(from, through) > MAX_DAYS) {
      fail('invalid_payroll_venue_turnover_period', 400);
    }

    const result = await db.query(`WITH owner_context AS (
        SELECT v.id AS venue_id,v.timezone
        FROM venues v JOIN users u ON u.venue_id=v.id
        WHERE v.id=$1 AND u.id=$2 AND u.role='owner' AND u.is_active=true AND u.deleted_at IS NULL
      ), item_totals AS (
        SELECT oi.order_id,COALESCE(SUM(oi.quantity*oi.unit_price),0)::numeric AS subtotal,
          COALESCE(string_agg(oi.id::text || ':' || oi.quantity::text || ':' || oi.unit_price::text, ',' ORDER BY oi.id),'') AS item_fingerprint
        FROM order_items oi
        JOIN orders io ON io.id=oi.order_id
        JOIN owner_context c ON c.venue_id=io.venue_id
        GROUP BY oi.order_id
      ), approved_manual_discounts AS (
        SELECT d.order_id,
          LEAST(COALESCE(i.subtotal,0),COALESCE(SUM(ROUND(CASE
            WHEN d.type='percent' THEN COALESCE(i.subtotal,0)*LEAST(100,GREATEST(0,d.value))/100
            ELSE GREATEST(0,d.value) END,2)),0))::numeric AS amount,
          COALESCE(string_agg(d.id::text || ':' || d.type || ':' || d.value::text || ':' || d.status::text, ',' ORDER BY d.id),'') AS discount_fingerprint
        FROM discounts d
        JOIN orders od ON od.id=d.order_id
        JOIN owner_context c ON c.venue_id=od.venue_id
        LEFT JOIN item_totals i ON i.order_id=d.order_id
        WHERE d.status='approved'
        GROUP BY d.order_id,i.subtotal
      ), discount_candidates AS (
        SELECT o.id AS order_id,COALESCE(m.amount,0)::numeric AS amount,1 AS source_rank,0 AS priority
        FROM orders o
        JOIN owner_context c ON c.venue_id=o.venue_id
        LEFT JOIN approved_manual_discounts m ON m.order_id=o.id
        UNION ALL
        SELECT o.id,ROUND(COALESCE(i.subtotal,0)*COALESCE(o.group_discount_percent,0)/100,2),2,0
        FROM orders o
        JOIN owner_context c ON c.venue_id=o.venue_id
        LEFT JOIN item_totals i ON i.order_id=o.id
      ), best_discounts AS (
        SELECT DISTINCT ON (order_id) order_id,amount FROM discount_candidates
        ORDER BY order_id,amount DESC,source_rank DESC,priority DESC
      ), discount_totals AS (
        SELECT o.id AS order_id,
          CASE WHEN (o.status='closed' OR o.pricing_locked_at IS NOT NULL)
              AND o.pricing_version IS NOT NULL AND o.discount_total_snapshot IS NOT NULL
            THEN o.discount_total_snapshot
            ELSE LEAST(COALESCE(i.subtotal,0),COALESCE(b.amount,0)) END::numeric AS discount
        FROM orders o
        JOIN owner_context c ON c.venue_id=o.venue_id
        LEFT JOIN item_totals i ON i.order_id=o.id
        LEFT JOIN best_discounts b ON b.order_id=o.id
      ), closed_orders AS (
        SELECT o.id,o.closed_at,(o.closed_at AT TIME ZONE c.timezone)::date AS local_date,
          o.final_total_snapshot,
          CASE WHEN o.final_total_snapshot IS NOT NULL THEN o.final_total_snapshot
            ELSE GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0))) END::numeric AS resolved_total,
          COALESCE(i.item_fingerprint,'') AS item_fingerprint,
          COALESCE(m.discount_fingerprint,'') AS discount_fingerprint,
          COALESCE(i.subtotal,0)::text AS fallback_subtotal,
          COALESCE(d.discount,0)::text AS fallback_discount,
          COALESCE(o.vip_minimum,0)::text AS vip_minimum,
          COALESCE(o.group_discount_percent,0)::text AS group_discount_percent,
          CASE WHEN o.final_total_snapshot IS NULL THEN 'finance_legacy_fallback' ELSE 'final_total_snapshot' END AS amount_source
        FROM orders o CROSS JOIN owner_context c
        LEFT JOIN item_totals i ON i.order_id=o.id
        LEFT JOIN approved_manual_discounts m ON m.order_id=o.id
        LEFT JOIN discount_totals d ON d.order_id=o.id
        WHERE o.venue_id=c.venue_id AND o.status='closed'
          AND o.closed_at >= ($3::date::timestamp AT TIME ZONE c.timezone)
          AND o.closed_at < (($4::date + 1)::timestamp AT TIME ZONE c.timezone)
      ), source_watermark AS (
        SELECT md5(c.venue_id::text || ':' || c.timezone || ':' || $3::text || ':' || $4::text || ':' ||
          COALESCE(string_agg(x.id::text || ':' || x.closed_at::text || ':' || x.amount_source || ':' ||
            COALESCE(x.final_total_snapshot::text,'NULL') || ':' || x.fallback_subtotal || ':' || x.fallback_discount || ':' ||
            x.vip_minimum || ':' || x.group_discount_percent || ':' || x.item_fingerprint || ':' || x.discount_fingerprint, ',' ORDER BY x.id),'')) AS watermark
        FROM owner_context c LEFT JOIN closed_orders x ON true
        GROUP BY c.venue_id,c.timezone
      ), source_anomalies AS (
        SELECT COUNT(*) FILTER (WHERE o.closed_at IS NULL)::int AS missing_closed_at_count
        FROM orders o JOIN owner_context c ON c.venue_id=o.venue_id
        WHERE o.status='closed'
      )
      SELECT c.timezone,d.local_date::date::text AS local_date,
        COALESCE(SUM(ROUND(o.resolved_total * 100)),0)::text AS turnover_cents,
        COUNT(o.id)::int AS closed_order_count,
        COUNT(o.id) FILTER (WHERE o.final_total_snapshot IS NULL)::int AS finance_fallback_order_count,
        a.missing_closed_at_count,w.watermark
      FROM owner_context c
      CROSS JOIN LATERAL generate_series($3::date,$4::date,interval '1 day') AS d(local_date)
      CROSS JOIN source_watermark w
      CROSS JOIN source_anomalies a
      LEFT JOIN closed_orders o ON o.local_date=d.local_date::date
      GROUP BY c.timezone,d.local_date,a.missing_closed_at_count,w.watermark
      ORDER BY d.local_date`, [venueId, userId, from, through]);

    if (!result.rows.length) fail('payroll_venue_turnover_owner_or_venue_unavailable', 403);
    const missingClosedAtCount = Number(result.rows[0].missing_closed_at_count || 0);
    if (missingClosedAtCount > 0) fail('payroll_venue_turnover_closed_at_missing', 409, { missingClosedAtCount });
    const financeFallbackOrderCount = result.rows.reduce((sum, row) => sum + Number(row.finance_fallback_order_count || 0), 0);

    const venueDailyTurnover = result.rows.map((row) => {
      const cents = BigInt(row.turnover_cents);
      if (cents < 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) fail('payroll_venue_turnover_out_of_range', 409);
      return { date: row.local_date, turnoverCents: Number(cents) };
    });
    const expectedDays = dateCount(from, through);
    if (venueDailyTurnover.length !== expectedDays || venueDailyTurnover.some((row, index) => {
      const expectedDate = new Date(Date.parse(`${from}T00:00:00.000Z`) + index * DAY_MS).toISOString().slice(0, 10);
      return row.date !== expectedDate;
    })) fail('payroll_venue_turnover_source_incomplete', 503);

    return {
      venueTimezone: result.rows[0].timezone,
      from,
      through,
      venueDailyTurnover,
      official: false,
      persistence: 'none',
      previewOnly: true,
      source: 'finance_closed_order_total_preview',
      financeFallbackOrderCount,
      amountBasis: 'finance_final_total_or_approved_discount_fallback',
      sourceWatermarkPurpose: 'preview_change_detection_only',
      sourceWatermark: result.rows[0].watermark
    };
  };

  return { getVenueDailyTurnover };
};

module.exports = { makePayrollVenueTurnoverSource: makeService, PayrollVenueTurnoverSourceError };
