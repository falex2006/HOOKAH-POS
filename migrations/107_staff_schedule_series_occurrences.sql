-- Stable per-slot lineage allows one series to produce several shifts on one local date.
-- Exceptions are versioned configuration; published schedule rows remain immutable history.

ALTER TABLE staff_schedules
  ADD COLUMN IF NOT EXISTS series_occurrence_key text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedules_series_occurrence_key_check' AND conrelid='staff_schedules'::regclass) THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_series_occurrence_key_check CHECK (
      (series_id IS NULL AND series_occurrence_key IS NULL)
      OR (series_id IS NOT NULL AND series_occurrence_key IS NOT NULL AND length(trim(series_occurrence_key)) BETWEEN 1 AND 80)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS staff_schedules_series_occurrence_uq
  ON staff_schedules(venue_id,series_id,series_occurrence_date,series_occurrence_key)
  WHERE series_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS staff_schedule_series_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  series_id uuid NOT NULL,
  occurrence_date date NOT NULL,
  occurrence_key text NOT NULL CHECK(length(trim(occurrence_key)) BETWEEN 1 AND 80),
  exception_kind text NOT NULL CHECK(exception_kind IN ('skip','manual')),
  payload jsonb,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venue_id,series_id) REFERENCES staff_schedule_series(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,actor_id) REFERENCES users(venue_id,id),
  UNIQUE(venue_id,id)
);

CREATE INDEX IF NOT EXISTS staff_schedule_series_exception_lookup_idx
  ON staff_schedule_series_exceptions(venue_id,series_id,occurrence_date,occurrence_key) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_series_exception_active_uq
  ON staff_schedule_series_exceptions(venue_id,series_id,occurrence_date,occurrence_key) WHERE active;

ALTER TABLE staff_schedule_config_events
  DROP CONSTRAINT IF EXISTS staff_schedule_config_events_entity_type_check;
ALTER TABLE staff_schedule_config_events
  ADD CONSTRAINT staff_schedule_config_events_entity_type_check
  CHECK(entity_type IN ('function','employee_function','employee_default','template_binding','availability_rule',
    'availability_exception','demand_rule','series','venue_policy','series_exception'));

COMMENT ON TABLE staff_schedule_series_exceptions IS
  'Explicit skip/manual override for one local occurrence slot; never silently overwritten by recurrence edits.';
