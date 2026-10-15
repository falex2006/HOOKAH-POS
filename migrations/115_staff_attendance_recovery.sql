-- Additive recovery metadata. Existing grants stay false; legacy/self-ended
-- sessions keep NULL metadata. Apply before the new attendance backend.
-- Roll back the application, not these columns: dropping them would erase audit
-- context. Attendance recovery never changes payroll, work logs or cash shifts.
ALTER TABLE staff_attendance_grants ADD COLUMN IF NOT EXISTS can_close_sessions boolean NOT NULL DEFAULT false;
ALTER TABLE staff_attendance_sessions ADD COLUMN IF NOT EXISTS ended_by uuid;
ALTER TABLE staff_attendance_sessions ADD COLUMN IF NOT EXISTS end_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='staff_attendance_sessions'::regclass
    AND conname='staff_attendance_sessions_ended_by_fk') THEN
    ALTER TABLE staff_attendance_sessions ADD CONSTRAINT staff_attendance_sessions_ended_by_fk
      FOREIGN KEY (ended_by) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='staff_attendance_sessions'::regclass
    AND conname='staff_attendance_sessions_recovery_check') THEN
    ALTER TABLE staff_attendance_sessions ADD CONSTRAINT staff_attendance_sessions_recovery_check
      CHECK ((ended_by IS NULL AND end_reason IS NULL) OR
        (ended_by IS NOT NULL AND end_reason IS NOT NULL AND ended_at IS NOT NULL
          AND ended_by<>user_id AND length(btrim(end_reason)) BETWEEN 3 AND 500));
  END IF;
END $$;
DROP TRIGGER IF EXISTS staff_attendance_session_end_actor_guard ON staff_attendance_sessions;
CREATE TRIGGER staff_attendance_session_end_actor_guard
  BEFORE INSERT OR UPDATE OF venue_id,ended_by ON staff_attendance_sessions
  FOR EACH ROW WHEN (NEW.ended_by IS NOT NULL)
  EXECUTE FUNCTION staff_schedule_actor_organization_guard('ended_by');
