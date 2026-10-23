-- Keep all-time payroll refund coverage scoped to one venue/order cohort.
CREATE INDEX IF NOT EXISTS order_refund_items_venue_order_refund_idx
  ON order_refund_items (venue_id,order_id,refund_id,id);
