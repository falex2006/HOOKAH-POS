-- Keep verified reservation prepayments separate from legacy deposit_paid values.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS verified_deposit_paid numeric(12,2) NOT NULL DEFAULT 0
  CHECK (verified_deposit_paid >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS reservations_venue_id_id_uq ON reservations (venue_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_venue_id_id_uq ON shifts (venue_id,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr')),
  reason text NOT NULL DEFAULT 'Предоплата по бронированию' CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipts_booking_idx
  ON reservation_pre_payment_receipts (venue_id,reservation_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipts_shift_cash_idx
  ON reservation_pre_payment_receipts (venue_id,shift_id,created_at) WHERE payment_method='cash';
