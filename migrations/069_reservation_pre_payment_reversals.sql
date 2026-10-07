-- Append-only reversals for reservation allocations and external prepayment refunds.
-- An allocation is released only as a whole while its order remains open; receipt refunds may be partial.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_allocations_venue_reservation_id_uq
  ON reservation_pre_payment_allocations (venue_id,reservation_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_allocations_venue_order_id_uq
  ON reservation_pre_payment_allocations (venue_id,order_id,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_allocation_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,allocation_id),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id,allocation_id) REFERENCES reservation_pre_payment_allocations (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,order_id) REFERENCES orders (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,payment_id) REFERENCES payments (order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocation_reversals_order_idx
  ON reservation_pre_payment_allocation_reversals (venue_id,order_id,created_at,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_receipt_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipt_reversals_receipt_idx
  ON reservation_pre_payment_receipt_reversals (venue_id,receipt_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipt_reversals_shift_idx
  ON reservation_pre_payment_receipt_reversals (venue_id,shift_id,created_at) WHERE payout_method='cash';
