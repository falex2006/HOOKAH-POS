-- Enforce append-only loyalty configuration at the database boundary.
-- Hard venue deletion remains maintenance-only; child history is removed only
-- by the existing venue CASCADE after the parent row is gone.
CREATE OR REPLACE FUNCTION guard_loyalty_immutable_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owning_venue_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'loyalty history is immutable' USING ERRCODE = '55000';
  END IF;

  -- Resolve the venue table in the trigger table's own schema. An unqualified
  -- lookup could be shadowed by a caller-created temporary `venues` table.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.venues WHERE id = $1)', TG_TABLE_SCHEMA)
    INTO owning_venue_exists USING OLD.venue_id;
  IF owning_venue_exists THEN
    RAISE EXCEPTION 'loyalty history is immutable' USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS loyalty_program_settings_immutable ON loyalty_program_settings;
CREATE TRIGGER loyalty_program_settings_immutable
  BEFORE UPDATE OR DELETE ON loyalty_program_settings
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();

DROP TRIGGER IF EXISTS loyalty_promotions_immutable ON loyalty_promotions;
CREATE TRIGGER loyalty_promotions_immutable
  BEFORE UPDATE OR DELETE ON loyalty_promotions
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();

DROP TRIGGER IF EXISTS loyalty_promotion_scopes_immutable ON loyalty_promotion_scopes;
CREATE TRIGGER loyalty_promotion_scopes_immutable
  BEFORE UPDATE OR DELETE ON loyalty_promotion_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();

-- Preserve actor attribution on immutable versions. Users are soft-archived;
-- a hard delete must not rewrite the historical created_by value to NULL.
ALTER TABLE loyalty_program_settings
  DROP CONSTRAINT IF EXISTS loyalty_program_settings_created_by_fkey;
ALTER TABLE loyalty_program_settings
  ADD CONSTRAINT loyalty_program_settings_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE loyalty_promotions
  DROP CONSTRAINT IF EXISTS loyalty_promotions_created_by_fkey;
ALTER TABLE loyalty_promotions
  ADD CONSTRAINT loyalty_promotions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

-- Product deletion stays blocked while historical campaign scopes exist. A
-- maintenance transaction may delete products first and the venue second;
-- the venue CASCADE removes scopes before this deferred check at commit.
ALTER TABLE loyalty_promotion_scopes
  DROP CONSTRAINT IF EXISTS loyalty_promotion_scopes_venue_id_product_id_fkey;
ALTER TABLE loyalty_promotion_scopes
  ADD CONSTRAINT loyalty_promotion_scopes_venue_id_product_id_fkey
  FOREIGN KEY (venue_id, product_id) REFERENCES products (venue_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- 073's trigger function is no longer referenced after the triggers above are replaced.
DROP FUNCTION IF EXISTS reject_loyalty_promotion_history_mutation();
