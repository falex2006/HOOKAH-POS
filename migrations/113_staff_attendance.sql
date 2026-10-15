-- Personal attendance only: never feeds staff_work_logs, payroll or cash shifts.
-- Service owns authorization, server timestamps, optimistic versions and atomic
-- mutation + event writes. Event request_fingerprint detects conflicting retries.
CREATE TABLE IF NOT EXISTS staff_attendance_policies (
  venue_id uuid PRIMARY KEY REFERENCES venues(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'free' CHECK (mode IN ('free','warn','approval')),
  preparation_minutes integer NOT NULL DEFAULT 0 CHECK (preparation_minutes BETWEEN 0 AND 240),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_attendance_grants (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  can_manage_policy boolean NOT NULL DEFAULT false,
  can_approve boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,user_id),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS staff_attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(started_at)),
  ended_at timestamptz,
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 80),
  schedule_id uuid,
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot)='object'),
  schedule_snapshot jsonb NOT NULL CHECK (jsonb_typeof(schedule_snapshot)='object'),
  timezone text NOT NULL CHECK (length(btrim(timezone)) BETWEEN 1 AND 80),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  start_request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,user_id,start_request_key),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR (isfinite(ended_at) AND ended_at >= started_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_attendance_sessions_one_open
  ON staff_attendance_sessions(user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_attendance_sessions_history
  ON staff_attendance_sessions(venue_id,user_id,started_at DESC);

CREATE TABLE IF NOT EXISTS staff_attendance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  window_start timestamptz NOT NULL CHECK (isfinite(window_start)),
  window_end timestamptz NOT NULL CHECK (isfinite(window_end)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 1000),
  consumed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,user_id,request_key),
  FOREIGN KEY (venue_id,user_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (window_end > window_start AND window_end <= window_start + interval '24 hours'),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK (decided_at IS NULL OR isfinite(decided_at)),
  CHECK (status NOT IN ('approved','rejected') OR decided_by IS NOT NULL),
  CHECK (status <> 'pending' OR decided_by IS NULL),
  CHECK (consumed_at IS NULL OR (status='approved' AND isfinite(consumed_at)
    AND consumed_at >= window_start AND consumed_at < window_end AND consumed_at >= decided_at))
);
CREATE INDEX IF NOT EXISTS staff_attendance_requests_queue
  ON staff_attendance_requests(venue_id,status,created_at);

CREATE TABLE IF NOT EXISTS staff_attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 80),
  entity_type text NOT NULL CHECK (entity_type IN ('policy','grant','session','request')),
  entity_id uuid NOT NULL,
  before_json jsonb CHECK (before_json IS NULL OR jsonb_typeof(before_json)='object'),
  after_json jsonb CHECK (after_json IS NULL OR jsonb_typeof(after_json)='object'),
  request_key uuid,
  request_fingerprint text CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_data jsonb CHECK (response_data IS NULL OR jsonb_typeof(response_data)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (request_key IS NULL OR (request_fingerprint IS NOT NULL AND response_data IS NOT NULL)),
  UNIQUE (venue_id,actor_id,request_key)
);
CREATE INDEX IF NOT EXISTS staff_attendance_events_entity
  ON staff_attendance_events(venue_id,entity_type,entity_id,created_at);

-- Same-organization audit actors may administer sibling venues; subjects above
-- remain strictly venue-bound. Reuse the tenant guard introduced by migration 112.
DROP TRIGGER IF EXISTS staff_attendance_policy_actor_guard ON staff_attendance_policies;
CREATE TRIGGER staff_attendance_policy_actor_guard
  BEFORE INSERT OR UPDATE OF venue_id,updated_by ON staff_attendance_policies
  FOR EACH ROW EXECUTE FUNCTION staff_schedule_actor_organization_guard('updated_by');
DROP TRIGGER IF EXISTS staff_attendance_grant_actor_guard ON staff_attendance_grants;
CREATE TRIGGER staff_attendance_grant_actor_guard
  BEFORE INSERT OR UPDATE OF venue_id,updated_by ON staff_attendance_grants
  FOR EACH ROW EXECUTE FUNCTION staff_schedule_actor_organization_guard('updated_by');
DROP TRIGGER IF EXISTS staff_attendance_request_actor_guard ON staff_attendance_requests;
CREATE TRIGGER staff_attendance_request_actor_guard
  BEFORE INSERT OR UPDATE OF venue_id,decided_by ON staff_attendance_requests
  FOR EACH ROW WHEN (NEW.decided_by IS NOT NULL)
  EXECUTE FUNCTION staff_schedule_actor_organization_guard('decided_by');
DROP TRIGGER IF EXISTS staff_attendance_event_actor_guard ON staff_attendance_events;
CREATE TRIGGER staff_attendance_event_actor_guard
  BEFORE INSERT OR UPDATE OF venue_id,actor_id ON staff_attendance_events
  FOR EACH ROW EXECUTE FUNCTION staff_schedule_actor_organization_guard('actor_id');

CREATE OR REPLACE FUNCTION staff_attendance_reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff attendance events are append-only' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS staff_attendance_events_immutable ON staff_attendance_events;
CREATE TRIGGER staff_attendance_events_immutable BEFORE UPDATE OR DELETE ON staff_attendance_events
  FOR EACH ROW EXECUTE FUNCTION staff_attendance_reject_event_mutation();
DROP TRIGGER IF EXISTS staff_attendance_events_no_truncate ON staff_attendance_events;
CREATE TRIGGER staff_attendance_events_no_truncate BEFORE TRUNCATE ON staff_attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION staff_attendance_reject_event_mutation();
