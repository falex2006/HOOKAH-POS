-- Universal scheduling foundation. This migration is additive for existing rows;
-- legacy shifts deliberately receive no invented work function, series, or break interval.

ALTER TABLE staff_schedule_grants
  ADD COLUMN IF NOT EXISTS can_manage_settings boolean NOT NULL DEFAULT false;
ALTER TABLE staff_schedule_grant_events
  ADD COLUMN IF NOT EXISTS previous_can_manage_settings boolean NOT NULL DEFAULT false;
ALTER TABLE staff_schedule_grant_events
  ADD COLUMN IF NOT EXISTS can_manage_settings boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='staff_schedule_settings_manage_check'
      AND conrelid='staff_schedule_grants'::regclass
  ) THEN
    ALTER TABLE staff_schedule_grants
      ADD CONSTRAINT staff_schedule_settings_manage_check
      CHECK (NOT can_manage_settings OR access='manage');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_schedule_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_functions_name_active_uq
  ON staff_schedule_functions(venue_id,lower(trim(name))) WHERE active;
CREATE INDEX IF NOT EXISTS staff_schedule_functions_venue_order_idx
  ON staff_schedule_functions(venue_id,active,sort_order,name,id);

CREATE TABLE IF NOT EXISTS staff_schedule_employee_functions (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  function_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,user_id,function_id),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,function_id) REFERENCES staff_schedule_functions(venue_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_employee_primary_function_uq
  ON staff_schedule_employee_functions(venue_id,user_id) WHERE active AND is_primary;
CREATE INDEX IF NOT EXISTS staff_schedule_employee_functions_lookup_idx
  ON staff_schedule_employee_functions(venue_id,function_id,user_id) WHERE active;

CREATE TABLE IF NOT EXISTS staff_schedule_template_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('employee','crm_role','work_function')),
  target_user_id uuid,
  target_role_key text,
  target_function_id uuid,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_kind='employee' AND target_user_id IS NOT NULL AND target_role_key IS NULL AND target_function_id IS NULL)
    OR (target_kind='crm_role' AND target_user_id IS NULL AND target_role_key IS NOT NULL AND length(trim(target_role_key)) BETWEEN 1 AND 80 AND target_function_id IS NULL)
    OR (target_kind='work_function' AND target_user_id IS NULL AND target_role_key IS NULL AND target_function_id IS NOT NULL)
  ),
  FOREIGN KEY (venue_id,template_id) REFERENCES staff_schedule_templates(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,target_user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,target_function_id) REFERENCES staff_schedule_functions(venue_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_template_binding_employee_uq
  ON staff_schedule_template_bindings(venue_id,template_id,target_user_id) WHERE active AND target_kind='employee';
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_template_binding_role_uq
  ON staff_schedule_template_bindings(venue_id,template_id,target_role_key) WHERE active AND target_kind='crm_role';
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_template_binding_function_uq
  ON staff_schedule_template_bindings(venue_id,template_id,target_function_id) WHERE active AND target_kind='work_function';
CREATE INDEX IF NOT EXISTS staff_schedule_template_binding_lookup_idx
  ON staff_schedule_template_bindings(venue_id,target_kind,priority,template_id) WHERE active;

CREATE TABLE IF NOT EXISTS staff_schedule_employee_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  function_id uuid,
  template_id uuid,
  start_time time,
  end_time time,
  end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0,1)),
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes>=0),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (template_id IS NOT NULL OR (start_time IS NOT NULL AND end_time IS NOT NULL)),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,function_id) REFERENCES staff_schedule_functions(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,template_id) REFERENCES staff_schedule_templates(venue_id,id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (venue_id,user_id,function_id)
);
CREATE INDEX IF NOT EXISTS staff_schedule_employee_defaults_user_idx
  ON staff_schedule_employee_defaults(venue_id,user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS staff_schedule_availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  rule_kind text NOT NULL CHECK (rule_kind IN ('available','unavailable','preferred')),
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0,1)),
  effective_from date NOT NULL,
  effective_to date,
  note text NOT NULL DEFAULT '' CHECK (length(note)<=500),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to>=effective_from),
  CHECK ((end_day_offset=1 AND (end_time<>start_time OR start_time='00:00')) OR (end_day_offset=0 AND end_time>start_time)),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  UNIQUE (venue_id,id)
);
CREATE INDEX IF NOT EXISTS staff_schedule_availability_rules_lookup_idx
  ON staff_schedule_availability_rules(venue_id,user_id,weekday,effective_from,effective_to) WHERE active;

CREATE TABLE IF NOT EXISTS staff_schedule_availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('available','unavailable','preferred')),
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0,1)),
  note text NOT NULL DEFAULT '' CHECK (length(note)<=500),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((end_day_offset=1 AND (end_time<>start_time OR start_time='00:00')) OR (end_day_offset=0 AND end_time>start_time)),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  UNIQUE (venue_id,id)
);
CREATE INDEX IF NOT EXISTS staff_schedule_availability_exceptions_lookup_idx
  ON staff_schedule_availability_exceptions(venue_id,user_id,work_date) WHERE active;

CREATE TABLE IF NOT EXISTS staff_schedule_demand_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  function_id uuid NOT NULL,
  weekday smallint,
  work_date date,
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0,1)),
  required_count smallint NOT NULL CHECK (required_count BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((weekday IS NOT NULL AND weekday BETWEEN 1 AND 7 AND work_date IS NULL) OR (weekday IS NULL AND work_date IS NOT NULL)),
  CHECK ((end_day_offset=1 AND end_time<>start_time) OR (end_day_offset=0 AND end_time>start_time)),
  FOREIGN KEY (venue_id,function_id) REFERENCES staff_schedule_functions(venue_id,id) ON DELETE CASCADE,
  UNIQUE (venue_id,id)
);
CREATE INDEX IF NOT EXISTS staff_schedule_demand_rules_weekly_idx
  ON staff_schedule_demand_rules(venue_id,function_id,weekday,start_time,end_time) WHERE active AND work_date IS NULL;
CREATE INDEX IF NOT EXISTS staff_schedule_demand_rules_date_idx
  ON staff_schedule_demand_rules(venue_id,function_id,work_date,start_time,end_time) WHERE active AND work_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS staff_schedule_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  user_id uuid NOT NULL,
  function_id uuid,
  anchor_date date NOT NULL,
  until_date date NOT NULL,
  timezone text NOT NULL,
  recurrence jsonb NOT NULL CHECK (jsonb_typeof(recurrence)='object'),
  source_template_id uuid,
  source_template_version integer,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides)='object'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (until_date>=anchor_date AND until_date-anchor_date<=365),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,function_id) REFERENCES staff_schedule_functions(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,source_template_id) REFERENCES staff_schedule_templates(venue_id,id) ON DELETE RESTRICT,
  UNIQUE (venue_id,id)
);
CREATE INDEX IF NOT EXISTS staff_schedule_series_lookup_idx
  ON staff_schedule_series(venue_id,user_id,state,anchor_date,until_date);

CREATE TABLE IF NOT EXISTS staff_schedule_config_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL CHECK (entity_type IN ('function','employee_function','employee_default','template_binding','availability_rule','availability_exception','demand_rule','series')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 40),
  before_data jsonb,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_schedule_config_events_entity_idx
  ON staff_schedule_config_events(venue_id,entity_type,entity_id,id);

ALTER TABLE staff_schedules ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS function_id uuid;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS series_id uuid;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS series_occurrence_date date;
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS break_intervals jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedules_break_intervals_array_check' AND conrelid='staff_schedules'::regclass) THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_break_intervals_array_check CHECK (jsonb_typeof(break_intervals)='array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedules_function_tenant_fk' AND conrelid='staff_schedules'::regclass) THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_function_tenant_fk FOREIGN KEY (venue_id,function_id)
      REFERENCES staff_schedule_functions(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedules_series_tenant_fk' AND conrelid='staff_schedules'::regclass) THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_series_tenant_fk FOREIGN KEY (venue_id,series_id)
      REFERENCES staff_schedule_series(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE staff_schedules DROP CONSTRAINT IF EXISTS staff_schedule_state_check;
ALTER TABLE staff_schedules
  ADD CONSTRAINT staff_schedule_state_check CHECK (
    kind IN ('shift','day_off','vacation','sick','other_absence','open_shift')
    AND status IN ('planned','cancelled')
    AND version>0 AND break_minutes>=0
    AND ((series_id IS NULL AND series_occurrence_date IS NULL)
         OR (series_id IS NOT NULL AND series_occurrence_date IS NOT NULL AND kind IN ('shift','open_shift')))
    AND ((kind='open_shift' AND user_id IS NULL AND function_id IS NOT NULL
          AND planned_start IS NOT NULL AND planned_end IS NOT NULL)
         OR (kind<>'open_shift' AND user_id IS NOT NULL))
  );
CREATE INDEX IF NOT EXISTS staff_schedules_function_interval_idx
  ON staff_schedules(venue_id,function_id,planned_start,planned_end) WHERE status='planned';
CREATE INDEX IF NOT EXISTS staff_schedules_series_occurrence_idx
  ON staff_schedules(venue_id,series_id,series_occurrence_date) WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_schedules_open_interval_idx
  ON staff_schedules(venue_id,function_id,planned_start,planned_end) WHERE status='planned' AND kind='open_shift';

DO $$ DECLARE item record; BEGIN
  FOR item IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='staff_schedule_drafts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%cardinality(user_ids)%'
  LOOP
    EXECUTE format('ALTER TABLE staff_schedule_drafts DROP CONSTRAINT %I',item.conname);
  END LOOP;
  ALTER TABLE staff_schedule_drafts
    ADD CONSTRAINT staff_schedule_drafts_user_count_check
    CHECK (cardinality(user_ids) BETWEEN 0 AND 100);
END $$;
