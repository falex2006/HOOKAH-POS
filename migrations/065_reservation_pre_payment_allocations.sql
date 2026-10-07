-- Record how a collected reservation prepayment is applied to an order.
-- The original cash/card/QR receipt stays immutable and is never re-counted in the cash drawer.
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_id_id_uq ON orders (venue_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_order_id_id_uq ON payments (order_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_reservation_id_uq ON orders (venue_id,reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_reservation_id_triplet_uq ON orders (venue_id,reservation_id,id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_venue_reservation_fk' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_venue_reservation_fk
      FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_receipts_venue_reservation_id_uq ON reservation_pre_payment_receipts (venue_id,reservation_id,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,order_id) REFERENCES orders (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,payment_id) REFERENCES payments (order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,order_id) REFERENCES orders (venue_id,reservation_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocations_receipt_idx
  ON reservation_pre_payment_allocations (venue_id,receipt_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocations_order_idx
  ON reservation_pre_payment_allocations (venue_id,order_id,created_at,id);
