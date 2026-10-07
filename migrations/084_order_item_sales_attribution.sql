ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS sales_employee_id uuid,
  ADD COLUMN IF NOT EXISTS sold_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_sales_employee_fk' AND conrelid='order_items'::regclass) THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_sales_employee_fk
      FOREIGN KEY (sales_employee_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_sales_attribution_pair_check' AND conrelid='order_items'::regclass) THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_sales_attribution_pair_check
      CHECK ((sales_employee_id IS NULL AND sold_at IS NULL) OR (sales_employee_id IS NOT NULL AND sold_at IS NOT NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_order_item_sales_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_venue_id uuid; order_organization_id uuid; employee_venue_id uuid; employee_organization_id uuid;
BEGIN
  IF NEW.sales_employee_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.venue_id,v.organization_id INTO order_venue_id,order_organization_id
    FROM orders o JOIN venues v ON v.id=o.venue_id WHERE o.id=NEW.order_id;
  SELECT u.venue_id,u.organization_id INTO employee_venue_id,employee_organization_id
    FROM users u WHERE u.id=NEW.sales_employee_id AND u.is_active=true AND u.deleted_at IS NULL;
  IF order_venue_id IS NULL OR employee_venue_id IS NULL
      OR (employee_venue_id IS DISTINCT FROM order_venue_id
        AND (order_organization_id IS NULL OR (employee_organization_id IS DISTINCT FROM order_organization_id
          AND NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=order_organization_id AND m.user_id=NEW.sales_employee_id AND m.status='active')))) THEN
    RAISE EXCEPTION 'order_item_sales_employee_venue_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_items_sales_attribution_validate ON order_items;
CREATE TRIGGER order_items_sales_attribution_validate
  BEFORE INSERT OR UPDATE OF order_id,sales_employee_id,sold_at ON order_items
  FOR EACH ROW EXECUTE FUNCTION validate_order_item_sales_attribution();
