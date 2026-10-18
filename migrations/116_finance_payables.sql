-- Manual business obligations (rent, connectivity, services) with recurring
-- templates. Actual cash outflows remain in expenses; this is not a new ledger.

CREATE UNIQUE INDEX IF NOT EXISTS expenses_venue_id_uq ON expenses(venue_id,id);

CREATE TABLE IF NOT EXISTS finance_recurring_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  cadence text NOT NULL DEFAULT 'monthly' CHECK (cadence = 'monthly'),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS finance_recurring_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_from date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  variable_amount boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,rule_id,id),
  UNIQUE (venue_id,rule_id,version_number),
  FOREIGN KEY (venue_id,rule_id) REFERENCES finance_recurring_rules(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_recurring_versions_effective_idx
  ON finance_recurring_rule_versions(venue_id,rule_id,effective_from DESC,version_number DESC);

CREATE TABLE IF NOT EXISTS finance_payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  period_from date NOT NULL,
  period_to date NOT NULL,
  due_date date NOT NULL,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  total_amount numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  recurring_rule_id uuid,
  recurring_version_id uuid,
  period_key text,
  supersedes_id uuid,
  correction_reason text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,recurring_rule_id) REFERENCES finance_recurring_rules(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,recurring_rule_id,recurring_version_id) REFERENCES finance_recurring_rule_versions(venue_id,rule_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,supersedes_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,approved_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (period_to >= period_from),
  CHECK ((recurring_rule_id IS NULL AND recurring_version_id IS NULL AND period_key IS NULL)
      OR (recurring_rule_id IS NOT NULL AND recurring_version_id IS NOT NULL AND period_key IS NOT NULL)),
  CHECK ((supersedes_id IS NULL AND correction_reason IS NULL)
      OR (supersedes_id IS NOT NULL AND length(btrim(correction_reason)) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payables_recurring_period_uq
  ON finance_payables(venue_id,recurring_rule_id,period_key)
  WHERE recurring_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_payables_venue_due_idx
  ON finance_payables(venue_id,due_date,status,category_id);

CREATE TABLE IF NOT EXISTS finance_payable_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  description_snapshot text NOT NULL CHECK (length(btrim(description_snapshot)) BETWEEN 1 AND 200),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  ordinal smallint NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,payable_id,ordinal),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_lines_parent_idx ON finance_payable_lines(venue_id,payable_id,ordinal);

-- Association only: the referenced expenses row is the canonical cash event.
CREATE TABLE IF NOT EXISTS finance_payable_payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  applied_amount numeric(14,2) NOT NULL CHECK (applied_amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,expense_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_payment_links_parent_idx
  ON finance_payable_payment_links(venue_id,payable_id,created_at,id);

CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF EXISTS (SELECT 1 FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payables_immutable_guard ON finance_payables;
CREATE TRIGGER finance_payables_immutable_guard BEFORE UPDATE ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_immutable();

CREATE OR REPLACE FUNCTION guard_finance_payable_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE;
BEGIN
  SELECT * INTO p FROM finance_payables WHERE venue_id=COALESCE(NEW.venue_id,OLD.venue_id)
    AND id=COALESCE(NEW.payable_id,OLD.payable_id) FOR UPDATE;
  IF p.id IS NULL OR p.status <> 'draft' THEN
    RAISE EXCEPTION 'finance_payable_lines_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_lines_mutable_only_draft ON finance_payable_lines;
CREATE TRIGGER finance_payable_lines_mutable_only_draft BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_lines
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_line_mutation();

CREATE OR REPLACE FUNCTION validate_finance_payable_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_total numeric(14,2); category_kind text; category_active boolean;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT kind,active INTO category_kind,category_active FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'expense' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_payable_category_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO line_total
      FROM finance_payable_lines WHERE venue_id=NEW.venue_id AND payable_id=NEW.id;
    IF line_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'finance_payable_lines_total_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payables_validate_posting ON finance_payables;
CREATE TRIGGER finance_payables_validate_posting BEFORE UPDATE OF status ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION validate_finance_payable_posting();

CREATE OR REPLACE FUNCTION guard_finance_payable_payment_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE; e expenses%ROWTYPE; paid numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_payment_links_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  SELECT * INTO e FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR KEY SHARE;
  IF p.id IS NULL OR p.status <> 'approved' OR e.id IS NULL OR e.source <> 'manual'
      OR e.amount <> NEW.applied_amount OR e.category_id <> p.category_id THEN
    RAISE EXCEPTION 'finance_payable_payment_link_invalid' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(applied_amount),0)::numeric(14,2) INTO paid FROM finance_payable_payment_links
    WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id;
  IF paid + NEW.applied_amount > p.total_amount THEN
    RAISE EXCEPTION 'finance_payable_payment_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_payment_links_guard ON finance_payable_payment_links;
CREATE TRIGGER finance_payable_payment_links_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_payment_links
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_payment_link();

CREATE OR REPLACE FUNCTION guard_finance_recurring_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance_recurring_rule_versions_append_only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS finance_recurring_versions_immutable ON finance_recurring_rule_versions;
CREATE TRIGGER finance_recurring_versions_immutable BEFORE UPDATE OR DELETE ON finance_recurring_rule_versions
  FOR EACH ROW EXECUTE FUNCTION guard_finance_recurring_version_immutable();
