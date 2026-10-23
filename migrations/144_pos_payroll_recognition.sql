-- Prospective immutable POS evidence for payroll consumers. No historical backfill,
-- payout posting, payroll approval, deduction or automatic official-readiness change.
CREATE TABLE IF NOT EXISTS pos_payroll_recognition_epochs (
  venue_id uuid PRIMARY KEY REFERENCES venues(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
  activated_at timestamptz NOT NULL,
  activation_scope text NOT NULL CHECK(activation_scope IN ('existing_at_install','new_venue')),
  timezone_snapshot text,
  activated_local_date date,
  CHECK((timezone_snapshot IS NULL)=(activated_local_date IS NULL))
);
-- Initial installation only. On replay the WHERE clause produces no rows, so the
-- already-installed immutable INSERT guard is never invoked. Never reset a clock.
INSERT INTO pos_payroll_recognition_epochs(venue_id,activated_at,activation_scope,timezone_snapshot,activated_local_date)
  SELECT v.id,transaction_timestamp(),'existing_at_install',tz.name,
    CASE WHEN tz.name IS NULL THEN NULL ELSE (transaction_timestamp() AT TIME ZONE tz.name)::date END
  FROM venues v LEFT JOIN pg_timezone_names tz ON tz.name=v.timezone
  WHERE NOT EXISTS(SELECT 1 FROM pos_payroll_recognition_epochs e WHERE e.venue_id=v.id);

CREATE OR REPLACE FUNCTION guard_pos_payroll_recognition_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'pos_payroll_recognition_epoch_internal_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_payroll_recognition_epoch_guard ON pos_payroll_recognition_epochs;
CREATE TRIGGER pos_payroll_recognition_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_payroll_recognition_epochs
  FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_recognition_epoch();
DROP TRIGGER IF EXISTS pos_payroll_recognition_epoch_no_truncate ON pos_payroll_recognition_epochs;
CREATE TRIGGER pos_payroll_recognition_epoch_no_truncate BEFORE TRUNCATE ON pos_payroll_recognition_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_payroll_recognition_epoch();

CREATE OR REPLACE FUNCTION capture_pos_payroll_recognition_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tz text;
BEGIN
  SELECT name INTO tz FROM pg_timezone_names WHERE name=NEW.timezone;
  INSERT INTO pos_payroll_recognition_epochs(venue_id,activated_at,activation_scope,timezone_snapshot,activated_local_date)
    VALUES(NEW.id,transaction_timestamp(),'new_venue',tz,
      CASE WHEN tz IS NULL THEN NULL ELSE (transaction_timestamp() AT TIME ZONE tz)::date END);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS venues_payroll_recognition_epoch ON venues;
CREATE TRIGGER venues_payroll_recognition_epoch AFTER INSERT ON venues
  FOR EACH ROW EXECUTE FUNCTION capture_pos_payroll_recognition_epoch();

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payroll_attribution_captured_at timestamptz;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payroll_attribution_policy_version integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payroll_eligibility_status text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payroll_eligibility_venue_id uuid;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payroll_employee_venue_id uuid;

CREATE OR REPLACE FUNCTION capture_pos_payroll_item_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_venue uuid; employee_venue uuid; employee_active boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.sales_employee_id IS DISTINCT FROM OLD.sales_employee_id
      OR NEW.sold_at IS DISTINCT FROM OLD.sold_at
      OR NEW.payroll_attribution_captured_at IS DISTINCT FROM OLD.payroll_attribution_captured_at
      OR NEW.payroll_attribution_policy_version IS DISTINCT FROM OLD.payroll_attribution_policy_version
      OR NEW.payroll_eligibility_status IS DISTINCT FROM OLD.payroll_eligibility_status
      OR NEW.payroll_eligibility_venue_id IS DISTINCT FROM OLD.payroll_eligibility_venue_id
      OR NEW.payroll_employee_venue_id IS DISTINCT FROM OLD.payroll_employee_venue_id THEN
      RAISE EXCEPTION 'pos_payroll_item_attribution_immutable' USING ERRCODE='55000';
    END IF;
    IF NEW.order_id IS DISTINCT FROM OLD.order_id AND OLD.payroll_eligibility_venue_id IS NOT NULL THEN
      SELECT venue_id INTO item_venue FROM orders WHERE id=NEW.order_id;
      IF item_venue IS DISTINCT FROM OLD.payroll_eligibility_venue_id THEN
        RAISE EXCEPTION 'pos_payroll_item_attribution_venue_mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payroll_attribution_captured_at IS NOT NULL OR NEW.payroll_attribution_policy_version IS NOT NULL
    OR NEW.payroll_eligibility_status IS NOT NULL OR NEW.payroll_eligibility_venue_id IS NOT NULL
    OR NEW.payroll_employee_venue_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_payroll_item_attribution_server_managed' USING ERRCODE='55000';
  END IF;
  SELECT venue_id INTO item_venue FROM orders WHERE id=NEW.order_id;
  SELECT venue_id,(is_active AND deleted_at IS NULL) INTO employee_venue,employee_active
    FROM users WHERE id=NEW.sales_employee_id;
  NEW.payroll_attribution_captured_at:=transaction_timestamp();
  NEW.payroll_attribution_policy_version:=1;
  NEW.payroll_eligibility_venue_id:=item_venue;
  NEW.payroll_employee_venue_id:=employee_venue;
  NEW.payroll_eligibility_status:=CASE
    WHEN NEW.sales_employee_id IS NULL OR NEW.sold_at IS NULL OR employee_active IS DISTINCT FROM true THEN 'unknown'
    WHEN employee_venue=item_venue THEN 'same_venue'
    ELSE 'cross_venue' END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_items_payroll_attribution_capture ON order_items;
CREATE TRIGGER order_items_payroll_attribution_capture BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION capture_pos_payroll_item_attribution();

CREATE TABLE IF NOT EXISTS pos_payroll_sale_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  order_id uuid NOT NULL,
  snapshot_id uuid,
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
  recognized_at timestamptz NOT NULL,
  timezone_snapshot text,
  recognized_local_date date,
  source_closed_at timestamptz,
  currency_code text NOT NULL DEFAULT 'RUB' CHECK(currency_code='RUB'),
  coverage_status text NOT NULL CHECK(coverage_status IN ('complete','incomplete')),
  coverage_reasons text[] NOT NULL DEFAULT '{}',
  UNIQUE(venue_id,order_id), UNIQUE(venue_id,id,order_id),
  FOREIGN KEY(venue_id,order_id) REFERENCES orders(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,snapshot_id,order_id) REFERENCES pos_order_pricing_snapshots(venue_id,id,order_id) ON DELETE RESTRICT,
  CHECK((timezone_snapshot IS NULL)=(recognized_local_date IS NULL)),
  CHECK((coverage_status='complete')=(cardinality(coverage_reasons)=0))
);
CREATE TABLE IF NOT EXISTS pos_payroll_sale_line_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  sale_event_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  pricing_line_id uuid NOT NULL REFERENCES pos_order_pricing_snapshot_lines(id) ON DELETE RESTRICT,
  seller_id uuid,
  sold_at timestamptz,
  attribution_captured_at timestamptz,
  attribution_policy_version integer,
  eligibility_status text NOT NULL CHECK(eligibility_status IN ('same_venue','cross_venue','unknown')),
  eligibility_venue_id uuid,
  employee_venue_id uuid,
  UNIQUE(venue_id,order_item_id), UNIQUE(venue_id,id,order_id,order_item_id),
  FOREIGN KEY(venue_id,sale_event_id,order_id) REFERENCES pos_payroll_sale_events(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,snapshot_id,order_id,order_item_id) REFERENCES pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT
);

-- Time is captured before the header is inserted. Final source coverage is inspected
-- at the deferred transaction boundary, after the caller has inserted tender/items.
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payroll_recognized_at timestamptz;
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payroll_timezone_snapshot text;
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payroll_recognized_local_date date;
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payroll_recognition_policy_version integer;
CREATE TABLE IF NOT EXISTS pos_payroll_refund_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  original_sale_event_id uuid,
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
  recognized_at timestamptz NOT NULL,
  timezone_snapshot text,
  recognized_local_date date,
  currency_code text NOT NULL DEFAULT 'RUB' CHECK(currency_code='RUB'),
  item_attribution_status text NOT NULL CHECK(item_attribution_status IN ('complete','unattributed','not_applicable')),
  payout_minor bigint NOT NULL CHECK(payout_minor>0),
  tender_total_minor bigint NOT NULL CHECK(tender_total_minor>=0),
  coverage_status text NOT NULL CHECK(coverage_status IN ('complete','incomplete')),
  coverage_reasons text[] NOT NULL DEFAULT '{}',
  UNIQUE(venue_id,refund_id), UNIQUE(venue_id,id,order_id),
  FOREIGN KEY(venue_id,refund_id,order_id) REFERENCES order_refunds(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_sale_event_id,order_id) REFERENCES pos_payroll_sale_events(venue_id,id,order_id) ON DELETE RESTRICT,
  CHECK((timezone_snapshot IS NULL)=(recognized_local_date IS NULL)),
  CHECK((coverage_status='complete')=(cardinality(coverage_reasons)=0))
);
CREATE TABLE IF NOT EXISTS pos_payroll_refund_line_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_event_id uuid NOT NULL,
  refund_item_id uuid NOT NULL,
  order_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  original_sale_line_event_id uuid,
  producer_sequence bigint,
  previous_returned_quantity numeric(12,3),
  returned_quantity numeric(12,3) NOT NULL,
  cumulative_returned_quantity numeric(12,3),
  previous_returned_item_value_minor bigint,
  returned_item_value_minor bigint NOT NULL,
  cumulative_returned_item_value_minor bigint,
  UNIQUE(venue_id,refund_item_id),
  FOREIGN KEY(venue_id,refund_event_id,order_id) REFERENCES pos_payroll_refund_events(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,refund_item_id) REFERENCES order_refund_items(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,snapshot_id,order_id,order_item_id) REFERENCES pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_sale_line_event_id,order_id,order_item_id) REFERENCES pos_payroll_sale_line_events(venue_id,id,order_id,order_item_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION guard_pos_payroll_recognition_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'pos_payroll_recognition_internal_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pos_payroll_sale_events','pos_payroll_sale_line_events','pos_payroll_refund_events','pos_payroll_refund_line_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pos_payroll_evidence_guard ON %I',table_name);
    EXECUTE format('CREATE TRIGGER pos_payroll_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_recognition_evidence()',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS pos_payroll_evidence_no_truncate ON %I',table_name);
    EXECUTE format('CREATE TRIGGER pos_payroll_evidence_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_payroll_recognition_evidence()',table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION capture_pos_payroll_sale_recognition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap record; event_id uuid; event_time timestamptz:=transaction_timestamp(); tz text; local_day date;
  reasons text[]:='{}'; item_count bigint; line_count bigint; frozen_net bigint;
BEGIN
  IF NEW.status IS DISTINCT FROM 'closed' OR (TG_OP='UPDATE' AND OLD.status='closed') THEN RETURN NEW; END IF;
  -- A reopened historical record must never mint a second recognition event.
  IF EXISTS(SELECT 1 FROM pos_payroll_sale_events WHERE venue_id=NEW.venue_id AND order_id=NEW.id) THEN
    RAISE EXCEPTION 'pos_payroll_sale_already_recognized' USING ERRCODE='55000';
  END IF;
  SELECT timezone INTO tz FROM venues WHERE id=NEW.venue_id;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN
    tz:=NULL; reasons:=array_append(reasons,'timezone_unavailable');
  ELSE local_day:=(event_time AT TIME ZONE tz)::date; END IF;
  IF NEW.closed_at IS NULL THEN reasons:=array_append(reasons,'source_closed_at_missing');
  ELSIF NEW.closed_at IS DISTINCT FROM event_time THEN reasons:=array_append(reasons,'source_close_time_mismatch'); END IF;
  SELECT * INTO snap FROM pos_order_pricing_snapshots WHERE venue_id=NEW.venue_id AND order_id=NEW.id;
  IF NOT FOUND THEN reasons:=array_append(reasons,'pricing_snapshot_missing');
  ELSE
    SELECT count(*) INTO item_count FROM order_items WHERE order_id=NEW.id;
    SELECT count(*),COALESCE(sum(net_minor),0) INTO line_count,frozen_net
      FROM pos_order_pricing_snapshot_lines WHERE venue_id=NEW.venue_id AND snapshot_id=snap.id AND order_id=NEW.id;
    IF line_count<>item_count OR frozen_net<>snap.subtotal_minor-snap.discount_minor THEN
      reasons:=array_append(reasons,'pricing_line_coverage_mismatch');
    END IF;
    IF EXISTS(SELECT 1 FROM pos_order_pricing_snapshot_lines l JOIN order_items i ON i.id=l.order_item_id AND i.order_id=l.order_id
      WHERE l.venue_id=NEW.venue_id AND l.snapshot_id=snap.id AND
      (i.payroll_attribution_policy_version IS DISTINCT FROM 1 OR i.payroll_attribution_captured_at IS NULL
       OR i.payroll_eligibility_venue_id IS DISTINCT FROM NEW.venue_id OR i.payroll_eligibility_status IS DISTINCT FROM 'same_venue'
       OR i.sales_employee_id IS DISTINCT FROM l.seller_id OR i.sold_at IS DISTINCT FROM l.sold_at)) THEN
      reasons:=array_append(reasons,'seller_eligibility_unattested');
    END IF;
  END IF;
  INSERT INTO pos_payroll_sale_events(venue_id,order_id,snapshot_id,recognized_at,timezone_snapshot,recognized_local_date,source_closed_at,coverage_status,coverage_reasons)
    VALUES(NEW.venue_id,NEW.id,snap.id,event_time,tz,local_day,NEW.closed_at,CASE WHEN cardinality(reasons)=0 THEN 'complete' ELSE 'incomplete' END,reasons)
    RETURNING id INTO event_id;
  IF snap.id IS NOT NULL THEN
    INSERT INTO pos_payroll_sale_line_events(venue_id,sale_event_id,snapshot_id,order_id,order_item_id,pricing_line_id,seller_id,sold_at,
      attribution_captured_at,attribution_policy_version,eligibility_status,eligibility_venue_id,employee_venue_id)
    SELECT l.venue_id,event_id,l.snapshot_id,l.order_id,l.order_item_id,l.id,l.seller_id,l.sold_at,
      i.payroll_attribution_captured_at,i.payroll_attribution_policy_version,COALESCE(i.payroll_eligibility_status,'unknown'),i.payroll_eligibility_venue_id,i.payroll_employee_venue_id
      FROM pos_order_pricing_snapshot_lines l JOIN order_items i ON i.id=l.order_item_id AND i.order_id=l.order_id
      WHERE l.venue_id=NEW.venue_id AND l.snapshot_id=snap.id AND l.order_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS orders_payroll_sale_recognition ON orders;
CREATE TRIGGER orders_payroll_sale_recognition AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION capture_pos_payroll_sale_recognition();

CREATE OR REPLACE FUNCTION capture_pos_payroll_refund_time() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tz text;
BEGIN
  IF NEW.payroll_recognized_at IS NOT NULL OR NEW.payroll_timezone_snapshot IS NOT NULL
    OR NEW.payroll_recognized_local_date IS NOT NULL OR NEW.payroll_recognition_policy_version IS NOT NULL THEN
    RAISE EXCEPTION 'pos_payroll_refund_time_server_managed' USING ERRCODE='55000';
  END IF;
  NEW.payroll_recognized_at:=transaction_timestamp();
  NEW.payroll_recognition_policy_version:=1;
  SELECT timezone INTO tz FROM venues WHERE id=NEW.venue_id;
  IF tz IS NOT NULL AND EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN
    NEW.payroll_timezone_snapshot:=tz;
    NEW.payroll_recognized_local_date:=(NEW.payroll_recognized_at AT TIME ZONE tz)::date;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refunds_payroll_time ON order_refunds;
CREATE TRIGGER order_refunds_payroll_time BEFORE INSERT ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION capture_pos_payroll_refund_time();

CREATE OR REPLACE FUNCTION capture_pos_payroll_refund_recognition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sale record; event_id uuid; tenders bigint; item_count bigint; reasons text[]:='{}';
BEGIN
  -- A payment row lock alone cannot refresh an already-established RR snapshot.
  -- Only the actual HTTP writer's READ COMMITTED mode attests aggregate coverage.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    reasons:=array_append(reasons,'producer_isolation_unsupported');
  END IF;
  SELECT * INTO sale FROM pos_payroll_sale_events WHERE venue_id=NEW.venue_id AND order_id=NEW.order_id;
  IF NOT FOUND THEN reasons:=array_append(reasons,'original_sale_recognition_missing');
  ELSIF sale.coverage_status<>'complete' THEN reasons:=array_append(reasons,'original_sale_recognition_incomplete'); END IF;
  IF NEW.payroll_timezone_snapshot IS NULL OR NEW.payroll_recognized_local_date IS NULL THEN
    reasons:=array_append(reasons,'timezone_unavailable');
  END IF;
  SELECT COALESCE(sum(amount*100),0)::bigint INTO tenders FROM order_refund_tenders
    WHERE venue_id=NEW.venue_id AND refund_id=NEW.id AND order_id=NEW.order_id;
  IF tenders<>(NEW.amount*100)::bigint THEN reasons:=array_append(reasons,'tender_payout_mismatch'); END IF;
  IF EXISTS(SELECT 1 FROM order_refund_tenders t JOIN payments p ON p.id=t.source_payment_id AND p.order_id=t.order_id
    WHERE t.venue_id=NEW.venue_id AND t.refund_id=NEW.id
      AND (p.method NOT IN ('cash','card','qr') OR p.status NOT IN ('paid','partially_paid'))) THEN
    reasons:=array_append(reasons,'external_tender_source_invalid');
  END IF;
  IF EXISTS(SELECT 1 FROM order_refund_tenders t JOIN payments p ON p.id=t.source_payment_id AND p.order_id=t.order_id
    WHERE t.venue_id=NEW.venue_id AND t.refund_id=NEW.id AND
      (SELECT COALESCE(sum(all_t.amount),0) FROM order_refund_tenders all_t
       WHERE all_t.venue_id=t.venue_id AND all_t.order_id=t.order_id AND all_t.source_payment_id=t.source_payment_id)>p.amount) THEN
    reasons:=array_append(reasons,'external_tender_source_cap_exceeded');
  END IF;
  SELECT count(*) INTO item_count FROM order_refund_items WHERE venue_id=NEW.venue_id AND refund_id=NEW.id AND order_id=NEW.order_id;
  IF NEW.item_attribution_status='unattributed' THEN reasons:=array_append(reasons,'item_attribution_unattributed');
  ELSIF NEW.item_attribution_status='complete' AND item_count=0 THEN reasons:=array_append(reasons,'item_attribution_empty');
  ELSIF NEW.item_attribution_status='not_applicable' AND item_count<>0 THEN reasons:=array_append(reasons,'item_attribution_unexpected'); END IF;
  IF EXISTS(SELECT 1 FROM order_refund_items ri LEFT JOIN pos_payroll_sale_line_events sl
      ON sl.venue_id=ri.venue_id AND sl.snapshot_id=ri.snapshot_id AND sl.order_id=ri.order_id AND sl.order_item_id=ri.order_item_id
    WHERE ri.venue_id=NEW.venue_id AND ri.refund_id=NEW.id AND
      (sl.id IS NULL OR ri.producer_sequence IS NULL
       OR EXISTS(SELECT 1 FROM order_refund_items prior WHERE prior.venue_id=ri.venue_id AND prior.snapshot_id=ri.snapshot_id
         AND prior.order_id=ri.order_id AND prior.order_item_id=ri.order_item_id AND prior.producer_sequence IS NULL)
       OR (SELECT count(*) FROM order_refund_items prior WHERE prior.venue_id=ri.venue_id AND prior.snapshot_id=ri.snapshot_id
         AND prior.order_id=ri.order_id AND prior.order_item_id=ri.order_item_id AND prior.producer_sequence<=ri.producer_sequence)<>ri.producer_sequence)) THEN
    reasons:=array_append(reasons,'item_source_lineage_incomplete');
  END IF;
  INSERT INTO pos_payroll_refund_events(venue_id,refund_id,order_id,original_sale_event_id,recognized_at,timezone_snapshot,recognized_local_date,
    item_attribution_status,payout_minor,tender_total_minor,coverage_status,coverage_reasons)
    VALUES(NEW.venue_id,NEW.id,NEW.order_id,sale.id,NEW.payroll_recognized_at,NEW.payroll_timezone_snapshot,NEW.payroll_recognized_local_date,
      NEW.item_attribution_status,(NEW.amount*100)::bigint,tenders,CASE WHEN cardinality(reasons)=0 THEN 'complete' ELSE 'incomplete' END,reasons)
    RETURNING id INTO event_id;
  INSERT INTO pos_payroll_refund_line_events(venue_id,refund_event_id,refund_item_id,order_id,snapshot_id,order_item_id,original_sale_line_event_id,
    producer_sequence,previous_returned_quantity,returned_quantity,cumulative_returned_quantity,
    previous_returned_item_value_minor,returned_item_value_minor,cumulative_returned_item_value_minor)
    SELECT ri.venue_id,event_id,ri.id,ri.order_id,ri.snapshot_id,ri.order_item_id,sl.id,
      ri.producer_sequence,ri.previous_returned_quantity,ri.returned_quantity,ri.cumulative_returned_quantity,
      ri.previous_returned_item_value_minor,ri.returned_item_value_minor,ri.cumulative_returned_item_value_minor
    FROM order_refund_items ri LEFT JOIN pos_payroll_sale_line_events sl
      ON sl.venue_id=ri.venue_id AND sl.snapshot_id=ri.snapshot_id AND sl.order_id=ri.order_id AND sl.order_item_id=ri.order_item_id
    WHERE ri.venue_id=NEW.venue_id AND ri.refund_id=NEW.id AND ri.order_id=NEW.order_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refunds_payroll_recognition ON order_refunds;
CREATE CONSTRAINT TRIGGER order_refunds_payroll_recognition AFTER INSERT ON order_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION capture_pos_payroll_refund_recognition();

CREATE OR REPLACE FUNCTION guard_pos_payroll_refund_sealed_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize a late writer with the header transaction before inspecting the seal.
  PERFORM 1 FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id AND order_id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payroll_refund_source_parent_unavailable' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM pos_payroll_refund_events WHERE venue_id=NEW.venue_id AND refund_id=NEW.refund_id) THEN
    RAISE EXCEPTION 'pos_payroll_refund_source_sealed' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='order_refund_tenders' THEN
    PERFORM 1 FROM payments WHERE id=NEW.source_payment_id AND order_id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'pos_payroll_refund_payment_unavailable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refund_tenders_payroll_seal ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_payroll_seal BEFORE INSERT ON order_refund_tenders
  FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_refund_sealed_source();
DROP TRIGGER IF EXISTS order_refund_items_payroll_seal ON order_refund_items;
CREATE TRIGGER order_refund_items_payroll_seal BEFORE INSERT ON order_refund_items
  FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_refund_sealed_source();

CREATE OR REPLACE FUNCTION guard_pos_payroll_sale_sealed_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM orders WHERE venue_id=NEW.venue_id AND id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pos_payroll_sale_source_parent_unavailable' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pos_payroll_sale_events WHERE venue_id=NEW.venue_id AND order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'pos_payroll_sale_source_sealed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshots_payroll_seal ON pos_order_pricing_snapshots;
CREATE TRIGGER pos_order_pricing_snapshots_payroll_seal BEFORE INSERT ON pos_order_pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_sale_sealed_source();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_payroll_seal ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_lines_payroll_seal BEFORE INSERT ON pos_order_pricing_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION guard_pos_payroll_sale_sealed_source();

CREATE INDEX IF NOT EXISTS pos_payroll_sale_events_period_idx ON pos_payroll_sale_events(venue_id,recognized_local_date,id);
CREATE INDEX IF NOT EXISTS pos_payroll_refund_events_period_idx ON pos_payroll_refund_events(venue_id,recognized_local_date,id);
