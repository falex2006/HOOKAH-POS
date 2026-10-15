'use strict';

const { AttendanceError, policy, evaluate } = require('./staff-attendance-domain');
const { resolveAttendanceAccess } = require('./staff-attendance-access');
const sessionColumns = 'id,user_id AS "userId",started_at AS "startedAt",ended_at AS "endedAt",ended_by AS "endedBy",end_reason AS "endReason",basis,schedule_snapshot->>\'reason\' AS "startReason",schedule_snapshot->>\'plannedEnd\' AS "plannedEnd",version';
function requestView(rows, now) {
  return rows.map(row => ({ ...row, status: row.consumedAt ? 'used'
    : ['pending', 'approved'].includes(row.status) && Date.parse(row.windowEnd) <= Date.parse(now) ? 'expired' : row.status }));
}

async function readPolicy(db, venueId) {
  const { rows } = await db.query(`SELECT mode,preparation_minutes AS "preparationMinutes",version
    FROM staff_attendance_policies WHERE venue_id=$1`, [venueId]);
  const current = rows[0];
  return current ? { ...policy({ mode: current.mode, preparationMinutes: current.preparationMinutes }), version: current.version }
    : { ...policy(), version: 0 };
}

async function admission(db, principal, settings, lock = false) {
  // The database clock is authoritative. No caller-supplied date or user is used.
  const { rows: clock } = await db.query('SELECT clock_timestamp() AS now');
  let now = clock[0].now.toISOString();
  const { rows } = await db.query(`SELECT id,user_id AS "userId",kind,status,
      planned_start AS "plannedStart",planned_end AS "plannedEnd",preparation_minutes AS "preparationMinutes"
    FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND kind='shift' AND status='planned'
      AND planned_end > $3::timestamptz AND planned_start <= $3::timestamptz + interval '7 days'
    ORDER BY planned_start,id ${lock ? 'FOR SHARE' : ''}`, [principal.venueId, principal.userId, now]);
  const shifts = rows.map(row => ({ ...row, plannedStart: row.plannedStart?.toISOString(), plannedEnd: row.plannedEnd?.toISOString() }));
  if (lock) now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  return { now, decision: evaluate({ settings: { mode: settings.mode, preparationMinutes: settings.preparationMinutes },
    now, userId: principal.userId, shifts }) };
}

async function selfStatus(pool, principal) {
  const access = await resolveAttendanceAccess(pool, principal);
  if (!access.self) throw new AttendanceError('attendance_self_forbidden', 403);
  const current = await pool.query(`SELECT ${sessionColumns}
    FROM staff_attendance_sessions WHERE venue_id=$1 AND user_id=$2 AND ended_at IS NULL`,
  [principal.venueId, principal.userId]);
  const latestSession = (await pool.query(`SELECT ${sessionColumns} FROM staff_attendance_sessions
    WHERE venue_id=$1 AND user_id=$2 AND ended_at IS NOT NULL
    ORDER BY ended_at DESC,id DESC LIMIT 1`, [principal.venueId, principal.userId])).rows[0] || null;
  const settings = await readPolicy(pool, principal.venueId);
  const requests = (await pool.query(`SELECT id,reason,status,window_start AS "windowStart",window_end AS "windowEnd",
      version,consumed_at AS "consumedAt",decision_note AS "decisionNote" FROM staff_attendance_requests
    WHERE venue_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20`, [principal.venueId, principal.userId])).rows;
  // A running session remains finishable even if the plan has changed.
  if (current.rows[0]) {
    const serverNow = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    return { access, timezone: access.timezone, settings, session: current.rows[0], latestSession, admission: null, requests: requestView(requests, serverNow), serverNow };
  }
  const evaluated = await admission(pool, principal, settings);
  return { access, timezone: access.timezone, settings, session: null, latestSession, admission: evaluated.decision, serverNow: evaluated.now, requests: requestView(requests, evaluated.now) };
}

async function management(pool, principal) {
  const access = await resolveAttendanceAccess(pool, principal);
  if (!access.managePolicy && !access.approve && !access.grant && !access.closeSessions) throw new AttendanceError('attendance_forbidden', 403);
  const settings = await readPolicy(pool, principal.venueId);
  const requests = access.approve ? (await pool.query(`SELECT r.id,r.user_id AS "userId",u.full_name AS "userName",r.reason,r.status,
      r.window_start AS "windowStart",r.window_end AS "windowEnd",r.version,r.consumed_at AS "consumedAt"
    FROM staff_attendance_requests r JOIN users u ON u.id=r.user_id AND u.venue_id=r.venue_id
    WHERE r.venue_id=$1 ORDER BY (r.status='pending' AND r.window_end>clock_timestamp()) DESC,r.created_at DESC LIMIT 100`, [principal.venueId])).rows : [];
  const grants = access.grant ? (await pool.query(`SELECT u.id AS "userId",u.full_name AS name,u.role,
      COALESCE(g.can_manage_policy,false) AS "managePolicy",COALESCE(g.can_approve,false) AS approve,
      COALESCE(g.can_close_sessions,false) AS "closeSessions",COALESCE(g.version,0) AS version
    FROM users u LEFT JOIN staff_attendance_grants g ON g.user_id=u.id AND g.venue_id=u.venue_id
    WHERE u.venue_id=$1 AND u.is_active AND u.deleted_at IS NULL AND u.role IN ('admin','manager') ORDER BY u.full_name,u.id`, [principal.venueId])).rows : [];
  const sessions = access.approve || access.closeSessions ? (await pool.query(`SELECT s.id,s.user_id AS "userId",u.full_name AS "userName",s.started_at AS "startedAt",s.ended_at AS "endedAt",
      s.ended_by AS "endedBy",s.end_reason AS "endReason",s.basis,s.schedule_snapshot->>'reason' AS "startReason",s.schedule_snapshot->>'plannedEnd' AS "plannedEnd",s.version
    FROM staff_attendance_sessions s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id WHERE s.venue_id=$1
    ORDER BY (s.ended_at IS NULL) DESC,s.started_at DESC LIMIT 100`, [principal.venueId])).rows : [];
  const serverNow = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  return { access, settings, requests: requestView(requests, serverNow), grants, sessions, timezone: access.timezone, serverNow };
}
module.exports = { readPolicy, admission, selfStatus, management };
