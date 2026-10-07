-- Safe, append-only v1 reversal for a newly posted, wholly unused and unpaid
-- purchase document. Existing posted documents intentionally remain ineligible:
-- they have no posting-time valuation or venue-policy snapshots.

-- New supplier-payment events must be attached to their posted receipt. Legacy
-- unlinked purchase expenses remain readable; reversal checks fail closed while
-- any such row exists in the venue because its source receipt cannot be proven.
CREATE INDEX IF NOT EXISTS expenses_unlinked_purchase_venue_idx
  ON expenses(venue_id)
  WHERE source='purchase' AND purchase_document_id IS NULL;

CREATE OR REPLACE FUNCTION require_linked_purchase_expense_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source='purchase' AND NEW.purchase_document_id IS NULL THEN
    RAISE EXCEPTION 'purchase_payment_requires_receipt_link'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_purchase_payment_receipt_required ON expenses;
CREATE TRIGGER expenses_purchase_payment_receipt_required
BEFORE INSERT OR UPDATE OF source,purchase_document_id ON expenses
FOR EACH ROW EXECUTE FUNCTION require_linked_purchase_expense_document();

ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS stock_movement_version bigint NOT NULL DEFAULT 0
    CHECK (stock_movement_version >= 0);

CREATE OR REPLACE FUNCTION bump_ingredient_stock_movement_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE ingredients
     SET stock_movement_version = stock_movement_version + 1
   WHERE id = NEW.ingredient_id AND venue_id = NEW.venue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_movement_ingredient_scope_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_movement_version_bump ON stock_movements;
CREATE TRIGGER stock_movement_version_bump
AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION bump_ingredient_stock_movement_version();

CREATE TABLE IF NOT EXISTS inventory_purchase_reversal_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL CHECK (mode = 'safe_full_unpaid_unused'),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, version),
  UNIQUE (venue_id, id)
);

INSERT INTO inventory_purchase_reversal_policies (venue_id, version, mode, enabled)
SELECT id, 1, 'safe_full_unpaid_unused', true FROM venues
ON CONFLICT (venue_id, version) DO NOTHING;

CREATE OR REPLACE FUNCTION inventory_purchase_reversal_policy_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_purchase_reversal_policy_immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_reversal_policy_immutable_guard
  ON inventory_purchase_reversal_policies;
CREATE TRIGGER inventory_purchase_reversal_policy_immutable_guard
BEFORE UPDATE OR DELETE ON inventory_purchase_reversal_policies
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_policy_immutable_guard();

CREATE OR REPLACE FUNCTION seed_inventory_purchase_reversal_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO inventory_purchase_reversal_policies (venue_id, version, mode, enabled)
  VALUES (NEW.id, 1, 'safe_full_unpaid_unused', true)
  ON CONFLICT (venue_id, version) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_seed_purchase_reversal_policy ON venues;
CREATE TRIGGER venues_seed_purchase_reversal_policy
AFTER INSERT ON venues
FOR EACH ROW EXECUTE FUNCTION seed_inventory_purchase_reversal_policy();

ALTER TABLE inventory_purchase_documents
  ADD COLUMN IF NOT EXISTS reversal_policy_version integer,
  ADD COLUMN IF NOT EXISTS reversal_policy_mode text,
  ADD COLUMN IF NOT EXISTS reversal_policy_enabled boolean,
  ADD COLUMN IF NOT EXISTS source_auto_order_status_before text,
  ADD COLUMN IF NOT EXISTS source_auto_order_lines_before jsonb,
  ADD COLUMN IF NOT EXISTS source_auto_order_status_after text,
  ADD COLUMN IF NOT EXISTS source_auto_order_lines_after jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_purchase_documents_venue_id_id_uq
  ON inventory_purchase_documents(venue_id,id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_document_reversal_policy_fk' AND conrelid='inventory_purchase_documents'::regclass) THEN
    ALTER TABLE inventory_purchase_documents ADD CONSTRAINT inventory_purchase_document_reversal_policy_fk
      FOREIGN KEY (venue_id, reversal_policy_version)
      REFERENCES inventory_purchase_reversal_policies(venue_id, version) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_document_reversal_policy_snapshot_check' AND conrelid='inventory_purchase_documents'::regclass) THEN
    ALTER TABLE inventory_purchase_documents ADD CONSTRAINT inventory_purchase_document_reversal_policy_snapshot_check
      CHECK ((reversal_policy_version IS NULL AND reversal_policy_mode IS NULL AND reversal_policy_enabled IS NULL)
          OR (reversal_policy_version > 0 AND reversal_policy_mode = 'safe_full_unpaid_unused' AND reversal_policy_enabled IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_document_auto_order_snapshot_check' AND conrelid='inventory_purchase_documents'::regclass) THEN
    ALTER TABLE inventory_purchase_documents ADD CONSTRAINT inventory_purchase_document_auto_order_snapshot_check
      CHECK ((source_auto_order_status_before IS NULL AND source_auto_order_lines_before IS NULL AND source_auto_order_status_after IS NULL AND source_auto_order_lines_after IS NULL)
          OR (source_auto_order_id IS NOT NULL AND source_auto_order_status_before IS NOT NULL AND source_auto_order_lines_before IS NOT NULL AND source_auto_order_status_after IS NOT NULL AND source_auto_order_lines_after IS NOT NULL));
  END IF;
END
$$;

ALTER TABLE inventory_purchase_document_lines
  ADD COLUMN IF NOT EXISTS on_hand_before_snapshot numeric(15,6),
  ADD COLUMN IF NOT EXISTS cost_before_snapshot numeric(12,4),
  ADD COLUMN IF NOT EXISTS on_hand_after_snapshot numeric(15,6),
  ADD COLUMN IF NOT EXISTS cost_after_snapshot numeric(12,4),
  ADD COLUMN IF NOT EXISTS movement_version_before_snapshot bigint,
  ADD COLUMN IF NOT EXISTS movement_version_after_snapshot bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_line_reversal_snapshot_check' AND conrelid='inventory_purchase_document_lines'::regclass) THEN
    ALTER TABLE inventory_purchase_document_lines ADD CONSTRAINT inventory_purchase_line_reversal_snapshot_check
      CHECK ((on_hand_before_snapshot IS NULL AND cost_before_snapshot IS NULL AND on_hand_after_snapshot IS NULL AND cost_after_snapshot IS NULL AND movement_version_before_snapshot IS NULL AND movement_version_after_snapshot IS NULL)
          OR (on_hand_before_snapshot >= 0 AND cost_before_snapshot >= 0 AND on_hand_after_snapshot > on_hand_before_snapshot AND cost_after_snapshot >= 0 AND movement_version_before_snapshot >= 0 AND movement_version_after_snapshot = movement_version_before_snapshot + 1));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS inventory_purchase_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES inventory_purchase_documents(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL,
  policy_mode text NOT NULL CHECK (policy_mode = 'safe_full_unpaid_unused'),
  source_auto_order_id uuid REFERENCES inventory_auto_orders(id) ON DELETE RESTRICT,
  shift_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, source_document_id),
  UNIQUE (venue_id, idempotency_key),
  FOREIGN KEY (venue_id, source_document_id)
    REFERENCES inventory_purchase_documents(venue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id, policy_version)
    REFERENCES inventory_purchase_reversal_policies(venue_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id, shift_id)
    REFERENCES shifts(venue_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS inventory_purchase_reversal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reversal_id uuid NOT NULL,
  source_line_id uuid NOT NULL REFERENCES inventory_purchase_document_lines(id) ON DELETE RESTRICT,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  source_movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  reversal_movement_id uuid UNIQUE,
  quantity numeric(15,6) NOT NULL CHECK (quantity > 0),
  stock_unit text NOT NULL,
  restored_on_hand numeric(15,6) NOT NULL CHECK (restored_on_hand >= 0),
  restored_cost numeric(12,4) NOT NULL CHECK (restored_cost >= 0),
  source_movement_version bigint NOT NULL CHECK (source_movement_version > 0),
  reversed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venue_id, reversal_id)
    REFERENCES inventory_purchase_reversals(venue_id, id) ON DELETE RESTRICT
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_reversal_lines_movement_fk' AND conrelid='inventory_purchase_reversal_lines'::regclass) THEN
    ALTER TABLE inventory_purchase_reversal_lines ADD CONSTRAINT inventory_purchase_reversal_lines_movement_fk
      FOREIGN KEY (reversal_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS purchase_reversal_id uuid,
  ADD COLUMN IF NOT EXISTS purchase_reversal_line_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_purchase_reversal_fk' AND conrelid='stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_purchase_reversal_fk
      FOREIGN KEY (purchase_reversal_id) REFERENCES inventory_purchase_reversals(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_purchase_reversal_line_fk' AND conrelid='stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_purchase_reversal_line_fk
      FOREIGN KEY (purchase_reversal_line_id) REFERENCES inventory_purchase_reversal_lines(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_purchase_reversal_line_uq
  ON stock_movements(purchase_reversal_line_id)
  WHERE purchase_reversal_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory_purchase_reversal_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_purchase_reversal_immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_reversal_immutable_guard
  ON inventory_purchase_reversals;
CREATE TRIGGER inventory_purchase_reversal_immutable_guard
BEFORE UPDATE OR DELETE ON inventory_purchase_reversals
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_immutable_guard();

DROP TRIGGER IF EXISTS inventory_purchase_reversal_line_immutable_guard
  ON inventory_purchase_reversal_lines;
CREATE TRIGGER inventory_purchase_reversal_line_immutable_guard
BEFORE UPDATE OR DELETE ON inventory_purchase_reversal_lines
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_immutable_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_reversal_line_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_venue uuid;
  source_ingredient uuid;
  source_movement_venue uuid;
  source_movement_ingredient uuid;
  reversal_venue uuid;
BEGIN
  SELECT venue_id, ingredient_id INTO source_venue, source_ingredient
    FROM inventory_purchase_document_lines WHERE id=NEW.source_line_id;
  SELECT venue_id, ingredient_id INTO source_movement_venue, source_movement_ingredient
    FROM stock_movements WHERE id=NEW.source_movement_id;
  SELECT venue_id INTO reversal_venue FROM inventory_purchase_reversals WHERE id=NEW.reversal_id;
  IF source_venue IS NULL OR reversal_venue IS NULL
     OR source_venue IS DISTINCT FROM NEW.venue_id
     OR reversal_venue IS DISTINCT FROM NEW.venue_id
     OR source_ingredient IS DISTINCT FROM NEW.ingredient_id
     OR source_movement_venue IS DISTINCT FROM NEW.venue_id
     OR source_movement_ingredient IS DISTINCT FROM NEW.ingredient_id THEN
    RAISE EXCEPTION 'inventory_purchase_reversal_scope_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_reversal_line_scope_guard
  ON inventory_purchase_reversal_lines;
CREATE TRIGGER inventory_purchase_reversal_line_scope_guard
BEFORE INSERT ON inventory_purchase_reversal_lines
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_line_scope_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_reversal_movement_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reversal_venue uuid;
  line_venue uuid;
  line_ingredient uuid;
BEGIN
  IF NEW.purchase_reversal_id IS NULL AND NEW.purchase_reversal_line_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'out' OR NEW.purchase_reversal_id IS NULL THEN
    RAISE EXCEPTION 'inventory_purchase_reversal_movement_invalid'
      USING ERRCODE = '23514';
  END IF;
  SELECT venue_id INTO reversal_venue FROM inventory_purchase_reversals WHERE id=NEW.purchase_reversal_id;
  IF reversal_venue IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'inventory_purchase_reversal_movement_scope_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.purchase_reversal_line_id IS NOT NULL THEN
    SELECT venue_id, ingredient_id INTO line_venue, line_ingredient
      FROM inventory_purchase_reversal_lines WHERE id=NEW.purchase_reversal_line_id;
    IF line_venue IS DISTINCT FROM NEW.venue_id OR line_ingredient IS DISTINCT FROM NEW.ingredient_id THEN
      RAISE EXCEPTION 'inventory_purchase_reversal_movement_scope_invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_reversal_movement_scope_guard ON stock_movements;
CREATE TRIGGER inventory_purchase_reversal_movement_scope_guard
BEFORE INSERT OR UPDATE OF purchase_reversal_id, purchase_reversal_line_id ON stock_movements
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_movement_scope_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_reversal_document_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('posted', 'voided') AND (
       OLD.reversal_policy_version IS DISTINCT FROM NEW.reversal_policy_version
       OR OLD.reversal_policy_mode IS DISTINCT FROM NEW.reversal_policy_mode
       OR OLD.reversal_policy_enabled IS DISTINCT FROM NEW.reversal_policy_enabled
       OR OLD.source_auto_order_status_before IS DISTINCT FROM NEW.source_auto_order_status_before
       OR OLD.source_auto_order_lines_before IS DISTINCT FROM NEW.source_auto_order_lines_before
       OR OLD.source_auto_order_status_after IS DISTINCT FROM NEW.source_auto_order_status_after
       OR OLD.source_auto_order_lines_after IS DISTINCT FROM NEW.source_auto_order_lines_after
     ) THEN
    RAISE EXCEPTION 'inventory_purchase_document_reversal_snapshot_immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_reversal_document_snapshot_guard ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_reversal_document_snapshot_guard
BEFORE UPDATE ON inventory_purchase_documents
FOR EACH ROW EXECUTE FUNCTION inventory_purchase_reversal_document_snapshot_guard();
