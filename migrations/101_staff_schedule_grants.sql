-- Schedule delegation is independent of broad staff/custom-role scopes.
-- Only the schedule service may grant it after checking the current venue owner.
CREATE TABLE IF NOT EXISTS staff_schedule_grants (
  venue_id uuid NOT NULL REFERENCES venues(id),
  user_id uuid NOT NULL REFERENCES users(id),
  access text NOT NULL CHECK (access IN ('none','view','manage')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,user_id)
);
CREATE TABLE IF NOT EXISTS staff_schedule_grant_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES venues(id),
  user_id uuid NOT NULL REFERENCES users(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  previous_access text NOT NULL CHECK (previous_access IN ('none','view','manage')),
  access text NOT NULL CHECK (access IN ('none','view','manage')),
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_schedule_grant_events_target_idx
  ON staff_schedule_grant_events(venue_id,user_id,id);
