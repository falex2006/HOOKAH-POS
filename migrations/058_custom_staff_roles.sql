-- Venue-scoped custom staff roles.  The organization key is kept alongside
-- venue_id so a role can never be reused across tenants by accident.
CREATE TABLE IF NOT EXISTS custom_staff_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  permission_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id uuid REFERENCES custom_staff_roles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS custom_staff_roles_venue_name_active
  ON custom_staff_roles (venue_id, lower(btrim(name)))
  WHERE is_active=true;
CREATE INDEX IF NOT EXISTS custom_staff_roles_scope_idx
  ON custom_staff_roles (organization_id, venue_id, is_active, lower(name));
CREATE INDEX IF NOT EXISTS users_custom_role_idx
  ON users (venue_id, custom_role_id)
  WHERE custom_role_id IS NOT NULL;

