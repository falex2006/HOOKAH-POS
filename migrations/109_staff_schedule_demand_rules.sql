-- Add bounded, venue-local demand overrides while preserving legacy one-date rules.
ALTER TABLE staff_schedule_demand_rules
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS updated_by uuid;

UPDATE staff_schedule_demand_rules r
SET timezone = v.timezone,
    effective_from = COALESCE(r.effective_from, r.work_date),
    effective_to = COALESCE(r.effective_to, r.work_date),
    updated_by = COALESCE(r.updated_by, r.created_by)
FROM venues v
WHERE v.id = r.venue_id
  AND (r.timezone IS NULL OR r.effective_from IS NULL OR r.effective_to IS NULL OR r.updated_by IS NULL);

ALTER TABLE staff_schedule_demand_rules
  ALTER COLUMN timezone SET NOT NULL,
  ALTER COLUMN effective_from DROP NOT NULL,
  ALTER COLUMN updated_by SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_demand_rules_scope_check'
    AND conrelid='staff_schedule_demand_rules'::regclass) THEN
    ALTER TABLE staff_schedule_demand_rules ADD CONSTRAINT staff_schedule_demand_rules_scope_check CHECK (
      (weekday IS NOT NULL AND work_date IS NULL AND effective_from IS NULL AND effective_to IS NULL)
      OR (weekday IS NULL AND work_date IS NOT NULL AND effective_from IS NOT NULL AND effective_to IS NOT NULL
          AND work_date = effective_from AND effective_to >= effective_from AND effective_to <= effective_from + 365)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_demand_rules_updated_by_fk'
    AND conrelid='staff_schedule_demand_rules'::regclass) THEN
    ALTER TABLE staff_schedule_demand_rules ADD CONSTRAINT staff_schedule_demand_rules_updated_by_fk
      FOREIGN KEY (venue_id,updated_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_demand_rules_created_by_tenant_fk'
    AND conrelid='staff_schedule_demand_rules'::regclass) THEN
    ALTER TABLE staff_schedule_demand_rules ADD CONSTRAINT staff_schedule_demand_rules_created_by_tenant_fk
      FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS staff_schedule_demand_rules_override_idx
  ON staff_schedule_demand_rules(venue_id,function_id,effective_from,effective_to,start_time,end_time)
  WHERE active AND weekday IS NULL;

COMMENT ON TABLE staff_schedule_demand_rules IS
  'Tenant-scoped minimum staffing demand. Weekly weekday rules apply unless any date-range override exists for that function/date; override intervals replace the weekly set for that date.';
COMMENT ON COLUMN staff_schedule_demand_rules.timezone IS
  'Venue timezone captured when the rule is created; local dates and wall-clock intervals are interpreted in this timezone.';
