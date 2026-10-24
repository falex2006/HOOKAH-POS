-- POS cash and card/QR tenders use server-owned finance destinations.
-- Cash still maps to the active shift cashbox; card and QR use a separate
-- electronic clearing account so operators never choose an account or terminal.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM venues v
    JOIN finance_accounts a ON a.venue_id=v.id AND a.code='main_cashbox'
    WHERE a.kind<>'pos_cashbox' OR NOT ('cash'=ANY(a.allowed_payment_methods)) OR NOT a.active
  ) THEN
    RAISE EXCEPTION 'main_cashbox_account_identity_conflict';
  END IF;
  IF EXISTS (
    SELECT 1 FROM venues v
    JOIN finance_accounts a ON a.venue_id=v.id AND a.code='pos_card_receipts'
    WHERE a.kind<>'electronic' OR NOT (ARRAY['card','qr']::text[] <@ a.allowed_payment_methods) OR NOT a.active
  ) THEN
    RAISE EXCEPTION 'pos_card_receipts_account_identity_conflict';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ensure_finance_account_defaults(target_venue uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods)
  VALUES(target_venue,'main_cashbox','Основная касса','pos_cashbox',ARRAY['cash']::text[])
  ON CONFLICT (venue_id,code) DO NOTHING;
  INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods)
  VALUES(target_venue,'pos_card_receipts','Оплата картой и QR','electronic',ARRAY['card','qr']::text[])
  ON CONFLICT (venue_id,code) DO NOTHING;
END; $$;

DO $$ DECLARE venue_row record; BEGIN
  FOR venue_row IN SELECT id FROM venues LOOP
    PERFORM ensure_finance_account_defaults(venue_row.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION guard_pos_system_tender_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.code IN ('main_cashbox','pos_card_receipts') THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'finance_system_account_cannot_be_deleted' USING ERRCODE='23514';
    END IF;
    IF OLD.active AND NOT NEW.active THEN
      RAISE EXCEPTION 'finance_system_account_cannot_be_archived' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_accounts_pos_system_tender_guard ON finance_accounts;
CREATE TRIGGER finance_accounts_pos_system_tender_guard
  BEFORE UPDATE OR DELETE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_pos_system_tender_account();
