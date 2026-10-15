'use strict';
// Employee-only read model. Never reuse the administrative DTO: it contains
// notes, cancellation reasons, audit identifiers and other employees' absences.
const { resolveAccess } = require('./staff-schedule-access');
const { range, localDate, ScheduleError } = require('./staff-schedule-domain');

async function listPersonal(pool, principal, from, to) {
  const access = await resolveAccess(pool, principal);
  if (!access.self) throw new ScheduleError('schedule_forbidden', 403);
  from ||= localDate(new Date(), access.timezone);
  to ||= from;
  range(from, to);
  const result = await pool.query(`SELECT s.id,s.user_id AS "userId",u.full_name AS "userName",
      s.work_date::text AS "workDate",s.planned_start AS "plannedStart",s.planned_end AS "plannedEnd",
      s.break_minutes AS "breakMinutes",s.kind,f.name AS "functionName"
    FROM staff_schedules s
    JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id
    LEFT JOIN staff_schedule_functions f ON f.id=s.function_id AND f.venue_id=s.venue_id
    WHERE s.venue_id=$1 AND s.status='planned'
      AND (s.user_id=$2 OR s.kind='shift')
      AND (s.work_date BETWEEN $3::date AND $4::date
        OR (s.kind='shift' AND s.planned_start < (($4::date+1)::timestamp AT TIME ZONE $5)
          AND s.planned_end > ($3::date::timestamp AT TIME ZONE $5)))
    ORDER BY s.work_date,s.planned_start NULLS LAST,u.full_name,s.id`,
  [principal.venueId, principal.userId, from, to, access.timezone]);
  const items = [], team = [];
  for (const row of result.rows) {
    const common = { id: row.id, userId: row.userId, userName: row.userName,
      workDate: row.workDate, plannedStart: row.plannedStart, plannedEnd: row.plannedEnd,
      functionName: row.functionName || null };
    if (row.userId === principal.userId) items.push({ ...common, kind: row.kind, breakMinutes: row.breakMinutes || 0 });
    else if (row.kind === 'shift') team.push(common);
  }
  return { selfUserId: principal.userId, timezone: access.timezone, from, to, items, team };
}

module.exports = { listPersonal };
