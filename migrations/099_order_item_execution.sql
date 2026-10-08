-- Preparation is mutable operational state, separate from immutable financial items.
ALTER TABLE products ADD COLUMN IF NOT EXISTS preparation_station text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='products'::regclass AND conname='products_preparation_station_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_preparation_station_check CHECK (preparation_station IN ('bar','hookah'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_item_execution (
  order_item_id uuid PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  station text CHECK (station IN ('bar','hookah')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','queued','in_progress','ready')),
  dispatched_at timestamptz,
  started_at timestamptz,
  ready_at timestamptz
);
CREATE INDEX IF NOT EXISTS order_item_execution_station_status_idx ON order_item_execution(station,status);

-- Only open work is imported. Historical prices, item status and snapshots stay intact.
-- Unknown legacy categories require an explicit station selection at dispatch.
INSERT INTO order_item_execution(order_item_id,station,status)
SELECT oi.id, CASE WHEN oi.station IN ('bar','hookah') THEN oi.station ELSE NULL END,
  CASE WHEN o.status='ready' THEN 'ready' WHEN o.status='in_progress' THEN 'queued' ELSE 'new' END
FROM order_items oi JOIN orders o ON o.id=oi.order_id
WHERE o.status IN ('open','in_progress','ready')
ON CONFLICT (order_item_id) DO NOTHING;
