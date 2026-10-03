'use strict';

// Read-only, tenant-scoped source for venue-day turnover scenarios. This is
// deliberately snapshot-only: it cannot attest line attribution, commissions,
// attendance, or create an official payroll run.
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
      ), closed_orders AS (
        SELECT o.id,o.closed_at,(o.closed_at AT TIME ZONE c.timezone)::date AS local_date,
          o.final_total_snapshot,
          CASE WHEN o.final_total_snapshot IS NULL THEN NULL ELSE ROUND(o.final_total_snapshot * 100)::numeric END AS total_cents
        FROM orders o CROSS JOIN owner_context c
        WHERE o.venue_id=c.venue_id AND o.status='closed'
          AND o.closed_at >= ($3::date::timestamp AT TIME ZONE c.timezone)
          AND o.closed_at < (($4::date + 1)::timestamp AT TIME ZONE c.timezone)
      ), source_watermark AS (
        SELECT md5(c.venue_id::text || ':' || c.timezone || ':' || $3::text || ':' || $4::text || ':' ||
          COALESCE(string_agg(x.id::text || ':' || x.closed_at::text || ':' ||
            COALESCE(x.final_total_snapshot::text,'NULL'), ',' ORDER BY x.id),'')) AS watermark
        FROM owner_context c LEFT JOIN closed_orders x ON true
        GROUP BY c.venue_id,c.timezone
      ), source_anomalies AS (
        SELECT COUNT(*) FILTER (WHERE o.closed_at IS NULL)::int AS missing_closed_at_count
        FROM orders o JOIN owner_context c ON c.venue_id=o.venue_id
        WHERE o.status='closed'
      )
      SELECT c.timezone,d.local_date::date::text AS local_date,
        COALESCE(SUM(o.total_cents),0)::text AS turnover_cents,
        COUNT(o.id)::int AS closed_order_count,
        COUNT(o.id) FILTER (WHERE o.final_total_snapshot IS NULL)::int AS missing_snapshot_count,
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
    const missingSnapshotCount = result.rows.reduce((sum, row) => sum + Number(row.missing_snapshot_count || 0), 0);
    if (missingSnapshotCount > 0) fail('payroll_venue_turnover_snapshot_missing', 409, { missingSnapshotCount });

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
      source: 'closed_order_final_total_snapshot_preview',
      sourceWatermarkPurpose: 'preview_change_detection_only',
      sourceWatermark: result.rows[0].watermark
    };
  };

  return { getVenueDailyTurnover };
};

module.exports = { makePayrollVenueTurnoverSource: makeService, PayrollVenueTurnoverSourceError };
