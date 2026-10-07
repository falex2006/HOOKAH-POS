ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_order_idempotency_key_uq
  ON payments (order_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_bonus_whole_points_check' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_bonus_whole_points_check
      CHECK (method <> 'bonus' OR amount = trunc(amount));
  END IF;
END
$$;
