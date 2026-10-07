-- Immutable reversals for guest-account ledger entries.
-- A reversal always records the actual handling shift and never edits its source entry.
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_entries_venue_guest_id_uq ON guest_account_entries(venue_id,guest_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_entries_venue_guest_type_id_uq ON guest_account_entries(venue_id,guest_id,account_type,id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_guest_id_uq ON orders(venue_id,guest_id,id);
CREATE TABLE IF NOT EXISTS guest_account_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  source_entry_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('bonus','deposit')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND (account_type <> 'bonus' OR amount=trunc(amount))),
  payout_method text NOT NULL CHECK (payout_method IN ('wallet','cash','card','qr','clawback')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,guest_id,id),
  CHECK ((account_type='bonus' AND payout_method IN ('wallet','clawback') OR account_type='deposit' AND payout_method IN ('wallet','cash','card','qr'))),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,account_type,source_entry_id) REFERENCES guest_account_entries (venue_id,guest_id,account_type,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_account_reversals_source_idx ON guest_account_reversals (venue_id,source_entry_id,created_at,id);
CREATE INDEX IF NOT EXISTS guest_account_reversals_shift_idx ON guest_account_reversals (venue_id,shift_id,created_at);

-- Immutable positive rows create a bonus hold; negative rows release it
-- against a future award. Outstanding liability is derived by summing entries.
CREATE TABLE IF NOT EXISTS guest_bonus_clawback_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  reversal_id uuid NOT NULL,
  order_id uuid,
  amount integer NOT NULL CHECK (amount <> 0),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 8 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,source_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,reversal_id) REFERENCES guest_account_reversals (venue_id,guest_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,order_id) REFERENCES orders (venue_id,guest_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_bonus_clawback_entries_guest_idx ON guest_bonus_clawback_entries (venue_id,guest_id,created_at,id);
