-- Durable, auditable guest bonus and stored-value movements.
CREATE UNIQUE INDEX IF NOT EXISTS guests_venue_id_id_uq ON guests (venue_id,id);
CREATE TABLE IF NOT EXISTS guest_account_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  account_type text NOT NULL CHECK (account_type IN ('bonus','deposit')),
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  source_type text NOT NULL CHECK (source_type IN ('opening_balance','manual_adjustment','order','reservation','refund','reversal')),
  source_id uuid,
  source_key text,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_type <> 'bonus' OR amount = trunc(amount)),
  UNIQUE (venue_id, id),
  UNIQUE (guest_id, account_type, source_key),
  CONSTRAINT guest_account_entries_guest_venue_fk FOREIGN KEY (venue_id,guest_id)
    REFERENCES guests (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_account_entries_guest_created_idx
  ON guest_account_entries (venue_id, guest_id, account_type, created_at DESC, id);
CREATE INDEX IF NOT EXISTS guest_account_entries_source_idx
  ON guest_account_entries (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- Existing balances have no reliable movement history. Record their current
-- value once as an opening balance; do not fabricate past transactions.
INSERT INTO guest_account_entries (venue_id, guest_id, account_type, amount, reason, source_type, source_key)
SELECT venue_id, id, 'bonus', loyalty_points, 'Начальный остаток при подключении журнала', 'opening_balance', 'migration-059'
FROM guests WHERE venue_id IS NOT NULL AND loyalty_points > 0
ON CONFLICT (guest_id, account_type, source_key) DO NOTHING;

INSERT INTO guest_account_entries (venue_id, guest_id, account_type, amount, reason, source_type, source_key)
SELECT venue_id, id, 'deposit', deposit_balance, 'Начальный остаток при подключении журнала', 'opening_balance', 'migration-059'
FROM guests WHERE venue_id IS NOT NULL AND deposit_balance > 0
ON CONFLICT (guest_id, account_type, source_key) DO NOTHING;
