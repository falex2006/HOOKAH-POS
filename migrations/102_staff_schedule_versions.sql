ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'shift';
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'planned';
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS break_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE staff_schedules DROP CONSTRAINT IF EXISTS staff_schedules_venue_id_user_id_work_date_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_state_check' AND conrelid='staff_schedules'::regclass) THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedule_state_check CHECK (
      kind IN ('shift','day_off','vacation','sick','other_absence') AND status IN ('planned','cancelled')
      AND version > 0 AND break_minutes >= 0
    );
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS staff_schedule_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES venues(id),
  schedule_id uuid NOT NULL REFERENCES staff_schedules(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  before_data jsonb,
  after_data jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_schedule_events_record_idx ON staff_schedule_events(venue_id,schedule_id,id);
CREATE TABLE IF NOT EXISTS staff_schedule_requests (
  venue_id uuid NOT NULL REFERENCES venues(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(venue_id,actor_id,request_key)
);
