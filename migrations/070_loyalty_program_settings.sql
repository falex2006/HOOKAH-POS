-- Immutable, venue-scoped versions of program-wide redemption settings.
-- Defaults intentionally match the existing POS behavior; no expiry is enabled.
CREATE TABLE IF NOT EXISTS loyalty_program_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  bonus_ruble_rate numeric(8,4) NOT NULL DEFAULT 1 CHECK (bonus_ruble_rate > 0 AND bonus_ruble_rate <= 100),
  max_redemption_percent numeric(5,2) NOT NULL DEFAULT 100 CHECK (max_redemption_percent BETWEEN 0 AND 100),
  min_redemption_points integer NOT NULL DEFAULT 1 CHECK (min_redemption_points >= 1 AND min_redemption_points <= 1000000),
  bonus_expiration_days integer CHECK (bonus_expiration_days IS NULL OR bonus_expiration_days BETWEEN 1 AND 3650),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,version),
  UNIQUE (venue_id,id),
  CHECK (bonus_expiration_days IS NULL)
);

CREATE INDEX IF NOT EXISTS loyalty_program_settings_current_idx
  ON loyalty_program_settings (venue_id,version DESC,effective_at DESC);
