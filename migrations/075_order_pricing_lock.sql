-- The first accepted tender fixes the complete price used for this order.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pricing_locked_at timestamptz;

CREATE INDEX IF NOT EXISTS orders_venue_pricing_locked_idx
  ON orders (venue_id, pricing_locked_at)
  WHERE pricing_locked_at IS NOT NULL;

-- Preserve the pre-migration price of legacy orders that already received a tender.
-- Campaign activation remains disabled during this migration, so only the previously
-- supported manual/group discount rules participate in this one-time compatibility snapshot.
WITH paid AS (
  SELECT order_id, MIN(created_at) AS first_paid_at
  FROM payments
  WHERE status IN ('paid','partially_paid')
  GROUP BY order_id
), items AS (
  SELECT order_id, ROUND(COALESCE(SUM(quantity * unit_price),0),2) AS subtotal
  FROM order_items GROUP BY order_id
), manual AS (
  SELECT d.order_id,
    LEAST(COALESCE(i.subtotal,0), SUM(ROUND(CASE WHEN d.type='percent'
      THEN COALESCE(i.subtotal,0)*LEAST(100,GREATEST(0,d.value))/100
      ELSE GREATEST(0,d.value) END,2))) AS amount
  FROM discounts d JOIN items i ON i.order_id=d.order_id
  WHERE d.status='approved' GROUP BY d.order_id,i.subtotal
), pricing AS (
  SELECT o.id,o.venue_id,p.first_paid_at,COALESCE(i.subtotal,0) AS subtotal,
    ROUND(COALESCE(i.subtotal,0)*COALESCE(o.group_discount_percent,0)/100,2) AS group_amount,
    COALESCE(m.amount,0) AS manual_amount,
    GREATEST(COALESCE(i.subtotal,0),COALESCE(o.vip_minimum,0)) AS gross_floor
  FROM orders o JOIN paid p ON p.order_id=o.id LEFT JOIN items i ON i.order_id=o.id
  LEFT JOIN manual m ON m.order_id=o.id
  WHERE o.status IN ('open','in_progress','ready') AND o.pricing_locked_at IS NULL
), chosen AS (
  SELECT *, CASE WHEN group_amount >= manual_amount THEN group_amount ELSE manual_amount END AS discount,
    CASE WHEN group_amount >= manual_amount AND group_amount > 0 THEN 'guest_group'
      WHEN manual_amount > 0 THEN 'manual' ELSE 'none' END AS source
  FROM pricing
)
UPDATE orders o SET pricing_locked_at=c.first_paid_at,pricing_version=1,
  subtotal_snapshot=c.subtotal,discount_total_snapshot=c.discount,
  minimum_adjustment_snapshot=GREATEST(0,COALESCE(o.vip_minimum,0)-GREATEST(0,c.subtotal-c.discount)),
  final_total_snapshot=GREATEST(COALESCE(o.vip_minimum,0),GREATEST(0,c.subtotal-c.discount)),
  group_discount_base=CASE WHEN c.source='guest_group' THEN c.subtotal END,
  group_discount_amount=CASE WHEN c.source='guest_group' THEN c.group_amount END,
  effective_discount_source=c.source
FROM chosen c WHERE o.id=c.id AND o.venue_id=c.venue_id;
