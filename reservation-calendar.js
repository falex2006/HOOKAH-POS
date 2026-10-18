'use strict';

// Arguments are internal SQL expressions, never request values.
const venueTimezoneSql = (venueId) => `(SELECT COALESCE(
  (SELECT name FROM pg_timezone_names WHERE lower(name)=lower(btrim(calendar_venue.timezone)) LIMIT 1),
  (SELECT name FROM pg_timezone_names WHERE lower(name)=lower(btrim(calendar_org.timezone)) LIMIT 1),
  'Asia/Yekaterinburg') FROM venues calendar_venue LEFT JOIN organizations calendar_org ON calendar_org.id=calendar_venue.organization_id WHERE calendar_venue.id=${venueId})`;
const reservationIsTodaySql = (venueId, startsAt = 'r.starts_at') => `(${startsAt} AT TIME ZONE ${venueTimezoneSql(venueId)})::date=(now() AT TIME ZONE ${venueTimezoneSql(venueId)})::date`;

async function refreshTableReservationStatus(client, tableId, venueId) {
  if (!tableId) return;
  await client.query(`UPDATE tables t SET status=CASE
    WHEN EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.venue_id=$2 AND o.status IN ('open','in_progress','ready')) THEN 'occupied'::table_status
    WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=t.id AND r.venue_id=$2 AND r.status='confirmed' AND ${reservationIsTodaySql('$2')}) THEN 'reserved'::table_status
    ELSE 'free'::table_status END
    FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status<>'blocked'`, [tableId, venueId]);
}

async function reservationDateTimeIsFuture(pool, venueId, date, time, memoryTimezone = 'Asia/Yekaterinburg') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(time))) return false;
  const wallTime = `${date}T${time}:00`;
  const parsed = new Date(`${wallTime}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  if (pool) {
    const timezone = venueTimezoneSql('$1');
    const { rows } = await pool.query(`SELECT ($2::text::timestamp AT TIME ZONE ${timezone})>now()
      AND to_char(($2::text::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone},'YYYY-MM-DD"T"HH24:MI:SS')=$2::text AS valid`, [venueId, wallTime]);
    return rows[0]?.valid === true;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: memoryTimezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return wallTime > `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = { venueTimezoneSql, reservationIsTodaySql, refreshTableReservationStatus, reservationDateTimeIsFuture };
