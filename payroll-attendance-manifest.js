'use strict';

const { createHash, randomUUID } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,120}$/;

class PayrollAttendanceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PayrollAttendanceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new PayrollAttendanceError(code, status); };

const parseDate = (value, code) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code, 400);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(code, 400);
  return value;
};

const normalizePeriod = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('payroll_attendance_period_required', 400);
  const periodFrom = parseDate(input.periodFrom, 'invalid_payroll_attendance_period_from');
  const periodTo = parseDate(input.periodTo, 'invalid_payroll_attendance_period_to');
  if (periodTo < periodFrom || periodFrom.slice(0, 7) !== periodTo.slice(0, 7)) fail('invalid_payroll_attendance_period', 400);
  return { periodFrom, periodTo };
};

const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const assertOwner = async (db, principal, lock = false) => {
  if (!principal || !UUID.test(String(principal.userId || '')) || !UUID.test(String(principal.venueId || ''))) {
    fail('payroll_attendance_owner_required', 403);
  }
  const result = await db.query(`SELECT u.id AS user_id,NULLIF(btrim(u.full_name),'') AS user_name,
      v.id AS venue_id,COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS venue_timezone
    FROM users u JOIN venues v ON v.id=u.venue_id
    LEFT JOIN organizations org ON org.id=v.organization_id
    WHERE u.id=$1 AND v.id=$2 AND u.role='owner' AND u.is_active=true AND u.deleted_at IS NULL
    ${lock ? 'FOR SHARE OF u,v' : ''}`, [principal.userId, principal.venueId]);
  const actor = result.rows[0];
  if (!actor?.user_name) fail('payroll_attendance_owner_or_venue_unavailable', 403);
  const timezone = await db.query('SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1 LIMIT 1', [actor.venue_timezone]);
  if (!timezone.rows[0]) fail('payroll_attendance_venue_timezone_invalid', 409);
  return { userId: actor.user_id, name: actor.user_name, venueId: actor.venue_id, timezone: actor.venue_timezone };
};

const mergeIntervals = (intervals) => {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.startMs > last.endMs) merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    else if (interval.endMs > last.endMs) last.endMs = interval.endMs;
  }
  return merged;
};

const buildSourceManifest = async (db, actor, period) => {
  const bounds = await db.query(`SELECT ($1::date::timestamp AT TIME ZONE $3) AS period_start,
      (($2::date + 1)::timestamp AT TIME ZONE $3) AS period_end`,
  [period.periodFrom, period.periodTo, actor.timezone]);
  const periodStart = new Date(bounds.rows[0].period_start).getTime();
  const periodEnd = new Date(bounds.rows[0].period_end).getTime();
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) fail('payroll_attendance_period_unavailable', 409);

  const schedulesResult = await db.query(`SELECT s.id AS schedule_id,s.user_id AS employee_id,s.work_date::text AS work_date,
      s.planned_start,s.planned_end,NULLIF(btrim(u.full_name),'') AS employee_name
    FROM staff_schedules s JOIN users u ON u.venue_id=s.venue_id AND u.id=s.user_id
    WHERE s.venue_id=$1 AND s.work_date BETWEEN $2::date AND $3::date
    ORDER BY s.work_date,s.user_id,s.id`, [actor.venueId, period.periodFrom, period.periodTo]);
  const logsResult = await db.query(`SELECT w.id AS log_id,w.user_id AS employee_id,w.started_at,w.ended_at,w.source,
      NULLIF(btrim(u.full_name),'') AS employee_name
    FROM staff_work_logs w JOIN users u ON u.venue_id=w.venue_id AND u.id=w.user_id
    WHERE w.venue_id=$1 AND w.started_at < $3::timestamptz AND COALESCE(w.ended_at,'infinity'::timestamptz) > $2::timestamptz
    ORDER BY w.user_id,w.started_at,w.ended_at,w.id`, [actor.venueId, new Date(periodStart).toISOString(), new Date(periodEnd).toISOString()]);

  const reasons = new Set();
  const schedules = schedulesResult.rows.map((row) => {
    const startMs = row.planned_start ? new Date(row.planned_start).getTime() : NaN;
    const endMs = row.planned_end ? new Date(row.planned_end).getTime() : NaN;
    const durationMs = endMs - startMs;
    const plannedMinutes = durationMs / 60000;
    if (!row.employee_name) reasons.add('payroll_attendance_employee_identity_missing');
    if (!Number.isSafeInteger(plannedMinutes) || plannedMinutes <= 0 || plannedMinutes > 1440) reasons.add('payroll_attendance_planned_shift_invalid');
    return {
      scheduleId: row.schedule_id,
      employeeId: row.employee_id,
      employeeName: row.employee_name || 'Unknown employee',
      workDate: dateOnly(row.work_date),
      plannedStart: row.planned_start ? iso(row.planned_start) : null,
      plannedEnd: row.planned_end ? iso(row.planned_end) : null,
      startMs,
      endMs,
      plannedMinutes: Number.isSafeInteger(plannedMinutes) && plannedMinutes > 0 && plannedMinutes <= 1440 ? plannedMinutes : 0,
      intervals: []
    };
  });
  if (!schedules.length) reasons.add('payroll_attendance_no_planned_shifts');
  const logs = logsResult.rows.map((row) => ({
    id: row.log_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    startedAt: iso(row.started_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    source: row.source,
    startMs: new Date(row.started_at).getTime(),
    endMs: row.ended_at ? new Date(row.ended_at).getTime() : null
  }));

  for (const log of logs) {
    if (!log.endedAt || !Number.isFinite(log.endMs) || log.endMs <= log.startMs) {
      reasons.add('payroll_attendance_open_or_invalid_work_interval');
      continue;
    }
    const matching = schedules.filter((schedule) => schedule.employeeId === log.employeeId
      && Number.isFinite(schedule.startMs) && Number.isFinite(schedule.endMs)
      && log.startMs < schedule.endMs && log.endMs > schedule.startMs);
    if (!matching.length) { reasons.add('payroll_attendance_work_interval_without_schedule'); continue; }
    if (matching.length !== 1) { reasons.add('payroll_attendance_work_interval_shift_ambiguous'); continue; }
    const schedule = matching[0];
    // No overtime policy is inferred here: an interval outside its planned
    // window requires an explicit schedule/time correction before approval.
    if (log.startMs < schedule.startMs || log.endMs > schedule.endMs) {
      reasons.add('payroll_attendance_work_interval_outside_schedule');
      continue;
    }
    schedule.intervals.push(log);
  }

  const shifts = schedules.map((schedule) => {
    const merged = mergeIntervals(schedule.intervals);
    const workedSeconds = merged.reduce((sum, interval) => sum + (interval.endMs - interval.startMs) / 1000, 0);
    const workedMinutes = Math.floor(workedSeconds / 60 + 0.5);
    if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0 || workedMinutes > schedule.plannedMinutes) {
      reasons.add('payroll_attendance_worked_minutes_invalid');
    }
    return {
      scheduleId: schedule.scheduleId,
      employeeId: schedule.employeeId,
      employeeName: schedule.employeeName,
      workDate: schedule.workDate,
      plannedStart: schedule.plannedStart,
      plannedEnd: schedule.plannedEnd,
      plannedMinutes: schedule.plannedMinutes,
      workedMinutes: Number.isSafeInteger(workedMinutes) && workedMinutes >= 0 ? Math.min(workedMinutes, schedule.plannedMinutes) : 0,
      sourceIntervals: schedule.intervals.map((interval) => ({ id: interval.id, employeeId: interval.employeeId,
        startedAt: interval.startedAt, endedAt: interval.endedAt, source: interval.source })),
      normalizedIntervals: merged.map((interval) => ({ startedAt: new Date(interval.startMs).toISOString(), endedAt: new Date(interval.endMs).toISOString() }))
    };
  });

  const source = {
    venueId: actor.venueId,
    timezone: actor.timezone,
    period,
    schedules: schedules.map(({ scheduleId, employeeId, employeeName, workDate, plannedStart, plannedEnd }) =>
      ({ scheduleId, employeeId, employeeName, workDate, plannedStart, plannedEnd })),
    logs: logs.map(({ id, employeeId, employeeName, startedAt, endedAt, source: sourceKind }) =>
      ({ id, employeeId, employeeName, startedAt, endedAt, source: sourceKind }))
  };
  const sourceWatermark = hash(source);
  return {
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    timezone: actor.timezone,
    sourceWatermark,
    complete: reasons.size === 0,
    reasons: [...reasons].sort(),
    scheduleCount: schedules.length,
    logCount: logs.length,
    shifts
  };
};

const loadApproval = async (db, venueId, approvalId) => {
  if (!approvalId) return null;
  const header = await db.query(`SELECT id AS "approvalId",venue_id AS "venueId",period_from::text AS "periodFrom",
      period_to::text AS "periodTo",revision,venue_timezone AS timezone,reason,
      source_watermark AS "sourceWatermark",source_schedule_count AS "sourceScheduleCount",
      source_log_count AS "sourceLogCount",shift_count AS "shiftCount",approved_by AS "approvedBy",
      approved_by_name AS "approvedByName",approved_at AS "approvedAt",idempotency_key AS "idempotencyKey"
    FROM payroll_attendance_approvals WHERE venue_id=$1 AND id=$2`, [venueId, approvalId]);
  if (!header.rows[0]) return null;
  const shifts = await db.query(`SELECT id AS "shiftId",schedule_source_id AS "scheduleSourceId",employee_id AS "employeeId",
      employee_name_snapshot AS "employeeName",work_date::text AS "workDate",planned_start AS "plannedStart",
      planned_end AS "plannedEnd",planned_minutes AS "plannedMinutes",worked_minutes AS "workedMinutes",
      source_interval_count AS "sourceIntervalCount"
    FROM payroll_attendance_approval_shifts WHERE venue_id=$1 AND approval_id=$2 ORDER BY work_date,employee_name_snapshot,schedule_source_id`,
  [venueId, approvalId]);
  const intervals = await db.query(`SELECT shift_id AS "shiftId",source_work_log_id AS "sourceWorkLogId",
      employee_id AS "employeeId",started_at AS "startedAt",ended_at AS "endedAt",source
    FROM payroll_attendance_approval_intervals WHERE venue_id=$1 AND approval_id=$2 ORDER BY shift_id,started_at,source_work_log_id`,
  [venueId, approvalId]);
  const intervalsByShift = new Map();
  for (const interval of intervals.rows) {
    const key = String(interval.shiftId);
    if (!intervalsByShift.has(key)) intervalsByShift.set(key, []);
    intervalsByShift.get(key).push(interval);
  }
  return { ...header.rows[0], shifts: shifts.rows.map((shift) => ({
    ...shift,
    intervals: intervalsByShift.get(String(shift.shiftId)) || []
  })) };
};

const makePayrollAttendanceManifestService = (pool) => {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('payroll_attendance_pool_required');

  const readCoverageInTransaction = async (db, principal, input = {}) => {
    const period = normalizePeriod(input);
    const actor = await assertOwner(db, principal, false);
    const manifest = await buildSourceManifest(db, actor, period);
    const latest = await db.query(`SELECT id FROM payroll_attendance_approvals
      WHERE venue_id=$1 AND period_from=$2::date AND period_to=$3::date
      ORDER BY revision DESC LIMIT 1`, [actor.venueId, period.periodFrom, period.periodTo]);
    const currentApproval = await loadApproval(db, actor.venueId, latest.rows[0]?.id);
    const history = await db.query(`SELECT id AS "approvalId",revision,source_watermark AS "sourceWatermark",
        approved_by_name AS "approvedByName",approved_at AS "approvedAt",reason
      FROM payroll_attendance_approvals WHERE venue_id=$1 AND period_from=$2::date AND period_to=$3::date
      ORDER BY revision DESC LIMIT 20`, [actor.venueId, period.periodFrom, period.periodTo]);
    return {
      ...manifest,
      stale: Boolean(currentApproval && currentApproval.sourceWatermark !== manifest.sourceWatermark),
      currentApproval,
      history: history.rows
    };
  };

  const readCoverage = async (principal, input = {}) => {
    const period = normalizePeriod(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const coverage = await readCoverageInTransaction(client, principal, period);
      await client.query('COMMIT');
      return coverage;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof PayrollAttendanceError) throw error;
      throw Object.assign(new Error('payroll_attendance_source_unavailable', { cause: error }), { code: 'payroll_attendance_source_unavailable', status: 503 });
    } finally { client.release(); }
  };

  // Composable source component: caller owns the consistent database snapshot.
  // Attendance completeness never establishes pricing/refund/cost completeness.
  const loadVerifiedApprovedAttendanceSourceInTransaction = async (db, principal, input = {}) => {
    if (!db || typeof db.query !== 'function') fail('payroll_attendance_transaction_required', 409);
    const isolation = (await db.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
    if (!['repeatable read', 'serializable'].includes(isolation)) fail('payroll_attendance_consistent_transaction_required', 409);
    const savepoint = `payroll_attendance_source_${randomUUID().replace(/-/g, '')}`;
    try { await db.query(`SAVEPOINT ${savepoint}`); }
    catch (error) { if (error?.code === '25P01') fail('payroll_attendance_transaction_required', 409); throw error; }
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    const period = normalizePeriod(input);
    if (period.periodFrom !== `${period.periodFrom.slice(0, 7)}-01`) fail('payroll_attendance_month_to_date_required', 409);
    const coverage = await readCoverageInTransaction(db, principal, period);
    if (!coverage.complete) fail('payroll_attendance_source_incomplete', 409);
    const approval = coverage.currentApproval;
    if (!approval) fail('payroll_attendance_approval_required', 409);
    if (coverage.stale) fail('payroll_attendance_approval_stale', 409);
    const invalid = () => fail('payroll_attendance_snapshot_invalid', 409);
    if (approval.venueId !== String(principal.venueId).toLowerCase() || approval.periodFrom !== period.periodFrom
      || approval.periodTo !== period.periodTo || approval.timezone !== coverage.timezone
      || approval.sourceScheduleCount !== coverage.scheduleCount || approval.sourceLogCount !== coverage.logCount
      || approval.shiftCount !== coverage.shifts.length || approval.shifts.length !== coverage.shifts.length
      || !Number.isSafeInteger(approval.revision) || approval.revision < 1 || !UUID.test(approval.approvalId)
      || !UUID.test(approval.approvedBy) || !approval.approvedByName?.trim()) invalid();
    const sources = new Map(coverage.shifts.map((shift) => [shift.scheduleId, shift]));
    const ids = new Set();
    const attendance = approval.shifts.map((shift) => {
      const source = sources.get(shift.scheduleSourceId);
      if (!source || ids.has(shift.shiftId) || !UUID.test(shift.shiftId)) invalid();
      ids.add(shift.shiftId); sources.delete(shift.scheduleSourceId);
      if (shift.employeeId !== source.employeeId || shift.employeeName !== source.employeeName
        || shift.workDate !== source.workDate || iso(shift.plannedStart) !== source.plannedStart
        || iso(shift.plannedEnd) !== source.plannedEnd || shift.plannedMinutes !== source.plannedMinutes
        || shift.workedMinutes !== source.workedMinutes || shift.sourceIntervalCount !== source.sourceIntervals.length
        || shift.intervals.length !== source.sourceIntervals.length) invalid();
      const intervals = new Map(source.sourceIntervals.map((interval) => [interval.id, interval]));
      for (const interval of shift.intervals) {
        const original = intervals.get(interval.sourceWorkLogId);
        if (!original || interval.employeeId !== original.employeeId || interval.shiftId !== shift.shiftId
          || iso(interval.startedAt) !== original.startedAt || iso(interval.endedAt) !== original.endedAt
          || interval.source !== original.source) invalid();
        intervals.delete(interval.sourceWorkLogId);
      }
      return { id: shift.shiftId, employeeId: shift.employeeId, date: shift.workDate, approved: true,
        workedMinutes: shift.workedMinutes, plannedMinutes: shift.plannedMinutes };
    });
    return { attendance, attendanceCoverage: { kind: 'approved_attendance_complete', from: period.periodFrom,
      through: period.periodTo, complete: true, watermark: approval.sourceWatermark },
      sourceAttendanceApproval: { approvalId: approval.approvalId, revision: approval.revision,
        sourceWatermark: approval.sourceWatermark, approvedByName: approval.approvedByName,
        approvedAt: iso(approval.approvedAt), periodFrom: approval.periodFrom, periodTo: approval.periodTo } };
  };

  const approveCoverage = async (principal, input = {}) => {
    const period = normalizePeriod(input);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const idempotencyKey = String(input.idempotencyKey || '');
    const sourceWatermark = String(input.sourceWatermark || '');
    if (reason.length < 3 || reason.length > 1000) fail('payroll_attendance_reason_required', 400);
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) fail('invalid_payroll_attendance_idempotency_key', 400);
    if (!/^[0-9a-f]{64}$/.test(sourceWatermark)) fail('invalid_payroll_attendance_watermark', 400);

    const client = await pool.connect();
    const advisoryKey = `payroll-attendance:${String(principal?.venueId || '')}:${period.periodFrom}:${period.periodTo}`;
    let advisoryLocked = false;
    let transactionStarted = false;
    try {
      // Take the per-period session lock before opening the serializable
      // transaction so a waiter receives a fresh snapshot after its predecessor.
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [advisoryKey]);
      advisoryLocked = true;
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      transactionStarted = true;
      const actor = await assertOwner(client, principal, true);
      const existing = await client.query(`SELECT id,period_from::text AS period_from,period_to::text AS period_to,
          reason,source_watermark,approved_by
        FROM payroll_attendance_approvals WHERE venue_id=$1 AND idempotency_key=$2 FOR SHARE`, [actor.venueId, idempotencyKey]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.period_from !== period.periodFrom || row.period_to !== period.periodTo
            || row.reason !== reason || row.source_watermark !== sourceWatermark || row.approved_by !== actor.userId) {
          fail('payroll_attendance_idempotency_conflict', 409);
        }
        const prior = await loadApproval(client, actor.venueId, row.id);
        await client.query('COMMIT');
        transactionStarted = false;
        return prior;
      }

      const manifest = await buildSourceManifest(client, actor, period);
      if (manifest.sourceWatermark !== sourceWatermark) fail('payroll_attendance_source_changed', 409);
      if (!manifest.complete) fail('payroll_attendance_source_incomplete', 409);
      const revisionResult = await client.query(`SELECT COALESCE(MAX(revision),0)::int+1 AS revision
        FROM payroll_attendance_approvals WHERE venue_id=$1 AND period_from=$2::date AND period_to=$3::date`,
      [actor.venueId, period.periodFrom, period.periodTo]);
      const revision = revisionResult.rows[0].revision;
      const header = await client.query(`INSERT INTO payroll_attendance_approvals
        (venue_id,period_from,period_to,revision,venue_timezone,reason,source_watermark,
         source_schedule_count,source_log_count,shift_count,approved_by,approved_by_name,idempotency_key)
        VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id`, [actor.venueId, period.periodFrom, period.periodTo, revision, manifest.timezone, reason,
        manifest.sourceWatermark, manifest.scheduleCount, manifest.logCount, manifest.shifts.length,
        actor.userId, actor.name, idempotencyKey]);
      const approvalId = header.rows[0].id;
      const shiftIdBySchedule = new Map();
      for (const shift of manifest.shifts) {
        const inserted = await client.query(`INSERT INTO payroll_attendance_approval_shifts
          (venue_id,approval_id,schedule_source_id,employee_id,employee_name_snapshot,work_date,
           planned_start,planned_end,planned_minutes,worked_minutes,source_interval_count)
          VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11) RETURNING id`, [
          actor.venueId, approvalId, shift.scheduleId, shift.employeeId, shift.employeeName, shift.workDate,
          shift.plannedStart, shift.plannedEnd, shift.plannedMinutes, shift.workedMinutes, shift.sourceIntervals.length
        ]);
        const shiftId = inserted.rows[0].id;
        shiftIdBySchedule.set(shift.scheduleId, shiftId);
        for (const interval of shift.sourceIntervals) {
          await client.query(`INSERT INTO payroll_attendance_approval_intervals
            (venue_id,approval_id,shift_id,source_work_log_id,employee_id,started_at,ended_at,source)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.venueId, approvalId, shiftId, interval.id,
            interval.employeeId, interval.startedAt, interval.endedAt, interval.source]);
        }
      }
      if (shiftIdBySchedule.size !== manifest.scheduleCount) fail('payroll_attendance_snapshot_incomplete', 409);
      const result = await loadApproval(client, actor.venueId, approvalId);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof PayrollAttendanceError) throw error;
      if (error?.code === '23505') fail('payroll_attendance_idempotency_conflict', 409);
      if (error?.code === '23503' || error?.code === '23514' || error?.code === '22P02') fail('payroll_attendance_source_invalid', 409);
      if (error?.code === '40001' || error?.code === '40P01') fail('payroll_attendance_source_changed', 409);
      throw Object.assign(new Error('payroll_attendance_approval_unavailable', { cause: error }), { code: 'payroll_attendance_approval_unavailable', status: 503 });
    } finally {
      if (advisoryLocked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [advisoryKey]).catch(() => {});
      client.release();
    }
  };

  return { readCoverage, readCoverageInTransaction, loadVerifiedApprovedAttendanceSourceInTransaction, approveCoverage };
};

module.exports = { makePayrollAttendanceManifestService, PayrollAttendanceError, normalizeAttendancePeriod: normalizePeriod };
