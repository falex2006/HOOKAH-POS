ALTER TABLE staff_schedule_grants ADD COLUMN IF NOT EXISTS can_publish boolean NOT NULL DEFAULT false;
ALTER TABLE staff_schedule_grant_events ADD COLUMN IF NOT EXISTS previous_can_publish boolean NOT NULL DEFAULT false;
ALTER TABLE staff_schedule_grant_events ADD COLUMN IF NOT EXISTS can_publish boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_publish_manage_check' AND conrelid='staff_schedule_grants'::regclass) THEN
  ALTER TABLE staff_schedule_grants ADD CONSTRAINT staff_schedule_publish_manage_check CHECK(NOT can_publish OR access='manage');
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS staff_schedule_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL REFERENCES venues(id),
 name text NOT NULL, from_date date NOT NULL, to_date date NOT NULL,
 user_ids uuid[] NOT NULL, timezone text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','published','discarded')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 operations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(operations)='array' AND jsonb_array_length(operations)<=200),
 base_snapshot jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 published_by uuid REFERENCES users(id), published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(to_date>=from_date AND to_date-from_date<=92),
 CHECK(cardinality(user_ids) BETWEEN 1 AND 100), UNIQUE(venue_id,id)
);
CREATE TABLE IF NOT EXISTS staff_schedule_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL REFERENCES venues(id),
 name text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 archived boolean NOT NULL DEFAULT false, definition jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(venue_id,id)
);
CREATE TABLE IF NOT EXISTS staff_schedule_planning_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 venue_id uuid NOT NULL REFERENCES venues(id), actor_id uuid NOT NULL REFERENCES users(id),
 entity_type text NOT NULL CHECK(entity_type IN ('draft','template')), entity_id uuid NOT NULL,
 action text NOT NULL, before_data jsonb, after_data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_schedule_drafts_venue_idx ON staff_schedule_drafts(venue_id,created_at,id);
CREATE INDEX IF NOT EXISTS staff_schedule_templates_venue_idx ON staff_schedule_templates(venue_id,created_at,id);
CREATE INDEX IF NOT EXISTS staff_schedule_planning_events_entity_idx ON staff_schedule_planning_events(venue_id,entity_type,entity_id,id);
