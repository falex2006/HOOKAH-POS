'use strict';

const orderPricingSqlCtes = `canonical_totals AS (
  SELECT order_id,venue_id,subtotal_minor/100.0 AS subtotal,discount_minor/100.0 AS discount,minimum_adjustment_minor/100.0 AS minimum_adjustment,final_total_minor/100.0 AS final_total
  FROM pos_order_pricing_snapshots
), item_totals AS (
  SELECT o.id AS order_id,COALESCE(c.subtotal,SUM(oi.quantity*oi.unit_price),0) AS subtotal FROM orders o
  LEFT JOIN canonical_totals c ON c.order_id=o.id AND c.venue_id=o.venue_id LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id,c.subtotal
), manual_totals AS (
  SELECT d.order_id,LEAST(COALESCE(i.subtotal,0),COALESCE(SUM(ROUND(CASE WHEN d.type='percent' THEN COALESCE(i.subtotal,0)*LEAST(100,GREATEST(0,d.value))/100 ELSE GREATEST(0,d.value) END,2)),0)) AS amount
  FROM discounts d JOIN item_totals i ON i.order_id=d.order_id WHERE d.status='approved' GROUP BY d.order_id,i.subtotal
), latest_promotions AS (
  SELECT DISTINCT ON (venue_id,promotion_id) * FROM loyalty_promotions ORDER BY venue_id,promotion_id,version DESC
), promotion_basis AS (
  SELECT o.id AS order_id,p.venue_id,p.promotion_id,p.priority,p.benefit_kind,p.benefit_value,
    COALESCE(SUM(oi.quantity*oi.unit_price),0) AS basis
  FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products pr ON pr.id=oi.product_id AND pr.venue_id=o.venue_id AND pr.is_active=true
  JOIN latest_promotions p ON p.venue_id=o.venue_id AND p.status='active' AND p.starts_at<=now() AND now()<p.ends_at
    AND o.status NOT IN ('closed','cancelled') AND o.pricing_locked_at IS NULL
  WHERE EXISTS (SELECT 1 FROM loyalty_promotion_scopes s WHERE s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version AND ((s.scope_kind='include_product' AND s.product_id=oi.product_id) OR (s.scope_kind='include_category' AND s.category_name=pr.category)))
    AND NOT EXISTS (SELECT 1 FROM loyalty_promotion_scopes s WHERE s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version AND ((s.scope_kind='exclude_product' AND s.product_id=oi.product_id) OR (s.scope_kind='exclude_category' AND s.category_name=pr.category)))
  GROUP BY o.id,p.venue_id,p.promotion_id,p.priority,p.benefit_kind,p.benefit_value
), promotion_totals AS (
  SELECT DISTINCT ON (order_id) order_id,priority,amount FROM (
    SELECT order_id,promotion_id,priority,LEAST(basis,CASE WHEN benefit_kind='percent' THEN ROUND(basis*benefit_value/100,2) ELSE benefit_value END) AS amount
    FROM promotion_basis WHERE basis>0
  ) x ORDER BY order_id,amount DESC,priority DESC,promotion_id
), discount_candidates AS (
  SELECT o.id AS order_id,COALESCE(m.amount,0) AS amount,1 AS source_rank,0 AS priority,'manual'::text AS source
  FROM orders o LEFT JOIN manual_totals m ON m.order_id=o.id
  UNION ALL
  SELECT o.id,ROUND(COALESCE(i.subtotal,0)*COALESCE(o.group_discount_percent,0)/100,2),2,0,'guest_group'::text
  FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id
  UNION ALL
  SELECT o.id,pt.amount,3,pt.priority,'promotion'::text
  FROM orders o JOIN promotion_totals pt ON pt.order_id=o.id
), best_discounts AS (
  SELECT DISTINCT ON (order_id) order_id,amount FROM discount_candidates ORDER BY order_id,amount DESC,source_rank DESC,priority DESC
), discount_totals AS (
  SELECT o.id AS order_id,
    CASE WHEN c.discount IS NOT NULL THEN c.discount WHEN (o.status='closed' OR o.pricing_locked_at IS NOT NULL) AND o.pricing_version IS NOT NULL AND o.discount_total_snapshot IS NOT NULL THEN o.discount_total_snapshot
    ELSE LEAST(COALESCE(i.subtotal,0),COALESCE(b.amount,0)) END AS discount
  FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN best_discounts b ON b.order_id=o.id LEFT JOIN canonical_totals c ON c.order_id=o.id AND c.venue_id=o.venue_id
)`;

module.exports = { orderPricingSqlCtes };
