-- Effective-dated classification for POS income. This supplements, and never
-- replaces, the canonical immutable pricing/refund ledgers.

CREATE TABLE IF NOT EXISTS finance_income_category_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  effective_from date NOT NULL CHECK (date_trunc('month',effective_from)::date=effective_from),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,source_key,effective_from),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (source_key<>'@minimum-adjustment' OR length(btrim(source_key))>0)
);
CREATE INDEX IF NOT EXISTS finance_income_category_mapping_lookup_idx
  ON finance_income_category_mappings(venue_id,source_key,effective_from DESC);

CREATE TABLE IF NOT EXISTS pos_order_income_category_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  order_id uuid NOT NULL,
  pricing_snapshot_id uuid NOT NULL,
  closed_at timestamptz NOT NULL,
  venue_date date NOT NULL,
  recognized_total_minor bigint NOT NULL CHECK (recognized_total_minor>=0),
  unmapped_minor bigint NOT NULL DEFAULT 0 CHECK (unmapped_minor>=0 AND unmapped_minor<=recognized_total_minor),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','complete','unmapped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,order_id),
  UNIQUE (venue_id,id,order_id),
  FOREIGN KEY (venue_id,order_id) REFERENCES orders(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,pricing_snapshot_id,order_id) REFERENCES pos_order_pricing_snapshots(venue_id,id,order_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pos_order_income_category_snapshots_date_idx
  ON pos_order_income_category_snapshots(venue_id,venue_date,status);

CREATE TABLE IF NOT EXISTS pos_order_income_category_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  income_snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  allocation_kind text NOT NULL CHECK (allocation_kind IN ('item','minimum_adjustment')),
  order_item_id uuid,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
  source_station_snapshot text NOT NULL DEFAULT '' CHECK (length(source_station_snapshot)<=80),
  source_menu_category text NOT NULL DEFAULT '',
  source_product_name text NOT NULL DEFAULT '' CHECK (length(source_product_name)<=200),
  mapping_id uuid,
  category_id uuid,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  amount_minor bigint NOT NULL CHECK (amount_minor>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venue_id,income_snapshot_id,order_id) REFERENCES pos_order_income_category_snapshots(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,order_item_id) REFERENCES order_items(order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,mapping_id) REFERENCES finance_income_category_mappings(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  CHECK ((allocation_kind='item' AND order_item_id IS NOT NULL AND source_key<>'@minimum-adjustment')
      OR (allocation_kind='minimum_adjustment' AND order_item_id IS NULL AND source_key='@minimum-adjustment')),
  CHECK ((category_id IS NULL AND mapping_id IS NULL AND category_name_snapshot='Не распределено')
      OR (category_id IS NOT NULL AND mapping_id IS NOT NULL AND category_name_snapshot<>'Не распределено'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_order_income_category_item_uq
  ON pos_order_income_category_allocations(venue_id,income_snapshot_id,order_item_id)
  WHERE allocation_kind='item';
CREATE UNIQUE INDEX IF NOT EXISTS pos_order_income_category_adjustment_uq
  ON pos_order_income_category_allocations(venue_id,income_snapshot_id)
  WHERE allocation_kind='minimum_adjustment';
CREATE INDEX IF NOT EXISTS pos_order_income_category_category_idx
  ON pos_order_income_category_allocations(venue_id,category_id,income_snapshot_id);

CREATE OR REPLACE FUNCTION guard_finance_income_mapping_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_income_category_mappings_append_only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS finance_income_mapping_immutable ON finance_income_category_mappings;
CREATE TRIGGER finance_income_mapping_immutable BEFORE UPDATE OR DELETE ON finance_income_category_mappings
  FOR EACH ROW EXECUTE FUNCTION guard_finance_income_mapping_immutable();

CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_state text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pos_order_income_category_history_immutable' USING ERRCODE='55000'; END IF;
  SELECT status INTO snapshot_state FROM pos_order_income_category_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.income_snapshot_id FOR UPDATE;
  IF snapshot_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_sealed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_allocations_immutable ON pos_order_income_category_allocations;
CREATE TRIGGER pos_order_income_allocations_immutable BEFORE INSERT OR UPDATE OR DELETE ON pos_order_income_category_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_mutation();

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation_total bigint; unmapped_total bigint; source_total bigint; item_count bigint; allocation_count bigint;
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.status<>'building' OR NEW.status NOT IN ('complete','unmapped')
      OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.venue_date IS DISTINCT FROM OLD.venue_date OR NEW.recognized_total_minor IS DISTINCT FROM OLD.recognized_total_minor
      OR NEW.unmapped_minor IS DISTINCT FROM OLD.unmapped_minor OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pos_order_income_snapshot_transition_invalid' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(SUM(amount_minor),0),COALESCE(SUM(amount_minor) FILTER(WHERE category_id IS NULL),0),COUNT(*)
    INTO allocation_total,unmapped_total,allocation_count
    FROM pos_order_income_category_allocations WHERE venue_id=NEW.venue_id AND income_snapshot_id=NEW.id;
  SELECT final_total_minor INTO source_total FROM pos_order_pricing_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.pricing_snapshot_id AND order_id=NEW.order_id;
  SELECT COUNT(*) INTO item_count FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.pricing_snapshot_id AND order_id=NEW.order_id;
  IF allocation_total<>NEW.recognized_total_minor OR source_total<>NEW.recognized_total_minor
      OR unmapped_total<>NEW.unmapped_minor OR allocation_count<>item_count + (CASE WHEN EXISTS(
        SELECT 1 FROM pos_order_pricing_snapshots WHERE venue_id=NEW.venue_id AND id=NEW.pricing_snapshot_id AND minimum_adjustment_minor>0
      ) THEN 1 ELSE 0 END)
      OR NEW.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_validate ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_validate BEFORE UPDATE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_pos_order_income_category_snapshot();
CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status IN ('complete','unmapped') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pos_order_income_category_snapshots_immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_no_mutation ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_no_mutation BEFORE UPDATE OR DELETE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_immutable();
