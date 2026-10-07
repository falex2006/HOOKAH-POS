ALTER TABLE inventory_recipe_cards
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS inventory_recipe_cards_venue_category_name_idx
  ON inventory_recipe_cards (venue_id, lower(btrim(category)), lower(btrim(name)))
  WHERE active=true;
