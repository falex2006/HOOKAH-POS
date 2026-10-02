-- Venue-scoped immutable versions for configurable promotions. No row is active by default.
CREATE UNIQUE INDEX IF NOT EXISTS products_venue_id_id_uq ON products (venue_id,id);

CREATE TABLE IF NOT EXISTS loyalty_promotions (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  promotion_id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 80),
  benefit_kind text NOT NULL CHECK (benefit_kind IN ('percent','fixed')),
  benefit_value numeric(10,2) NOT NULL CHECK (benefit_value > 0 AND benefit_value <= 1000000),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100000 AND 100000),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,promotion_id,version),
  CHECK (ends_at > starts_at),
  CHECK (benefit_kind <> 'percent' OR benefit_value <= 100)
);

CREATE INDEX IF NOT EXISTS loyalty_promotions_latest_idx
  ON loyalty_promotions (venue_id,promotion_id,version DESC);
CREATE INDEX IF NOT EXISTS loyalty_promotions_active_period_idx
  ON loyalty_promotions (venue_id,status,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS loyalty_promotion_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  version integer NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('include_product','exclude_product','include_category','exclude_category')),
  product_id uuid,
  category_name text,
  FOREIGN KEY (venue_id,promotion_id,version)
    REFERENCES loyalty_promotions (venue_id,promotion_id,version) ON DELETE CASCADE,
  FOREIGN KEY (venue_id,product_id)
    REFERENCES products (venue_id,id) ON DELETE RESTRICT,
  CHECK (
    (scope_kind IN ('include_product','exclude_product') AND product_id IS NOT NULL AND category_name IS NULL)
    OR (scope_kind IN ('include_category','exclude_category') AND product_id IS NULL AND length(btrim(category_name)) BETWEEN 1 AND 80)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_promotion_scopes_unique_idx
  ON loyalty_promotion_scopes (venue_id,promotion_id,version,scope_kind,product_id,category_name) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS loyalty_promotion_scopes_product_idx
  ON loyalty_promotion_scopes (venue_id,product_id) WHERE product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_loyalty_promotion_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loyalty promotion versions are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS loyalty_promotions_immutable ON loyalty_promotions;
CREATE TRIGGER loyalty_promotions_immutable BEFORE UPDATE OR DELETE ON loyalty_promotions
  FOR EACH ROW EXECUTE FUNCTION reject_loyalty_promotion_history_mutation();
DROP TRIGGER IF EXISTS loyalty_promotion_scopes_immutable ON loyalty_promotion_scopes;
CREATE TRIGGER loyalty_promotion_scopes_immutable BEFORE UPDATE OR DELETE ON loyalty_promotion_scopes
  FOR EACH ROW EXECUTE FUNCTION reject_loyalty_promotion_history_mutation();
