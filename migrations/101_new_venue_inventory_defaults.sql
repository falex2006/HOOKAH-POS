-- New venues start with the two common inventory departments and no categories.
-- Existing venues are intentionally untouched; their data needs a separate audit.
CREATE OR REPLACE FUNCTION seed_minimal_inventory_departments()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO inventory_departments (venue_id, code, name, description, color, sort_order)
  VALUES
    (NEW.id, 'bar', 'Бар', 'Напитки, сиропы и чай', 'amber', 20),
    (NEW.id, 'hookah', 'Кальяны', 'Табак, уголь и расходники', 'violet', 30)
  ON CONFLICT (venue_id, code) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_seed_inventory_departments ON venues;
CREATE TRIGGER venues_seed_inventory_departments
AFTER INSERT ON venues
FOR EACH ROW
EXECUTE FUNCTION seed_minimal_inventory_departments();

-- Category templates remain available through the existing explicit seed
-- function, but are no longer applied automatically when a venue is created.
DROP TRIGGER IF EXISTS venues_seed_inventory_category_defaults ON venues;
