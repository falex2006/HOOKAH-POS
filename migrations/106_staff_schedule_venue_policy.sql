-- Venue-configurable scheduling warnings. NULL thresholds disable their checks;
-- business-hour checks are disabled until explicitly enabled. No legal defaults
-- are inferred by this schema.

CREATE TABLE IF NOT EXISTS staff_schedule_venue_policies (
  venue_id uuid PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  max_weekly_minutes integer,
  minimum_rest_minutes integer,
  maximum_consecutive_days integer,
  business_hours_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_weekly_minutes IS NULL OR max_weekly_minutes > 0),
  CHECK (minimum_rest_minutes IS NULL OR minimum_rest_minutes >= 0),
  CHECK (maximum_consecutive_days IS NULL OR maximum_consecutive_days > 0),
  FOREIGN KEY (venue_id, created_by) REFERENCES users(venue_id, id),
  FOREIGN KEY (venue_id, updated_by) REFERENCES users(venue_id, id)
);

CREATE TABLE IF NOT EXISTS staff_schedule_venue_business_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0, 1)),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (end_day_offset = 0 AND end_time > start_time)
    OR (end_day_offset = 1 AND (end_time <> start_time OR start_time = '00:00'))
  ),
  FOREIGN KEY (venue_id) REFERENCES staff_schedule_venue_policies(venue_id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id, created_by) REFERENCES users(venue_id, id),
  FOREIGN KEY (venue_id, updated_by) REFERENCES users(venue_id, id),
  UNIQUE (venue_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_venue_business_interval_active_uq
  ON staff_schedule_venue_business_intervals(venue_id, weekday, start_time, end_time, end_day_offset)
  WHERE active;
CREATE INDEX IF NOT EXISTS staff_schedule_venue_business_interval_lookup_idx
  ON staff_schedule_venue_business_intervals(venue_id, weekday, start_time, id)
  WHERE active;

COMMENT ON TABLE staff_schedule_venue_policies IS
  'Optional per-venue warning thresholds and business-hour check switch; NULL thresholds disable those checks.';
COMMENT ON COLUMN staff_schedule_venue_policies.business_hours_enabled IS
  'False disables business-hour warnings. When true, active intervals define open periods; a weekday with no intervals is closed.';
COMMENT ON TABLE staff_schedule_venue_business_intervals IS
  'One or more venue-local business intervals per ISO weekday; end_day_offset=1 represents an overnight interval.';

ALTER TABLE staff_schedule_config_events
  DROP CONSTRAINT IF EXISTS staff_schedule_config_events_entity_type_check;
ALTER TABLE staff_schedule_config_events
  ADD CONSTRAINT staff_schedule_config_events_entity_type_check
  CHECK (entity_type IN (
    'function', 'employee_function', 'employee_default', 'template_binding',
    'availability_rule', 'availability_exception', 'demand_rule', 'series', 'series_exception',
    'venue_policy'
  ));
