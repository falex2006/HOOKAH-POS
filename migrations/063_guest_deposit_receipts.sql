-- Record real stored-value deposits separately from sales and the account ledger.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_venue_id_id_uq ON shifts (venue_id,id);

ALTER TABLE guest_account_entries
  DROP CONSTRAINT IF EXISTS guest_account_entries_source_type_check;
ALTER TABLE guest_account_entries
  ADD CONSTRAINT guest_account_entries_source_type_check
  CHECK (source_type IN ('opening_balance','manual_adjustment','order','reservation','refund','reversal','deposit_top_up'));

CREATE TABLE IF NOT EXISTS guest_deposit_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_deposit_receipts_guest_created_idx
  ON guest_deposit_receipts (venue_id,guest_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS guest_deposit_receipts_shift_cash_idx
  ON guest_deposit_receipts (venue_id,shift_id,created_at) WHERE payment_method='cash';
