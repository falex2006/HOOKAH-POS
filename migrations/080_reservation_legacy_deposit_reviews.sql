-- Store documentary review of the old reservation deposit_paid field without
-- turning that field into a receipt or a cash movement.
CREATE TABLE IF NOT EXISTS reservation_legacy_deposit_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  legacy_amount_snapshot numeric(12,2) NOT NULL CHECK (legacy_amount_snapshot > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  disposition text NOT NULL CHECK (disposition IN ('unreviewed','documents_found','documents_not_found','disputed')),
  review_note text NOT NULL CHECK (length(btrim(review_note)) BETWEEN 1 AND 500),
  evidence_reference text NOT NULL DEFAULT '' CHECK (length(evidence_reference) <= 250),
  supersedes_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,reservation_id,sequence),
  UNIQUE (venue_id,supersedes_id),
  UNIQUE (venue_id,reservation_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,supersedes_id) REFERENCES reservation_legacy_deposit_reviews (venue_id,reservation_id,id) ON DELETE RESTRICT,
  CHECK (disposition <> 'documents_found' OR length(btrim(evidence_reference)) > 0),
  CHECK ((sequence=1 AND supersedes_id IS NULL) OR (sequence>1 AND supersedes_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS reservation_legacy_deposit_reviews_head_idx
  ON reservation_legacy_deposit_reviews (venue_id,reservation_id,sequence DESC);

INSERT INTO reservation_legacy_deposit_reviews
  (venue_id,reservation_id,legacy_amount_snapshot,sequence,disposition,review_note,evidence_reference,idempotency_key)
SELECT venue_id,id,deposit_paid,1,'unreviewed',
  'Исходная сумма прежней системы; получение денег не подтверждено.', '',
  'baseline:' || id::text
FROM reservations
WHERE deposit_paid>0
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION guard_reservation_legacy_deposit_review_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owning_reservation_exists boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'legacy reservation deposit review history is immutable' USING ERRCODE='55000';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.reservations WHERE id=$1 AND venue_id=$2)',TG_TABLE_SCHEMA)
    INTO owning_reservation_exists USING OLD.reservation_id,OLD.venue_id;
  IF owning_reservation_exists THEN
    RAISE EXCEPTION 'legacy reservation deposit review history is immutable' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS reservation_legacy_deposit_reviews_immutable ON reservation_legacy_deposit_reviews;
CREATE TRIGGER reservation_legacy_deposit_reviews_immutable
  BEFORE UPDATE OR DELETE ON reservation_legacy_deposit_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_reservation_legacy_deposit_review_history();

CREATE OR REPLACE FUNCTION seed_reservation_legacy_deposit_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE head reservation_legacy_deposit_reviews%ROWTYPE;
        next_sequence integer;
BEGIN
  IF NEW.deposit_paid<=0 THEN RETURN NEW; END IF;
  SELECT * INTO head FROM reservation_legacy_deposit_reviews
    WHERE venue_id=NEW.venue_id AND reservation_id=NEW.id
    ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    next_sequence:=1;
  ELSIF head.legacy_amount_snapshot=NEW.deposit_paid THEN
    RETURN NEW;
  ELSE
    next_sequence:=head.sequence+1;
  END IF;
  INSERT INTO reservation_legacy_deposit_reviews
    (venue_id,reservation_id,legacy_amount_snapshot,sequence,disposition,review_note,evidence_reference,supersedes_id,idempotency_key)
  VALUES (NEW.venue_id,NEW.id,NEW.deposit_paid,next_sequence,'unreviewed',
    'Исходная сумма прежней системы; получение денег не подтверждено.', '',
    CASE WHEN next_sequence=1 THEN NULL ELSE head.id END,
    'baseline:'||NEW.id::text||':'||next_sequence::text)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_legacy_deposit_review_seed ON reservations;
CREATE TRIGGER reservations_legacy_deposit_review_seed
  AFTER INSERT OR UPDATE OF deposit_paid ON reservations
  FOR EACH ROW EXECUTE FUNCTION seed_reservation_legacy_deposit_review();
