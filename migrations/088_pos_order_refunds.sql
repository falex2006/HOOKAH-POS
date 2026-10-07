-- Finance-owned append-only POS payout ledger.
-- This migration records factual external refunds only; it does not infer
-- employee attribution or rewrite payments/orders.
CREATE TABLE IF NOT EXISTS order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  order_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  item_attribution_status text NOT NULL DEFAULT 'unattributed'
    CHECK (item_attribution_status = 'unattributed'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 120),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, id, order_id),
  UNIQUE (venue_id, idempotency_key),
  FOREIGN KEY (venue_id, order_id) REFERENCES orders (venue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id, shift_id) REFERENCES shifts (venue_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS order_refund_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  source_payment_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  FOREIGN KEY (venue_id, refund_id, order_id) REFERENCES order_refunds (venue_id, id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, source_payment_id) REFERENCES payments (order_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS order_refunds_order_idx
  ON order_refunds (venue_id, order_id, created_at, id);
CREATE INDEX IF NOT EXISTS order_refunds_shift_idx
  ON order_refunds (venue_id, shift_id, created_at);
CREATE INDEX IF NOT EXISTS order_refund_tenders_refund_idx
  ON order_refund_tenders (venue_id, refund_id, created_at);
CREATE INDEX IF NOT EXISTS order_refund_tenders_payment_cap_idx
  ON order_refund_tenders (venue_id, order_id, source_payment_id, created_at);

CREATE OR REPLACE FUNCTION reject_order_refund_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order refunds are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS order_refunds_immutable ON order_refunds;
CREATE TRIGGER order_refunds_immutable
  BEFORE UPDATE OR DELETE ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refunds_no_truncate ON order_refunds;
CREATE TRIGGER order_refunds_no_truncate
  BEFORE TRUNCATE ON order_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refund_tenders_immutable ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_immutable
  BEFORE UPDATE OR DELETE ON order_refund_tenders
  FOR EACH ROW EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refund_tenders_no_truncate ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_no_truncate
  BEFORE TRUNCATE ON order_refund_tenders
  FOR EACH STATEMENT EXECUTE FUNCTION reject_order_refund_mutation();
