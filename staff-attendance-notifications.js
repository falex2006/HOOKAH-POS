'use strict';
const { UUID } = require('./staff-schedule-domain');

// Notifications are projections of committed attendance facts, not a second queue.
// Stable keys use notification_reads; current grants are checked on every read.
const feed = `WITH attendance_access AS (
  SELECT u.venue_id=v.id AS self,
    (u.role='owner' OR (u.role IN ('admin','manager') AND COALESCE(g.can_approve,false))) AS approve,
    (u.role='owner' OR (u.role IN ('admin','manager') AND COALESCE(g.can_close_sessions,false))) AS close_sessions
  FROM users u JOIN venues v ON v.id=$1
  LEFT JOIN staff_attendance_grants g ON g.venue_id=v.id AND g.user_id=u.id
  WHERE u.id=$2 AND u.is_active AND u.deleted_at IS NULL AND v.is_active
    AND (u.venue_id=v.id OR (u.role='owner' AND u.organization_id=v.organization_id))
), attendance_feed AS (
  SELECT 'attendance_request:'||r.id::text AS id,'attendance_request'::text AS type,
    'Запрос на выход'::text AS title,u.full_name||' ожидает согласования' AS summary,
    r.created_at AS "createdAt",'/admin#staff-attendance'::text AS href,true AS "requiresAction"
  FROM staff_attendance_requests r JOIN users u ON u.id=r.user_id AND u.venue_id=r.venue_id
  WHERE r.venue_id=$1 AND (SELECT approve FROM attendance_access) AND r.user_id<>$2 AND r.status='pending'
    AND r.window_end>statement_timestamp() AND u.is_active AND u.deleted_at IS NULL
  UNION ALL
  SELECT 'attendance_decision:'||r.id::text,'attendance_decision',
    CASE r.status WHEN 'approved' THEN 'Выход согласован' ELSE 'Выход не согласован' END,
    CASE r.status WHEN 'approved' THEN 'Откройте личную отметку и начните работу до истечения разрешения.' ELSE 'Откройте личную отметку, чтобы посмотреть решение.' END,
    r.decided_at,'/#staff-attendance',r.status='approved' AND r.consumed_at IS NULL
  FROM staff_attendance_requests r
  WHERE r.venue_id=$1 AND (SELECT self FROM attendance_access) AND r.user_id=$2 AND r.status IN ('approved','rejected')
    AND r.decided_at>statement_timestamp()-interval '30 days'
    AND (r.status='rejected' OR r.window_end>statement_timestamp() OR r.consumed_at IS NOT NULL)
  UNION ALL
  SELECT 'attendance_expired:'||r.id::text,'attendance_expired','Срок запроса истёк',
    'Разрешение не использовано. При необходимости отправьте новый запрос.',r.window_end,'/#staff-attendance',false
  FROM staff_attendance_requests r
  WHERE r.venue_id=$1 AND (SELECT self FROM attendance_access) AND r.user_id=$2 AND r.status IN ('pending','approved')
    AND r.consumed_at IS NULL AND r.window_end<=statement_timestamp()
    AND r.window_end>statement_timestamp()-interval '30 days'
  UNION ALL
  SELECT 'attendance_overdue:'||s.id::text,'attendance_overdue','Проверьте незавершённую отметку',
    CASE WHEN s.user_id=$2 THEN 'Работа ещё отмечена как начатая. Завершите отметку, если уже закончили.'
      ELSE u.full_name||': отметка всё ещё открыта. Уточните, продолжается ли работа.' END,
    COALESCE((s.schedule_snapshot->>'plannedEnd')::timestamptz+interval '1 hour',s.started_at+interval '16 hours'),
    CASE WHEN s.user_id=$2 THEN '/#staff-attendance' ELSE '/admin#staff-attendance' END,true
  FROM staff_attendance_sessions s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id
  WHERE s.venue_id=$1 AND s.ended_at IS NULL AND (((SELECT self FROM attendance_access) AND s.user_id=$2)
    OR (SELECT approve OR close_sessions FROM attendance_access))
    AND statement_timestamp()>=COALESCE((s.schedule_snapshot->>'plannedEnd')::timestamptz+interval '1 hour',s.started_at+interval '16 hours')
  UNION ALL
  SELECT 'attendance_closed:'||s.id::text,'attendance_closed','Отметка завершена руководителем',
    'Откройте личную отметку, чтобы посмотреть время и причину.',s.ended_at,'/#staff-attendance',false
  FROM staff_attendance_sessions s WHERE s.venue_id=$1 AND (SELECT self FROM attendance_access) AND s.user_id=$2
    AND s.ended_by IS NOT NULL AND s.ended_at>statement_timestamp()-interval '30 days'
  UNION ALL
  SELECT 'attendance_warning:'||s.id::text,'attendance_warning','Выход вне графика с пояснением',
    u.full_name||' начал работу вне разрешённого интервала.',s.started_at,'/admin#staff-attendance',false
  FROM staff_attendance_sessions s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id
  WHERE s.venue_id=$1 AND (SELECT approve FROM attendance_access) AND s.user_id<>$2 AND s.basis='outside_schedule'
    AND s.policy_snapshot->>'mode'='warn' AND s.started_at>statement_timestamp()-interval '7 days'
)
`;
function params(principal) {
  if (!UUID.test(String(principal?.venueId||'')) || !UUID.test(String(principal?.userId||''))) return null;
  return [principal.venueId,principal.userId];
}
async function collectAttendanceNotifications(pool, principal, limit = 100, unreadOnly = false) {
  const values = params(principal);
  if (!values) return { items: [], unreadCount: 0 };
  const { rows } = await pool.query(`${feed}, attendance_read AS (
    SELECT f.*,r.read_at AS "readAt",count(*) FILTER(WHERE r.read_at IS NULL) OVER()::int AS "sourceUnreadCount"
    FROM attendance_feed f LEFT JOIN notification_reads r ON r.venue_id=$1 AND r.user_id=$2 AND r.notification_key=f.id)
    SELECT * FROM attendance_read WHERE (NOT $4::boolean OR "readAt" IS NULL)
    ORDER BY "requiresAction" DESC,"createdAt" DESC,id LIMIT $3`,[...values,limit,unreadOnly]);
  return { items: rows.map(({sourceUnreadCount,...row})=>row),unreadCount:Number(rows[0]?.sourceUnreadCount||0) };
}
async function markAttendanceNotificationsRead(pool, principal, id = null) {
  const values = params(principal);
  if (!values) return false;
  const result = await pool.query(`${feed}
    INSERT INTO notification_reads(venue_id,user_id,notification_key)
    SELECT $1,$2,f.id FROM attendance_feed f WHERE ($3::text IS NULL OR f.id=$3)
    ON CONFLICT(venue_id,user_id,notification_key) DO UPDATE SET read_at=clock_timestamp()
    RETURNING notification_key`,[...values,id]);
  return result.rowCount>0;
}
module.exports = { collectAttendanceNotifications,markAttendanceNotificationsRead };
