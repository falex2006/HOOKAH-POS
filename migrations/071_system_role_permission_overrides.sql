-- Venue-scoped permission overrides for built-in staff roles.
-- The owner role remains full access; other built-in roles can be tuned
-- without changing the platform defaults shared by new venues.
CREATE TABLE IF NOT EXISTS system_role_permission_overrides (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  role text NOT NULL,
  permission_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, role),
  CHECK (role IN ('admin','manager','developer','senior_bartender','senior_hookah_master','bartender','hookah_master','cleaner','security','technician','other_staff'))
);
