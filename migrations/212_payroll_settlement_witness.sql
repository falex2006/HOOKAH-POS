-- Migration 212: fresh, transaction-bound payroll settlement witness.
-- Migration 205 source is unchanged and hash-pinned below.
-- SHA-256 of 205: 77DFCD0EA17D8B6187B59A6244DBFBB7A4A94B8D15B4D699340FB92EDD1F7A97
-- Uses the actual replay-all contract in scripts/migrate.js; requires schema bootstrap.
-- New committed expense adoption is forbidden. Historical rows are preserved.-- 1. Common witness. Historical rows remain NULL; no backfill or adoption.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS payroll_settlement_entry_id uuid,
  ADD COLUMN IF NOT EXISTS payroll_settlement_insert_xid bigint;

DO $$
DECLARE entry_type text; xid_type text; entry_not_null boolean; xid_not_null boolean;
  entry_default text; xid_default text; check_oid oid; fk_oid oid;
  local_columns text[]; ref_columns text[]; def text;
BEGIN
  SELECT format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
    INTO entry_type,entry_not_null,entry_default
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='expenses'::regclass AND a.attname='payroll_settlement_entry_id' AND NOT a.attisdropped;
  SELECT format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
    INTO xid_type,xid_not_null,xid_default
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='expenses'::regclass AND a.attname='payroll_settlement_insert_xid' AND NOT a.attisdropped;
  IF entry_type IS DISTINCT FROM 'uuid' OR xid_type IS DISTINCT FROM 'bigint'
    OR entry_not_null OR xid_not_null OR entry_default IS NOT NULL OR xid_default IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_settlement_witness_column_mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='expenses'::regclass AND conname='expenses_payroll_settlement_witness_pair_ck') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_payroll_settlement_witness_pair_ck
      CHECK ((payroll_settlement_entry_id IS NULL) = (payroll_settlement_insert_xid IS NULL));
  END IF;
  SELECT oid,pg_get_constraintdef(oid) INTO check_oid,def FROM pg_constraint
    WHERE conrelid='expenses'::regclass AND conname='expenses_payroll_settlement_witness_pair_ck'
      AND contype='c' AND convalidated;
  IF check_oid IS NULL OR regexp_replace(lower(def),'[[:space:]"()]','','g')
      IS DISTINCT FROM 'checkpayroll_settlement_entry_idisnull=payroll_settlement_insert_xidisnull' THEN
    RAISE EXCEPTION 'payroll_settlement_witness_check_mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='expenses'::regclass AND conname='expenses_payroll_settlement_entry_fk') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_payroll_settlement_entry_fk
      FOREIGN KEY (venue_id,payroll_settlement_entry_id)
      REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT;
  END IF;
  SELECT c.oid,
    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord),
    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord)
    INTO fk_oid,local_columns,ref_columns FROM pg_constraint c
    WHERE c.conrelid='expenses'::regclass AND c.conname='expenses_payroll_settlement_entry_fk'
      AND c.contype='f' AND c.confrelid='payroll_entries'::regclass AND c.convalidated
      AND NOT c.condeferrable AND c.confdeltype='r' AND c.confupdtype='a' AND c.confmatchtype='s';
  IF fk_oid IS NULL OR local_columns IS DISTINCT FROM ARRAY['venue_id','payroll_settlement_entry_id']::text[]
    OR ref_columns IS DISTINCT FROM ARRAY['venue_id','id']::text[] THEN
    RAISE EXCEPTION 'payroll_settlement_witness_fk_mismatch';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_payroll_settlement_entry_uq
  ON expenses(venue_id,payroll_settlement_entry_id)
  WHERE payroll_settlement_entry_id IS NOT NULL;

DO $$ DECLARE idx record; predicate text;
BEGIN
  SELECT i.indrelid,i.indisunique,i.indisvalid,i.indisready,i.indimmediate,i.indnatts,i.indnkeyatts,
    pg_get_indexdef(i.indexrelid,1,true) AS key1,pg_get_indexdef(i.indexrelid,2,true) AS key2,
    pg_get_expr(i.indpred,i.indrelid) AS pred INTO idx
    FROM pg_index i WHERE i.indexrelid=to_regclass('expenses_payroll_settlement_entry_uq');
  predicate:=regexp_replace(lower(COALESCE(idx.pred,'')),'[[:space:]"()]','','g');
  IF idx.indrelid IS DISTINCT FROM 'expenses'::regclass OR NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready
    OR NOT idx.indimmediate OR idx.indnatts<>2 OR idx.indnkeyatts<>2 OR idx.key1<>'venue_id'
    OR idx.key2<>'payroll_settlement_entry_id' OR predicate<>'payroll_settlement_entry_idisnotnull' THEN
    RAISE EXCEPTION 'payroll_settlement_witness_index_mismatch';
  END IF;
END $$;

-- 2. One BEFORE INSERT producer guard stamps xid_current() itself. A caller
-- cannot provide xid. For run-linked expenses the existing marker determines
-- entry id; for legacy expenses the route supplies payroll_settlement_entry_id.
CREATE OR REPLACE FUNCTION payroll_expense_settlement_witness_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE e record; target_entry uuid;
BEGIN
  IF NEW.payroll_settlement_insert_xid IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_settlement_witness_invalid' USING ERRCODE='23514';
  END IF;

  IF NEW.payroll_calculation_entry_id IS NOT NULL THEN
    IF NEW.payroll_settlement_entry_id IS NOT NULL
       AND NEW.payroll_settlement_entry_id IS DISTINCT FROM NEW.payroll_calculation_entry_id THEN
      RAISE EXCEPTION 'payroll_settlement_witness_invalid' USING ERRCODE='23514';
    END IF;
    target_entry := NEW.payroll_calculation_entry_id;
  ELSE
    target_entry := NEW.payroll_settlement_entry_id;
  END IF;

  IF target_entry IS NULL THEN
    IF NEW.source='payroll' THEN
      -- Payroll expense writes without either approved producer contract fail closed.
      RAISE EXCEPTION 'payroll_settlement_witness_required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source IS DISTINCT FROM 'payroll' THEN
    RAISE EXCEPTION 'payroll_settlement_witness_invalid' USING ERRCODE='23514';
  END IF;

  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO e USING NEW.venue_id,target_entry;
  IF e.id IS NULL OR e.status IS DISTINCT FROM 'approved' OR e.expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_settlement_entry_not_payable' USING ERRCODE='23514';
  END IF;
  IF NEW.payroll_calculation_entry_id IS NOT NULL THEN
    IF e.calculation_run_id IS NULL THEN
      RAISE EXCEPTION 'payroll_settlement_run_origin_invalid' USING ERRCODE='23514';
    END IF;
    -- 205's transition validator remains the authority for the complete
    -- run-linked provenance, amount, date, actor, account, method and shift.
  ELSE
    IF e.calculation_run_id IS NOT NULL
      OR e.amount IS DISTINCT FROM NEW.amount
      OR e.finance_category_id IS DISTINCT FROM NEW.category_id
      OR COALESCE(e.finance_category_name_snapshot,'Зарплата') IS DISTINCT FROM NEW.category THEN
      RAISE EXCEPTION 'payroll_settlement_legacy_origin_invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.payroll_settlement_entry_id := target_entry;
  NEW.payroll_settlement_insert_xid := txid_current();
  RETURN NEW;
END $$;

-- 3. Marker and settlement financial identity cannot be rewritten/deleted.
-- Existing 205 immutability trigger stays installed; this companion covers
-- the common witness, including legacy rows with no calculation marker.
CREATE OR REPLACE FUNCTION payroll_expense_settlement_witness_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE paid_legacy_reference boolean; linked_entry boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries pe WHERE pe.venue_id=$1 AND pe.expense_id=$2 AND pe.status=''paid'' AND pe.calculation_run_id IS NULL)',TG_TABLE_SCHEMA)
      INTO paid_legacy_reference USING OLD.venue_id,OLD.id;
    IF paid_legacy_reference THEN
      RAISE EXCEPTION 'payroll_paid_expense_immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.payroll_settlement_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_settlement_witness_immutable' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  -- Migration 129 intentionally permits a linked manual expense to be
  -- reclassified as payroll. New policy forbids that adoption path: payroll
  -- settlement origin must be a fresh INSERT carrying the DB-owned witness.
  -- Reject before 129's posted_expense_draft_source_guard can accept it.
  IF OLD.source IS DISTINCT FROM 'payroll' AND NEW.source='payroll' THEN
    RAISE EXCEPTION 'payroll_expense_origin_requires_fresh_insert' USING ERRCODE='55000';
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries pe WHERE pe.venue_id=$1 AND pe.expense_id=$2)',TG_TABLE_SCHEMA)
    INTO linked_entry USING OLD.venue_id,OLD.id;
  IF linked_entry AND NEW.venue_id IS DISTINCT FROM OLD.venue_id THEN
    RAISE EXCEPTION 'payroll_linked_expense_tenant_immutable' USING ERRCODE='55000';
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries pe WHERE pe.venue_id=$1 AND pe.expense_id=$2 AND pe.status=''paid'' AND pe.calculation_run_id IS NULL)',TG_TABLE_SCHEMA)
    INTO paid_legacy_reference USING OLD.venue_id,OLD.id;
  IF paid_legacy_reference AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'payroll_paid_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.payroll_settlement_entry_id IS DISTINCT FROM OLD.payroll_settlement_entry_id
     OR NEW.payroll_settlement_insert_xid IS DISTINCT FROM OLD.payroll_settlement_insert_xid THEN
    RAISE EXCEPTION 'payroll_settlement_witness_immutable' USING ERRCODE='55000';
  END IF;
  -- A witnessed payroll expense is immutable as a whole row, including its
  -- primary key, descriptions, counterparty/document metadata and audit fields.
  IF OLD.payroll_settlement_entry_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'payroll_settlement_witness_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_expense_settlement_witness_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE witnessed boolean; paid_legacy_reference boolean;
BEGIN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.expenses WHERE payroll_settlement_entry_id IS NOT NULL)',TG_TABLE_SCHEMA)
    INTO witnessed;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE status=''paid'' AND calculation_run_id IS NULL AND expense_id IS NOT NULL)',TG_TABLE_SCHEMA)
    INTO paid_legacy_reference;
  IF witnessed OR paid_legacy_reference THEN
    RAISE EXCEPTION 'payroll_settlement_witness_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;

-- 4. Paid legacy status cannot be inserted or changed without a fresh witness.
-- Run-linked transitions continue through the existing 205 transition rules.
CREATE OR REPLACE FUNCTION payroll_legacy_paid_witness_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE x record; actor record; account record; shift_row record; n bigint; zone text;
BEGIN
  IF NEW.calculation_run_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status='paid' THEN
      RAISE EXCEPTION 'payroll_legacy_paid_insert_requires_settlement' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM 'paid' AND NEW.status='paid' THEN
    IF OLD.status IS DISTINCT FROM 'approved' OR OLD.expense_id IS NOT NULL OR NEW.expense_id IS NULL THEN
      RAISE EXCEPTION 'payroll_expense_reconciliation_required' USING ERRCODE='23514';
    END IF;
    IF NEW.amount<=0 THEN
      RAISE EXCEPTION 'payroll_zero_settlement_requires_separate_path' USING ERRCODE='23514';
    END IF;
    IF NEW.paid_at IS NULL OR NOT isfinite(NEW.paid_at)
       OR NEW.paid_at<date_trunc('milliseconds',transaction_timestamp())
       OR NEW.paid_at>clock_timestamp()
       OR NEW.payment_date IS NULL OR NOT isfinite(NEW.payment_date) THEN
      RAISE EXCEPTION 'payroll_legacy_paid_timestamp_invalid' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT payroll_settlement_entry_id,payroll_settlement_insert_xid,source,amount,expense_date,created_by,category_id,category,payment_method,finance_account_id,finance_account_name_snapshot,shift_id FROM %I.expenses WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO x USING NEW.venue_id,NEW.expense_id;
    IF x.payroll_settlement_entry_id IS DISTINCT FROM NEW.id
       OR x.payroll_settlement_insert_xid IS DISTINCT FROM txid_current()
       OR x.source IS DISTINCT FROM 'payroll' OR x.amount IS DISTINCT FROM NEW.amount
       OR x.expense_date IS DISTINCT FROM NEW.payment_date
       OR x.created_by IS DISTINCT FROM NEW.paid_by
       OR x.category_id IS DISTINCT FROM NEW.finance_category_id
       OR x.category IS DISTINCT FROM COALESCE(NEW.finance_category_name_snapshot,'Зарплата') THEN
      RAISE EXCEPTION 'payroll_legacy_paid_requires_fresh_witness' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT id FROM %I.users WHERE venue_id=$1 AND id=$2 AND is_active=true AND deleted_at IS NULL FOR SHARE',TG_TABLE_SCHEMA)
      INTO actor USING NEW.venue_id,NEW.paid_by;
    IF actor.id IS NULL OR x.created_by IS DISTINCT FROM actor.id THEN
      RAISE EXCEPTION 'payroll_lifecycle_actor_invalid' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT * FROM %I.finance_accounts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
      INTO account USING NEW.venue_id,x.finance_account_id;
    IF account.id IS NULL OR NOT account.active
      OR account.name IS DISTINCT FROM x.finance_account_name_snapshot
      OR NOT (x.payment_method=ANY(account.allowed_payment_methods)) THEN
      RAISE EXCEPTION 'payroll_lifecycle_account_invalid' USING ERRCODE='23514';
    END IF;
    IF account.kind='pos_cashbox' THEN
      EXECUTE format('SELECT * FROM %I.shifts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
        INTO shift_row USING NEW.venue_id,x.shift_id;
      EXECUTE format('SELECT count(*) FROM %I.shifts WHERE venue_id=$1 AND closed_at IS NULL',TG_TABLE_SCHEMA)
        INTO n USING NEW.venue_id;
      EXECUTE format('SELECT COALESCE(NULLIF(v.timezone,''''),NULLIF(o.timezone,''''),''Asia/Yekaterinburg'') FROM %I.venues v LEFT JOIN %I.organizations o ON o.id=v.organization_id WHERE v.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
        INTO zone USING NEW.venue_id;
      IF x.payment_method IS DISTINCT FROM 'cash' OR shift_row.id IS NULL OR shift_row.closed_at IS NOT NULL
        OR n<>1 OR NEW.payment_date IS DISTINCT FROM
          (clock_timestamp() AT TIME ZONE COALESCE(zone,'UTC'))::date THEN
        RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514';
      END IF;
    ELSIF x.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_legacy_paid_entry_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE paid_legacy boolean;
BEGIN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE status=''paid'' AND calculation_run_id IS NULL)',TG_TABLE_SCHEMA)
    INTO paid_legacy;
  IF paid_legacy THEN
    RAISE EXCEPTION 'payroll_paid_entry_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;

-- 5. Freeze critical fields on every paid legacy payroll entry, including
-- historical rows without a witness. No backfill or value rewrite occurs.
-- A witnessed approved entry is frozen except for its exact approved->paid
-- transition. Historical paid rows allow exact no-op and unrelated metadata.
-- Payment method/account/shift live on the expense and are protected there.
CREATE OR REPLACE FUNCTION payroll_legacy_paid_entry_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE witnessed boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.calculation_run_id IS NULL AND OLD.status='paid' THEN
      RAISE EXCEPTION 'payroll_paid_entry_immutable' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;

  -- Do not allow tenant/key movement on any row that already carries an
  -- expense link. This fires for UPDATE OF venue_id even when expense_id is
  -- unchanged, closing the historical fast-return tenant bypass.
  IF OLD.expense_id IS NOT NULL AND
     (NEW.id IS DISTINCT FROM OLD.id OR NEW.venue_id IS DISTINCT FROM OLD.venue_id) THEN
    RAISE EXCEPTION 'payroll_linked_entry_identity_immutable' USING ERRCODE='55000';
  END IF;

  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.expenses x WHERE x.venue_id=$1 AND x.payroll_settlement_entry_id=$2)',TG_TABLE_SCHEMA)
    INTO witnessed USING OLD.venue_id,OLD.id;
  IF witnessed THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    -- Once the fresh witness exists, the only allowed mutation is the single
    -- approved -> paid transition. The five settlement fields may change;
    -- every identity, period, amount, category, snapshot and audit field must
    -- remain value-equivalent.
    IF OLD.calculation_run_id IS NOT NULL OR OLD.status IS DISTINCT FROM 'approved'
       OR NEW.status IS DISTINCT FROM 'paid' OR OLD.expense_id IS NOT NULL
       OR NEW.expense_id IS NULL
       OR (to_jsonb(NEW)-ARRAY['status','paid_at','paid_by','payment_date','expense_id'])
          IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['status','paid_at','paid_by','payment_date','expense_id']) THEN
      RAISE EXCEPTION 'payroll_witnessed_entry_transition_invalid' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Freeze financial/audit identity for every paid legacy row, including
  -- historical unwitnessed payments. No backfill is needed; reads and exact
  -- no-op updates remain allowed, as do unrelated approved-safe metadata.
  IF OLD.calculation_run_id IS NOT NULL OR OLD.status IS DISTINCT FROM 'paid' THEN RETURN NEW; END IF;

  IF ROW(NEW.id,NEW.venue_id,NEW.user_id,NEW.rule_id,NEW.period_from,NEW.period_to,
         NEW.amount,NEW.status,NEW.expense_id,NEW.payment_date,NEW.paid_at,NEW.paid_by,
         NEW.approved_at,NEW.approved_by,NEW.cancelled_at,NEW.cancelled_by,NEW.cancellation_reason,
         NEW.finance_category_id,NEW.finance_category_name_snapshot,NEW.employee_name_snapshot,
         NEW.calculation_scheme_name_snapshot,NEW.calculation_run_id,
         NEW.calculation_provenance_sha256,NEW.calculation_gross_cents,
         NEW.materialized_by,NEW.materialized_by_name,NEW.materialized_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.venue_id,OLD.user_id,OLD.rule_id,OLD.period_from,OLD.period_to,
         OLD.amount,OLD.status,OLD.expense_id,OLD.payment_date,OLD.paid_at,OLD.paid_by,
         OLD.approved_at,OLD.approved_by,OLD.cancelled_at,OLD.cancelled_by,OLD.cancellation_reason,
         OLD.finance_category_id,OLD.finance_category_name_snapshot,OLD.employee_name_snapshot,
         OLD.calculation_scheme_name_snapshot,OLD.calculation_run_id,
         OLD.calculation_provenance_sha256,OLD.calculation_gross_cents,
         OLD.materialized_by,OLD.materialized_by_name,OLD.materialized_at,OLD.created_at) THEN
    RAISE EXCEPTION 'payroll_paid_entry_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

-- 5. Deferred assertion: the expense and legacy paid entry must point to each
-- other at commit. The existing 205 deferred guards remain active for
-- calculation-run entries and their exact transition/request lineage.
CREATE OR REPLACE FUNCTION payroll_expense_settlement_witness_commit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE e record;
BEGIN
  IF NEW.payroll_settlement_entry_id IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO e USING NEW.venue_id,NEW.payroll_settlement_entry_id;
  IF e.id IS NULL OR e.status IS DISTINCT FROM 'paid'
     OR e.expense_id IS DISTINCT FROM NEW.id
     OR e.amount IS DISTINCT FROM NEW.amount
     OR e.payment_date IS DISTINCT FROM NEW.expense_date
     OR e.paid_by IS DISTINCT FROM NEW.created_by
     OR e.finance_category_id IS DISTINCT FROM NEW.category_id
     OR COALESCE(e.finance_category_name_snapshot,'Зарплата') IS DISTINCT FROM NEW.category
     OR (e.calculation_run_id IS NULL AND NEW.payroll_calculation_entry_id IS NOT NULL)
     OR (e.calculation_run_id IS NOT NULL AND NEW.payroll_calculation_entry_id IS DISTINCT FROM e.id) THEN
    RAISE EXCEPTION 'payroll_settlement_incomplete' USING ERRCODE='23514';
  END IF;
  IF NEW.payroll_settlement_insert_xid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'payroll_settlement_witness_not_current' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

-- Deferred counterpart on payroll_entries catches an entry-only change that
-- would otherwise commit without the matching witnessed expense. Rows that
-- still carry a historical unwitnessed reference are deliberately ignored.
CREATE OR REPLACE FUNCTION payroll_legacy_witnessed_entry_commit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE x record;
BEGIN
  IF NEW.calculation_run_id IS NOT NULL OR NEW.expense_id IS NULL THEN RETURN NULL; END IF;
  -- The first approved -> paid event is checked against the current xid below.
  -- Later unrelated updates keep the already-committed witness unchanged.
  IF TG_OP='UPDATE' AND OLD.status='paid'
    AND NEW.expense_id IS NOT DISTINCT FROM OLD.expense_id THEN RETURN NULL; END IF;
  EXECUTE format('SELECT payroll_settlement_entry_id,payroll_settlement_insert_xid,source,amount,expense_date,created_by,category_id,category FROM %I.expenses WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO x USING NEW.venue_id,NEW.expense_id;
  IF x.payroll_settlement_entry_id IS NULL THEN RETURN NULL; END IF;
  IF NEW.status IS DISTINCT FROM 'paid'
    OR NEW.paid_at IS NULL OR NOT isfinite(NEW.paid_at)
    OR NEW.paid_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.paid_at>clock_timestamp()
    OR NEW.payment_date IS NULL OR NOT isfinite(NEW.payment_date)
    OR x.payroll_settlement_entry_id IS DISTINCT FROM NEW.id
    OR x.payroll_settlement_insert_xid IS DISTINCT FROM txid_current()
    OR x.source IS DISTINCT FROM 'payroll' OR x.amount IS DISTINCT FROM NEW.amount
    OR x.expense_date IS DISTINCT FROM NEW.payment_date
    OR x.created_by IS DISTINCT FROM NEW.paid_by
    OR x.category_id IS DISTINCT FROM NEW.finance_category_id
    OR x.category IS DISTINCT FROM COALESCE(NEW.finance_category_name_snapshot,'Зарплата') THEN
    RAISE EXCEPTION 'payroll_legacy_witnessed_entry_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

-- 6. Drop/recreate named hooks so the actual replay-all runner can reapply
-- this migration. Trigger execution order is by name and is explicitly covered
-- by the local PG16 regression set; unexpected manual drift is overwritten.
DROP TRIGGER IF EXISTS payroll_expense_settlement_witness_bi ON expenses;
CREATE TRIGGER payroll_expense_settlement_witness_bi
  BEFORE INSERT ON expenses FOR EACH ROW
  EXECUTE FUNCTION payroll_expense_settlement_witness_insert();
DROP TRIGGER IF EXISTS payroll_expense_settlement_witness_immutable ON expenses;
CREATE TRIGGER payroll_expense_settlement_witness_immutable
  BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW
  EXECUTE FUNCTION payroll_expense_settlement_witness_immutable();
DROP TRIGGER IF EXISTS payroll_expense_settlement_witness_truncate ON expenses;
CREATE TRIGGER payroll_expense_settlement_witness_truncate
  BEFORE TRUNCATE ON expenses FOR EACH STATEMENT
  EXECUTE FUNCTION payroll_expense_settlement_witness_truncate_guard();
DROP TRIGGER IF EXISTS payroll_expense_settlement_witness_commit ON expenses;
CREATE CONSTRAINT TRIGGER payroll_expense_settlement_witness_commit
  AFTER INSERT ON expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION payroll_expense_settlement_witness_commit();
DROP TRIGGER IF EXISTS payroll_legacy_paid_witness_guard ON payroll_entries;
CREATE TRIGGER payroll_legacy_paid_witness_guard
  BEFORE INSERT OR UPDATE OF status ON payroll_entries FOR EACH ROW
  EXECUTE FUNCTION payroll_legacy_paid_witness_guard();
DROP TRIGGER IF EXISTS payroll_legacy_paid_entry_immutable ON payroll_entries;
CREATE TRIGGER payroll_legacy_paid_entry_immutable
  BEFORE UPDATE OR DELETE ON payroll_entries FOR EACH ROW
  EXECUTE FUNCTION payroll_legacy_paid_entry_immutable_guard();
DROP TRIGGER IF EXISTS payroll_legacy_paid_entry_truncate_guard ON payroll_entries;
CREATE TRIGGER payroll_legacy_paid_entry_truncate_guard
  BEFORE TRUNCATE ON payroll_entries FOR EACH STATEMENT
  EXECUTE FUNCTION payroll_legacy_paid_entry_truncate_guard();
DROP TRIGGER IF EXISTS payroll_legacy_witnessed_entry_commit ON payroll_entries;
CREATE CONSTRAINT TRIGGER payroll_legacy_witnessed_entry_commit
  AFTER INSERT OR UPDATE ON payroll_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION payroll_legacy_witnessed_entry_commit();


-- 7. Exact 205 function replacements, embedded from the hash-bound source.
-- The transition validator differs only at the expenses lookup and freshness proof;
-- the reference function is replaced to reject new committed-expense associations.
-- Derived, unnumbered proposal. Inputs: clean migration 205 SHA256 77DFCD0EA17D8B6187B59A6244DBFBB7A4A94B8D15B4D699340FB92EDD1F7A97
-- Exact 205-derived body; full all-migrations replay was run twice on PG16.
CREATE OR REPLACE FUNCTION payroll_validate_calculation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; actor record; expense record; account record; shift_row record; proof jsonb;
  used numeric; fixed numeric; n bigint; other_link boolean; zone text;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO e USING NEW.venue_id,NEW.entry_id;
  IF e.id IS NULL OR e.calculation_run_id IS NULL OR e.status IS DISTINCT FROM NEW.from_status
    OR e.user_id IS DISTINCT FROM NEW.employee_id OR e.calculation_run_id IS DISTINCT FROM NEW.calculation_run_id
    OR e.calculation_provenance_sha256 IS DISTINCT FROM NEW.provenance_sha256
    OR e.calculation_gross_cents IS DISTINCT FROM NEW.gross_cents OR e.amount*100 IS DISTINCT FROM NEW.net_cents::numeric
    OR NEW.transaction_id IS DISTINCT FROM txid_current()
    OR NEW.created_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.created_at>clock_timestamp() THEN
    RAISE EXCEPTION 'payroll_lifecycle_transition_context_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name,role FROM %I.users WHERE venue_id=$1 AND id=$2 AND is_active=true AND deleted_at IS NULL FOR SHARE',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name OR actor.role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'payroll_lifecycle_actor_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed USING NEW.venue_id,NEW.calculation_run_id,NEW.employee_id;
  IF fixed IS DISTINCT FROM NEW.protected_fixed_cents::numeric THEN
    RAISE EXCEPTION 'payroll_lifecycle_fixed_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.action<>'cancel' THEN
    EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
      INTO used USING NEW.venue_id,NEW.entry_id;
    IF NEW.net_cents IS DISTINCT FROM NEW.gross_cents-used OR used<0 THEN
      RAISE EXCEPTION 'payroll_lifecycle_net_mismatch' USING ERRCODE='23514'; END IF;
    proof:=NEW.source_proof_payload::jsonb;
    IF proof->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR proof->>'proofKind' IS DISTINCT FROM 'current_transition'
      OR proof->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR proof->>'entryId' IS DISTINCT FROM NEW.entry_id::text
      OR proof->>'employeeId' IS DISTINCT FROM NEW.employee_id::text OR proof->>'runId' IS DISTINCT FROM NEW.calculation_run_id::text
      OR proof->>'entryStatus' IS DISTINCT FROM NEW.from_status OR proof->>'origin' IS DISTINCT FROM 'calculation_run'
      OR proof->>'currency' IS DISTINCT FROM 'RUB' OR proof->>'periodFrom' IS DISTINCT FROM to_char(e.period_from,'YYYY-MM-DD')
      OR proof->>'periodTo' IS DISTINCT FROM to_char(e.period_to,'YYYY-MM-DD')
      OR proof->'grossCents' IS DISTINCT FROM to_jsonb(NEW.gross_cents) OR proof->'netCents' IS DISTINCT FROM to_jsonb(NEW.net_cents)
      OR proof->'protectedFixedCents' IS DISTINCT FROM to_jsonb(NEW.protected_fixed_cents)
      OR proof->'evidenceHashes'->>'provenanceSha256' IS DISTINCT FROM NEW.provenance_sha256::text
      OR proof->'freshness'->>'status' IS DISTINCT FROM 'current'
      OR proof->'corrections'->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text
      OR proof->'corrections'->'netCents' IS DISTINCT FROM to_jsonb(NEW.net_cents) THEN
      RAISE EXCEPTION 'payroll_lifecycle_source_proof_mismatch' USING ERRCODE='23514'; END IF;
    -- Freshness is collected by the authenticated service, not inferred from
    -- this checksum. Its timestamp must at least belong to this transaction.
    IF proof->'freshness'->>'checkedAt' IS NULL OR NOT isfinite((proof->'freshness'->>'checkedAt')::timestamptz)
      OR (proof->'freshness'->>'checkedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp())
      OR (proof->'freshness'->>'checkedAt')::timestamptz>clock_timestamp() THEN
      RAISE EXCEPTION 'payroll_lifecycle_source_proof_stale' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.action='pay' AND NEW.settlement_kind='positive_expense' THEN
    EXECUTE format('SELECT x.* FROM %I.expenses x WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO expense USING NEW.venue_id,NEW.expense_id;
    IF expense.id IS NULL OR expense.payroll_settlement_entry_id IS DISTINCT FROM NEW.entry_id OR expense.payroll_settlement_insert_xid IS DISTINCT FROM txid_current()
      OR expense.payroll_calculation_entry_id IS DISTINCT FROM NEW.entry_id
      OR expense.source IS DISTINCT FROM 'payroll' OR expense.amount*100 IS DISTINCT FROM NEW.net_cents::numeric
      OR expense.expense_date IS DISTINCT FROM NEW.payment_date OR expense.created_by IS DISTINCT FROM NEW.created_by
      OR expense.category_id IS DISTINCT FROM e.finance_category_id
      OR expense.category IS DISTINCT FROM COALESCE(e.finance_category_name_snapshot,'Зарплата')
      OR expense.payment_method IS DISTINCT FROM NEW.payment_method OR expense.finance_account_id IS DISTINCT FROM NEW.finance_account_id
      OR expense.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
      OR expense.shift_id IS DISTINCT FROM NEW.shift_id THEN
      RAISE EXCEPTION 'payroll_lifecycle_expense_mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE expense_id=$1 AND id<>$2)',TG_TABLE_SCHEMA)
      INTO other_link USING NEW.expense_id,NEW.entry_id;
    IF other_link THEN RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.finance_accounts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
      INTO account USING NEW.venue_id,NEW.finance_account_id;
    IF account.id IS NULL OR NOT account.active OR account.name IS DISTINCT FROM NEW.finance_account_name_snapshot
      OR NOT(NEW.payment_method=ANY(account.allowed_payment_methods)) THEN
      RAISE EXCEPTION 'payroll_lifecycle_account_invalid' USING ERRCODE='23514'; END IF;
    IF account.kind='pos_cashbox' THEN
      EXECUTE format('SELECT * FROM %I.shifts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
        INTO shift_row USING NEW.venue_id,NEW.shift_id;
      EXECUTE format('SELECT count(*) FROM %I.shifts WHERE venue_id=$1 AND closed_at IS NULL',TG_TABLE_SCHEMA) INTO n USING NEW.venue_id;
      EXECUTE format('SELECT COALESCE(NULLIF(v.timezone,''''),NULLIF(o.timezone,''''),''Asia/Yekaterinburg'') FROM %I.venues v LEFT JOIN %I.organizations o ON o.id=v.organization_id WHERE v.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO zone USING NEW.venue_id;
      IF NEW.payment_method<>'cash' OR shift_row.id IS NULL OR shift_row.closed_at IS NOT NULL OR n<>1
        OR NEW.payment_date IS DISTINCT FROM (clock_timestamp() AT TIME ZONE COALESCE(zone,'UTC'))::date THEN
        RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514'; END IF;
    ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_expense_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense record; owner_entry uuid;
BEGIN
  IF NEW.expense_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.expense_id IS NOT DISTINCT FROM OLD.expense_id THEN RETURN NEW; END IF;
  EXECUTE format('SELECT id,venue_id,payroll_calculation_entry_id,payroll_settlement_entry_id,payroll_settlement_insert_xid,source FROM %I.expenses WHERE id=$1',TG_TABLE_SCHEMA)
    INTO expense USING NEW.expense_id;
  IF expense.id IS NULL OR expense.venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_not_visible' USING ERRCODE='23514';
  END IF;
  IF expense.payroll_settlement_entry_id IS DISTINCT FROM NEW.id
    OR expense.payroll_settlement_insert_xid IS DISTINCT FROM txid_current()
    OR expense.source IS DISTINCT FROM 'payroll' THEN
    RAISE EXCEPTION 'payroll_expense_reconciliation_required' USING ERRCODE='23514';
  END IF;
  IF expense.payroll_calculation_entry_id IS NOT NULL
     AND expense.payroll_calculation_entry_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514';
  END IF;
  EXECUTE format('SELECT entry_id FROM %I.payroll_calculation_entry_transitions WHERE expense_id=$1',TG_TABLE_SCHEMA)
    INTO owner_entry USING NEW.expense_id;
  IF owner_entry IS NOT NULL AND owner_entry<>NEW.id THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;



