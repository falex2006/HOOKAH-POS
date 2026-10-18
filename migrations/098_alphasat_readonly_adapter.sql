-- Installation-scoped, read-only AlphaSat adapter credentials.
-- A credential can see exactly one explicitly authorized organization.
CREATE TABLE IF NOT EXISTS alphasat_adapter_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO alphasat_adapter_installation (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS alphasat_adapter_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  allowed_organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS alphasat_adapter_credentials_active_idx
  ON alphasat_adapter_credentials (id)
  WHERE revoked_at IS NULL;
