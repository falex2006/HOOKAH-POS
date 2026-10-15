'use strict';

const { AttendanceError } = require('./staff-attendance-domain');
const { UUID } = require('./staff-schedule-domain');

// Attendance grants are deliberately independent of schedule/staff/cash grants.
async function resolveAttendanceAccess(db, principal) {
  if (!UUID.test(String(principal?.userId || '')) || !UUID.test(String(principal?.venueId || ''))) {
    throw new AttendanceError('attendance_forbidden', 403);
  }
  const { rows } = await db.query(`SELECT u.role,u.venue_id AS "homeVenueId",v.timezone,
      COALESCE(g.can_manage_policy,false) AS "managePolicy",COALESCE(g.can_approve,false) AS approve,
      COALESCE(g.can_close_sessions,false) AS "closeSessions"
    FROM users u JOIN venues v ON v.id=$2
    LEFT JOIN staff_attendance_grants g ON g.venue_id=v.id AND g.user_id=u.id
    WHERE u.id=$1 AND u.is_active AND u.deleted_at IS NULL AND v.is_active
      AND (u.venue_id=v.id OR (u.role='owner' AND u.organization_id=v.organization_id))`,
  [principal.userId, principal.venueId]);
  const row = rows[0];
  if (!row) throw new AttendanceError('attendance_forbidden', 403);
  const owner = row.role === 'owner';
  const delegated = ['admin', 'manager'].includes(row.role);
  return {
    self: row.homeVenueId === principal.venueId,
    grant: owner,
    managePolicy: owner || (delegated && row.managePolicy === true),
    approve: owner || (delegated && row.approve === true),
    closeSessions: owner || (delegated && row.closeSessions === true),
    role: row.role,
    timezone: row.timezone || 'Asia/Yekaterinburg'
  };
}

module.exports = { resolveAttendanceAccess };
